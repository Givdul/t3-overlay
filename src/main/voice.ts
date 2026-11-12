import type { T3Server } from "./t3";

// T3's streaming dictation (apps/server/src/speech/stream.ts): one websocket per recording, a JSON
// `start`, raw 16 kHz mono Float32 chunks, then `finish`. The media ticket comes from the same auth
// endpoint the page socket uses, and only main ever sees it.

export type VoiceEvent = { kind: "text"; committed: string; tentative: string } | { kind: "error"; message: string };

export interface VoiceOptions {
  server: T3Server;
  token: string;
  onEvent: (event: VoiceEvent) => void;
}

export interface VoiceStream {
  /** Opens the stream and waits for the server's `ready` before audio may be fed. */
  start(): Promise<void>;
  feed(pcm: ArrayBuffer): void;
  finish(): Promise<string>;
  cancel(): void;
}

interface SpeechOptions {
  speechLanguage: string;
  speechTranslateToEnglish: boolean;
  speechCustomWords: string[];
  speechRemoveFillerWords: boolean;
  speechSilenceFiltering: boolean;
}

/** T3's defaults (packages/contracts/src/speech.ts, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS). */
const OPTIONS: SpeechOptions = {
  speechLanguage: "auto",
  speechTranslateToEnglish: false,
  speechCustomWords: [],
  speechRemoveFillerWords: true,
  speechSilenceFiltering: true,
};

const READY_TIMEOUT_MS = 30_000;

// T3's sending rules: 64 KB chunks, two in flight, and five minutes of audio in total
// (packages/contracts/src/speech.ts; client-runtime/src/voice-input/stream.ts).
const MAX_CHUNK_BYTES = 16_000 * 4;
const MAX_QUEUED_BYTES = MAX_CHUNK_BYTES * 5 * 60;
const MAX_IN_FLIGHT = 2;

// The server answers within this window, or the stream is dead.
const DEADLINE_MS = 120_000;

interface StatusReply {
  supported?: boolean;
  reason?: string;
  state?: string;
}

/** The four frames the stream answers with (contracts/speech.ts, SpeechStreamEvent). */
type StreamEvent =
  | { type: "ready" }
  | { type: "update"; revision?: number; text: { committed?: string; tentative?: string } | null }
  | { type: "finished"; text: string }
  | { type: "error"; message?: string };

