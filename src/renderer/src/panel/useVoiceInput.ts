import { useEffect, useRef, useState } from "react";

// The composer's dictation: the microphone is captured here, and main posts the finished recording to
// T3's own transcription route, where the session token lives. T3's web composer records 16 kHz mono
// float32 PCM (apps/web/src/speech/pcmWorklet.ts) and posts one binary request whenever its model
// cannot stream (packages/client-runtime/src/voice-input/environment.ts, transcribeEnvironmentPcm).
// The phases and messages below follow T3's controller (packages/client-runtime/src/voice-input/
// controller.ts, VoiceInputPhase), so the panel says what T3 says.

const SAMPLE_RATE = 16_000;

/** T3's own recording limit (controller.ts, VOICE_RECORDING_LIMIT_SECONDS). */
const LIMIT_SECONDS = 5 * 60;

/**
 * T3's own cap on a recording (apps/server/src/speech/SpeechService.ts, MAX_SPEECH_BYTES: 16 kHz mono
 * float32 for the limit). Main refuses anything longer, so the encoder stops at exactly this many frames.
 */
const MAX_FRAMES = SAMPLE_RATE * LIMIT_SECONDS;

/** A refused microphone, in T3's words (controller.ts, MICROPHONE_PERMISSION_ERROR). */
const MICROPHONE_DENIED =
  "Microphone access is required for voice input. Allow access in your browser or system settings and try again.";

export type VoicePhase = "idle" | "preparing" | "recording" | "transcribing";

interface Options {
  /** The open thread, so a recording never lands in the next thread's composer. */
  threadKey: string;
  /** The server advertises transcription; false keeps the mic hidden and the hook idle. */
  enabled: boolean;
  /** The transcript, inserted at the composer's caret. */
  onTranscript(text: string): void;
  /** A short reason the recording produced no text; null clears the previous one. */
  onError(message: string | null): void;
  /** Told on every phase change, so the panel keeps the composer open while dictating. */
  onPhase(phase: VoicePhase): void;
}

export interface VoiceInput {
  phase: VoicePhase;
  /** Whole seconds recorded so far, for the recording state's timer. */
  seconds: number;
  /** The mic button: starts a recording, or finishes the one that is running. */
  toggle(): void;
}

/** One recording in progress, and the promise its bytes resolve through once the encoder flushed. */
interface Capture {
  recorder: MediaRecorder;
  stream: MediaStream;
  /** Null when the recorder failed instead of producing a file. */
  finished: Promise<Blob | null>;
  timer: ReturnType<typeof setInterval>;
}

