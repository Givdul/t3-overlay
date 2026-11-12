// Microphone capture for dictation: getUserMedia → an AudioWorklet that mixes to mono and resamples to
// the 16 kHz Float32 T3's speech stream takes. Ported from apps/web/src/speech/{pcmWorklet,pcmResampler}.ts.

import workletUrl from "./pcmWorklet?worker&url";

export interface PcmRecording {
  stop(): Promise<void>;
}

export function microphoneError(cause: Error): string {
  if (cause.name === "NotAllowedError" || cause.name === "SecurityError") {
    return "Microphone access is off. Allow t3-overlay in System Settings → Privacy & Security → Microphone.";
  }

  if (cause.name === "NotFoundError" || cause.name === "OverconstrainedError") return "No microphone was found.";

  if (cause.name === "NotReadableError") return "The microphone is in use by another app.";

  return "Could not start the microphone.";
}

/** Opens the microphone and feeds 16 kHz mono chunks until `stop`. Throws a readable message on failure. */
export async function startPcmRecording(onChunk: (pcm: ArrayBuffer) => void): Promise<PcmRecording> {
  let stream: MediaStream;

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    throw new Error(microphoneError(error instanceof Error ? error : new Error(String(error))));
  }

  const context = new AudioContext();
  let node: AudioWorkletNode | null = null;

  try {
    // The worklet is an asset of the app's own origin (Vite emits it), so the page's `script-src 'self'`
    // allows it; a blob: URL would be refused and the microphone would never record.
    await context.audioWorklet.addModule(workletUrl);
    node = new AudioWorkletNode(context, "t3-overlay-pcm", { channelCount: 1 });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const pcm = event.data;
      // A copy of exactly these samples: the worklet's buffer is transferred and reused.
      const copy = new Uint8Array(pcm.byteLength);

      copy.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      onChunk(copy.buffer);
    };

    context.createMediaStreamSource(stream).connect(node);
    // The processor emits silence, keeping the graph running without playing the microphone back.
    node.connect(context.destination);
    await context.resume();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    void context.close();

    throw new Error(microphoneError(error instanceof Error ? error : new Error(String(error))));
  }

  return {
    async stop() {
      node?.disconnect();
      node?.port.close();
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
    },
  };
}
