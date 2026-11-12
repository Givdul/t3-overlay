import { readFile } from "node:fs/promises";
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
  /** Opens the stream. `fixture` means main feeds a recorded clip instead of the microphone. */
  start(): Promise<{ fixture: boolean }>;
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

/** Same ceiling the server enforces on one binary frame. */
const CHUNK_BYTES = 16_000 * 4;

const READY_TIMEOUT_MS = 30_000;
const FINISH_TIMEOUT_MS = 120_000;

/** Raw Float32, 16 kHz mono: `say -o` → convert, then strip the container. Verification only. */
const FIXTURE_PATH = process.env.T3_OVERLAY_VOICE_FIXTURE;

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
  let cancelled = false;
  let resolveFinal: ((text: string) => void) | null = null;
  let rejectFinal: ((error: Error) => void) | null = null;
  let timer: NodeJS.Timeout | undefined;

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

  async function start(): Promise<{ fixture: boolean }> {
    await assertReady(options);
    const ticket = await mediaTicket(options);
    const url = new URL("/ws/voice", options.server.origin.replace(/^http/, "ws"));

    url.searchParams.set("wsTicket", ticket);
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    armTimeout(READY_TIMEOUT_MS, "Voice transcription did not start.");

    socket.addEventListener("message", (event) => onMessage(String(event.data)));
    socket.addEventListener("error", () => fail(new Error("Could not reach live transcription.")));
    socket.addEventListener("close", () => {
      if (!cancelled && !finishSent) fail(new Error("The voice connection closed. Please record again."));
    });

    await new Promise<void>((resolve, reject) => {
      socket?.addEventListener("open", () => resolve(), { once: true });
      socket?.addEventListener("error", () => reject(new Error("Could not open the voice stream.")), { once: true });
    });
    send(JSON.stringify({ type: "start", options: OPTIONS }));

    // `ready` clears the start timeout; until then a fixture must wait too.
    await waitReady();

    if (FIXTURE_PATH === undefined) return { fixture: false };

    void feedFixture();

    return { fixture: true };
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

  async function feedFixture() {
    try {
      const bytes = await readFile(FIXTURE_PATH!);

      // Paced so the live transcript has time to arrive, not real time: the clip is seconds long.
      for (let offset = 0; offset < bytes.byteLength && !cancelled && !finishSent; offset += CHUNK_BYTES) {
        const chunk = new Uint8Array(Math.min(CHUNK_BYTES, bytes.byteLength - offset));

        chunk.set(bytes.subarray(offset, offset + chunk.byteLength));
        send(chunk);
        await new Promise((resolve) => setTimeout(resolve, 40));
      }

      if (!cancelled && !finishSent) requestFinish();
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Could not read the voice fixture."));
    }
  }

  function requestFinish() {
    if (finishSent || cancelled) return;
    finishSent = true;
    armTimeout(FINISH_TIMEOUT_MS, "Live transcription stopped responding.");
    send(JSON.stringify({ type: "finish" }));
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

        return;
      case "update":
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
      if (!ready || finishSent || cancelled) return;
      send(new Uint8Array(pcm));
    },
    finish() {
      requestFinish();

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