export function useVoiceInput(options: Options): VoiceInput {
  const [phase, setPhaseState] = useState<VoicePhase>("idle");
  const [seconds, setSeconds] = useState(0);
  const current = useRef(options);
  current.current = options;
  const phaseRef = useRef<VoicePhase>("idle");
  const capture = useRef<Capture | null>(null);
  /** Bumped by a cancel, so work that was already in flight is dropped instead of committed. */
  const generation = useRef(0);

  const setPhase = (next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
    current.current.onPhase(next);
  };

  function fail(message: string) {
    setPhase("idle");
    setSeconds(0);
    current.current.onError(message);
  }

  /** A thread switch or a closed panel drops the recording, whose transcript has nowhere to land. */
  function cancel() {
    generation.current += 1;
    const active = capture.current;
    capture.current = null;

    if (active !== null) {
      clearInterval(active.timer);
      // The recorder is stopped without its callbacks: nothing is decoded or sent from here.
      active.recorder.onstop = null;
      active.recorder.onerror = null;

      if (active.recorder.state !== "inactive") active.recorder.stop();

      for (const track of active.stream.getTracks()) track.stop();
    }

    if (phaseRef.current !== "idle") setPhase("idle");
    setSeconds(0);
  }

  async function start() {
    if (phaseRef.current !== "idle" || !current.current.enabled) return;

    const started = generation.current + 1;
    generation.current = started;
    current.current.onError(null);
    setPhase("preparing");

    // T3 asks the same question before every recording, so a model that was never downloaded is said
    // before the reader talks instead of after.
    let status: { ok: true } | { ok: false; error: string };

    try {
      status = await window.overlay.panel({ type: "voiceStatus" });
    } catch (cause) {
      if (generation.current !== started) return;
      fail(cause instanceof Error ? cause.message : String(cause));

      return;
    }

    if (generation.current !== started) return;

    if (!status.ok) {
      fail(status.error);

      return;
    }

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (cause) {
      if (generation.current !== started) return;
      fail(cause instanceof DOMException && cause.name === "NotAllowedError" ? MICROPHONE_DENIED : "Could not start voice recording.");

      return;
    }

    // Cancelled while the permission prompt was up: a granted device is released, never recorded.
    if (generation.current !== started) {
      for (const track of stream.getTracks()) track.stop();

      return;
    }

    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    const startedAt = Date.now();

    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(elapsed);

      if (elapsed >= LIMIT_SECONDS) void finish();
    }, 250);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    const finished = new Promise<Blob | null>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
      recorder.onerror = () => resolve(null);
    });

    capture.current = { recorder, stream, finished, timer };
    recorder.start();
    setPhase("recording");
  }

  async function finish() {
    const active = capture.current;

    if (active === null || phaseRef.current !== "recording") return;

    const started = generation.current;
    capture.current = null;
    clearInterval(active.timer);
    setPhase("transcribing");

    let pcm: ArrayBuffer;

    try {
      active.recorder.stop();

      for (const track of active.stream.getTracks()) track.stop();

      const blob = await active.finished;

      if (blob === null) throw new Error("Could not finish voice recording.");

      pcm = await pcmOf(blob);
    } catch {
      if (generation.current === started) fail("Could not finish voice recording.");

      return;
    }

    if (generation.current !== started) return;

    // `transcribe` answers with text; the other replies belong to commands this one is not.
    let reply: { ok: true; text?: string } | { ok: false; error: string };

    try {
      reply = await window.overlay.panel({ type: "transcribe", pcm });
    } catch (cause) {
      reply = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }

    if (generation.current !== started) return;

    if (!reply.ok) {
      fail(reply.error);

      return;
    }

    const text = (reply.text ?? "").trim();

    if (text === "") {
      fail("No speech was detected.");

      return;
    }

    setPhase("idle");
    setSeconds(0);
    current.current.onTranscript(text);
  }

  function toggle() {
    if (phaseRef.current === "recording") void finish();
    else if (phaseRef.current === "idle") void start();
  }

  // The refs make this cleanup safe from an older render: it only reads what is still live.
  useEffect(() => cancel, [options.threadKey]);

  return { phase, seconds, toggle };
}

/**
 * The browser's recording decoded and resampled to T3's sample format. Decoding is the browser's own,
 * so no decoder ships for the few containers MediaRecorder produces.
 */
async function pcmOf(blob: Blob): Promise<ArrayBuffer> {
  const context = new AudioContext();

  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    // The recorder's own timer can hand over a few milliseconds past the limit; those samples would put
    // the request over the cap and lose the whole recording, so they are cut here instead.
    const frames = Math.min(Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE)), MAX_FRAMES);
    const resampler = new OfflineAudioContext(1, frames, SAMPLE_RATE);
    const source = resampler.createBufferSource();
    source.buffer = decoded;
    source.connect(resampler.destination);
    source.start();
    const rendered = await resampler.startRendering();
    const samples = new Float32Array(rendered.getChannelData(0));

    // Resampling can overshoot full scale, and T3's route refuses any sample outside -1…1.
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]!;
      samples[index] = Number.isFinite(sample) ? Math.min(1, Math.max(-1, sample)) : 0;
    }

    return samples.buffer;
  } finally {
    void context.close();
  }
}
