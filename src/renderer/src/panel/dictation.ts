// Microphone capture for dictation: getUserMedia → an AudioWorklet that mixes to mono and resamples to
// the 16 kHz Float32 T3's speech stream takes. Ported from apps/web/src/speech/{pcmWorklet,pcmResampler}.ts.

export interface PcmRecording {
  stop(): Promise<void>;
}

/** The worklet's source is one string: no bundler entry, no separate file served to the page. */
const WORKLET = String.raw`
const TARGET_RATE = 16000;
class PcmResampler {
  constructor(sampleRate) {
    this.ratio = sampleRate / TARGET_RATE;
    this.coefficients = new Float64Array(sampleRate === TARGET_RATE ? 1 : 63);
    this.history = new Float32Array(this.coefficients.length);
    this.position = 0;
    this.phase = 0;
    const middle = (this.coefficients.length - 1) / 2;
    const cutoff = 7200 / sampleRate;
    let sum = 0;
    for (let i = 0; i < this.coefficients.length; i++) {
      const x = i - middle;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = middle === 0 ? 1 : 0.54 - 0.46 * Math.cos((Math.PI * i) / middle);
      this.coefficients[i] = sinc * window;
      sum += this.coefficients[i];
    }
    for (let i = 0; i < this.coefficients.length; i++) this.coefficients[i] /= sum;
  }
  push(samples) {
    const output = [];
    for (const sample of samples) {
      this.history[this.position] = sample;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let value = 0;
        for (let tap = 0; tap < this.coefficients.length; tap++) {
          const index = (this.position - tap + this.history.length) % this.history.length;
          value += this.history[index] * this.coefficients[tap];
        }
        output.push(Math.max(-1, Math.min(1, value)));
      }
      this.position = (this.position + 1) % this.history.length;
    }
    return Float32Array.from(output);
  }
}
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new PcmResampler(sampleRate);
    this.chunk = new Float32Array(8000);
    this.length = 0;
  }
  publish() {
    const pcm = this.chunk.slice(0, this.length);
    this.port.postMessage(pcm, [pcm.buffer]);
    this.length = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels[0]) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
    for (const sample of this.resampler.push(mono)) {
      this.chunk[this.length++] = sample;
      if (this.length === this.chunk.length) this.publish();
    }
    return true;
  }
}
registerProcessor("t3-overlay-pcm", PcmCaptureProcessor);
`;

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
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));

  try {
    await context.audioWorklet.addModule(url);
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
    URL.revokeObjectURL(url);
    stream.getTracks().forEach((track) => track.stop());
    void context.close();

    throw new Error(microphoneError(error instanceof Error ? error : new Error(String(error))));
  }

  return {
    async stop() {
      node?.disconnect();
      node?.port.close();
      stream.getTracks().forEach((track) => track.stop());
      URL.revokeObjectURL(url);
      await context.close();
    },
  };
}
