import type { PanelReply, PanelVoiceReply } from "../shared/panel";
import { AuthExpiredError } from "./rpc";
import type { T3Server } from "./t3";

// T3 transcribes recordings itself, so the panel never needs a speech model of its own. These are the
// two routes T3's web composer uses against a local server (packages/contracts/src/environmentHttp.ts,
// the "voice" group; packages/client-runtime/src/voice-input/environment.ts,
// getEnvironmentSpeechStatus and transcribeEnvironmentPcm). The stream route needs an audio worklet
// feeding 16 kHz chunks; the panel sends one finished recording instead, which is the same request
// T3's client makes for a model that cannot stream.
//
// Wire types below are the slices of T3's contract this client reads. They are asserted once, where a
// response arrives, so the messages below branch on decoded fields instead of re-probing JSON.

/** The status route's reply (packages/contracts/src/speech.ts, EnvironmentSpeechStatus). */
interface WireSpeechStatus {
  supported?: boolean;
  /** Why this machine cannot transcribe at all. */
  reason?: string;
  state?: string;
}

/** A refused request (packages/contracts/src/environmentHttp.ts, EnvironmentRequestInvalidError). */
interface WireRequestError {
  reason?: string;
}

/** The transcript (packages/contracts/src/speech.ts, EnvironmentSpeechTranscriptionResult). */
interface WireTranscription {
  text?: string;
}

/** T3's defaults for a recording (packages/contracts/src/speech.ts, DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS). */
const TRANSCRIPTION_OPTIONS = {
  speechLanguage: "auto",
  speechTranslateToEnglish: false,
  speechCustomWords: [],
  speechRemoveFillerWords: true,
  speechSilenceFiltering: true,
};

/** T3's sample format: 16 kHz mono float32 (apps/web/src/speech/pcmWorklet.ts). */
const BYTES_PER_SAMPLE = 4;

/** T3's own recording limit, which its models accept (apps/server/src/speech/SpeechService.ts, MAX_SPEECH_BYTES). */
const MAX_PCM_BYTES = 16_000 * BYTES_PER_SAMPLE * 5 * 60;

/** T3's wording, as its controller and error pill say it (packages/client-runtime/src/voice-input/controller.ts). */
const NOT_AVAILABLE = "Voice transcription is not available.";
const COULD_NOT_TRANSCRIBE = "Could not transcribe this recording.";
const BUSY = "Voice transcription is still finishing. Try again shortly.";

/**
 * T3's own answer to a missing model is its setup wizard, "Set up voice input", whose description is
 * "Download a speech model once." The panel has no settings to send the reader to, so it says where
 * that setup lives.
 */
const MISSING_MODEL = "Voice input needs a speech model. Set it up in T3 under Settings → Voice.";

/** What a refused transcription means here (apps/server/src/speech/http.ts, mapSpeechError). */
function reasonMessage(reason: string | undefined): string {
  switch (reason) {
    case "speech_unavailable":
      return NOT_AVAILABLE;
    case "speech_busy":
      return BUSY;
    // The only speech failure on this route that reports `invalid_command` is a model that is not there.
    case "invalid_command":
      return MISSING_MODEL;
    default:
      return COULD_NOT_TRANSCRIBE;
  }
}

/** One request to the server that holds the models; the token never leaves this process. */
async function post(server: T3Server, token: string, path: string, body?: Uint8Array<ArrayBuffer>) {
  const headers = new Headers({ authorization: `Bearer ${token}` });

  if (body !== undefined) headers.set("content-type", "application/octet-stream");

  const response = await fetch(new URL(path, server.origin), {
    method: body === undefined ? "GET" : "POST",
    headers,
    body,
    // Audio and credentials never follow a redirect to another host.
    redirect: "error",
  });

  // A rejected token is the same expiry the socket sees; the panel re-mints one instead of reporting it.
  if (response.status === 401) throw new AuthExpiredError("T3 rejected the overlay session");

  return response;
}

/**
 * Whether T3 would transcribe right now. Its client asks the same question before every recording, so a
 * model that was never downloaded is said before the reader talks instead of after.
 */
export async function voiceStatus(server: T3Server, token: string): Promise<PanelReply> {
  try {
    const response = await post(server, token, "/api/voice/status");

    if (!response.ok) return { ok: false, error: NOT_AVAILABLE };

    // SAFETY: `/api/voice/status` answers with EnvironmentSpeechStatus; this client reads its fields loosely.
    const status = (await response.json()) as WireSpeechStatus;

    // The route answers either "supported: false" with its reason, or a model's state.
    if (status.supported !== true) return { ok: false, error: status.reason?.trim() || NOT_AVAILABLE };

    if (status.state === "missing-model") return { ok: false, error: MISSING_MODEL };

    return { ok: true };
  } catch (error) {
    // An expired session goes up to the panel, which re-mints one; only a real failure is hidden.
    if (error instanceof AuthExpiredError) throw error;

    return { ok: false, error: NOT_AVAILABLE };
  }
}

/**
 * T3's binary audio request: a four-byte JSON length, the recognition options, then the PCM samples
 * (packages/shared/src/speech.ts, encodeSpeechPcmRequest).
 */
function encodePcm(pcm: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const options = new TextEncoder().encode(JSON.stringify(TRANSCRIPTION_OPTIONS));
  const body = new Uint8Array(4 + options.byteLength + pcm.byteLength);
  new DataView(body.buffer).setUint32(0, options.byteLength, true);
  body.set(options, 4);
  body.set(new Uint8Array(pcm), 4 + options.byteLength);

  return body;
}

/** Sends one finished recording to T3's own model and returns what it heard. */
export async function transcribePcm(server: T3Server, token: string, pcm: ArrayBuffer): Promise<PanelVoiceReply> {
  if (pcm.byteLength === 0) return { ok: false, error: "No speech was detected." };

  if (pcm.byteLength % BYTES_PER_SAMPLE !== 0 || pcm.byteLength > MAX_PCM_BYTES) return { ok: false, error: COULD_NOT_TRANSCRIBE };

  try {
    const response = await post(server, token, "/api/voice/transcribe", encodePcm(pcm));

    if (!response.ok) {
      const error: WireRequestError = await response.json().catch(() => ({}));

      return { ok: false, error: reasonMessage(error.reason) };
    }

    // SAFETY: a 2xx from `/api/voice/transcribe` is EnvironmentSpeechTranscriptionResult.
    const transcription = (await response.json()) as WireTranscription;

    return { ok: true, text: transcription.text ?? "" };
  } catch (error) {
    // An expired session goes up to the panel, which re-mints one; only a real failure is hidden.
    if (error instanceof AuthExpiredError) throw error;

    return { ok: false, error: COULD_NOT_TRANSCRIBE };
  }
}