export function startVoice(options: VoiceOptions): VoiceStream {
  let socket: WebSocket | null = null;
  let ready = false;
  let failure: Error | null = null;
  let finishSent = false;
  let finishing = false;
  let cancelled = false;
  let resolveFinal: ((text: string) => void) | null = null;
  let rejectFinal: ((error: Error) => void) | null = null;
  let timer: NodeJS.Timeout | undefined;
  /** Audio the server has not taken yet, split into chunks it accepts. */
  const queue: Uint8Array<ArrayBuffer>[] = [];
  let queuedBytes = 0;
  /** Byte counts of the chunks the server has not acknowledged with an `update` yet. */
  const inFlight: number[] = [];
  let inFlightBytes = 0;

  const final = new Promise<string>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });

  // A cancelled or failed recording can precede the caller awaiting `finish`.
  void final.catch(() => undefined);

  function armTimeout(ms: number, message: string) {
    clearTimeout(timer);
    timer = setTimeout(() => fail(new Error(message)), ms);
  }

  function close() {
    clearTimeout(timer);
    socket?.close();
    socket = null;
  }

  function fail(error: Error) {
    if (cancelled) return;
    cancelled = true;
    failure = error;
    close();
    readyRejector?.(error);
    options.onEvent({ kind: "error", message: error.message });
    rejectFinal?.(error);
  }

  function send(frame: string | Uint8Array<ArrayBuffer>) {
    if (socket === null || cancelled) return;

    try {
      socket.send(frame);
    } catch {
      fail(new Error("Could not send to voice transcription."));
    }
  }

  /** Sends what the server's window has room for; `finish` leaves only once every byte has landed. */
  function pump() {
    if (!ready || cancelled || finishSent) return;

    while (!cancelled && inFlight.length < MAX_IN_FLIGHT && queue.length > 0) {
      const chunk = queue.shift()!;

      inFlight.push(chunk.byteLength);
      inFlightBytes += chunk.byteLength;
      queuedBytes -= chunk.byteLength;
      armTimeout(DEADLINE_MS, "Live transcription stopped responding.");
      send(chunk);
    }

    if (!cancelled && finishing && queue.length === 0 && inFlight.length === 0) {
      finishSent = true;
      armTimeout(DEADLINE_MS, "Live transcription stopped responding.");
      send(JSON.stringify({ type: "finish" }));
    }
  }

  const cancelledError = () => new Error("Voice input was cancelled.");

  async function start(): Promise<void> {
    await assertReady(options);

    // A cancel during any await closes what this start has opened and rejects the IPC call, so the
    // renderer is never left waiting on a microphone main has already let go.
    if (cancelled) throw cancelledError();
    const ticket = await mediaTicket(options);

    if (cancelled) throw cancelledError();
    const url = new URL("/ws/voice", options.server.origin.replace(/^http/, "ws"));

    url.searchParams.set("wsTicket", ticket);
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    armTimeout(READY_TIMEOUT_MS, "Voice transcription did not start.");

    const opening = socket;

    socket.addEventListener("message", (event) => onMessage(String(event.data)));
    socket.addEventListener("error", () => fail(new Error("Could not reach live transcription.")));
    socket.addEventListener("close", () => {
      if (!cancelled && !finishSent) fail(new Error("The voice connection closed. Please record again."));
    });

    await new Promise<void>((resolve, reject) => {
      opening.addEventListener("open", () => resolve(), { once: true });
      opening.addEventListener("error", () => reject(new Error("Could not open the voice stream.")), { once: true });
      // A cancel closes the socket before it opens; the open event would never come.
      opening.addEventListener("close", () => reject(cancelledError()), { once: true });
    });

    if (cancelled) throw cancelledError();
    send(JSON.stringify({ type: "start", options: OPTIONS }));

    // `ready` clears the start timeout.
    await waitReady();

    if (cancelled) throw cancelledError();
  }

  let readyResolver: (() => void) | null = null;
  let readyRejector: ((error: Error) => void) | null = null;
  let readyPromise: Promise<void> | null = null;

  function waitReady() {
    if (ready) return Promise.resolve();

    if (failure !== null) return Promise.reject(failure);

    readyPromise ??= new Promise<void>((resolve, reject) => {
      readyResolver = resolve;
      readyRejector = reject;
    });

    return readyPromise;
  }

  function onMessage(raw: string) {
    let event: StreamEvent;

    try {
      // SAFETY: the server's speech stream writes exactly SpeechStreamEvent JSON (contracts/speech.ts).
      event = JSON.parse(raw) as StreamEvent;
    } catch {
      fail(new Error("T3 sent an unreadable voice message."));

      return;
    }

    switch (event.type) {
      case "ready":
        ready = true;
        clearTimeout(timer);
        readyResolver?.();
        pump();

        return;
      case "update":
        // T3 acknowledges one chunk per update; that is the stream's send window.
        if (inFlight.length > 0) {
          inFlightBytes -= inFlight.shift()!;

          if (inFlight.length > 0) armTimeout(DEADLINE_MS, "Live transcription stopped responding.");
          else clearTimeout(timer);
        }

        pump();

        if (event.text === null) return;

        options.onEvent({
          kind: "text",
          committed: event.text.committed ?? "",
          tentative: event.text.tentative ?? "",
        });

        return;
      case "finished":
        clearTimeout(timer);
        cancelled = true;
        close();
        resolveFinal?.(event.text);

        return;
      case "error":
        fail(new Error(event.message ?? "Live transcription failed. Please try recording again."));

        return;
      default:
        fail(new Error("T3 sent an unknown voice message."));
    }
  }

  return {
    start,
    feed(pcm) {
      if (cancelled || finishing) return;
      const bytes = new Uint8Array(pcm);

      // The cap counts every byte the server has not heard yet, as T3's own client does.
      if (queuedBytes + inFlightBytes + bytes.byteLength > MAX_QUEUED_BYTES) {
        fail(new Error("Voice recordings are limited to five minutes."));

        return;
      }

      for (let offset = 0; offset < bytes.byteLength; ) {
        const tail = queue.at(-1);
        const room = tail === undefined ? 0 : MAX_CHUNK_BYTES - tail.byteLength;

        if (tail !== undefined && room > 0) {
          const appended = Math.min(room, bytes.byteLength - offset);
          const merged = new Uint8Array(tail.byteLength + appended);

          merged.set(tail);
          merged.set(bytes.subarray(offset, offset + appended), tail.byteLength);
          queue[queue.length - 1] = merged;
          queuedBytes += appended;
          offset += appended;

          continue;
        }

        const chunk = bytes.slice(offset, offset + MAX_CHUNK_BYTES);

        queue.push(chunk);
        queuedBytes += chunk.byteLength;
        offset += chunk.byteLength;
      }

      pump();
    },
    finish() {
      if (!cancelled && !finishing) {
        finishing = true;
        pump();
      }

      return final;
    },
    cancel() {
      cancelled = true;
      clearTimeout(timer);
      readyRejector?.(new Error("Voice input was cancelled."));
      close();
    },
  };
}

/** A missing model is T3's to fix; the overlay only says so. */
async function assertReady(options: VoiceOptions) {
  const response = await fetch(`${options.server.origin}/api/voice/status`, {
    headers: { authorization: `Bearer ${options.token}` },
  });

  if (!response.ok) throw new Error(`Voice status failed: ${response.status}`);

  // SAFETY: /api/voice/status answers EnvironmentSpeechStatus; only the fields read here are typed.
  const status = (await response.json()) as StatusReply;

  if (status.supported === false) throw new Error(status.reason ?? "Voice input is not available on this machine.");

  if (status.state === "missing-model") throw new Error("Voice input needs a speech model. Set it up in T3 Code, then try again.");

  if (status.state !== "ready" && status.state !== "transcribing") throw new Error("Voice input is not ready on this machine.");
}

async function mediaTicket(options: VoiceOptions): Promise<string> {
  const response = await fetch(`${options.server.origin}/api/auth/websocket-ticket/media`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.token}` },
  });

  if (!response.ok) throw new Error(`Voice ticket failed: ${response.status}`);

  // SAFETY: the ticket endpoint answers AuthWebSocketTicketResult, which always carries a ticket string.
  const body = (await response.json()) as { ticket?: string };

  if (body.ticket === undefined || body.ticket === "") throw new Error("T3 sent no voice ticket");

  return body.ticket;
}
