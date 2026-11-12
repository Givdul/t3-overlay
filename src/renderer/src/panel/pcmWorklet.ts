// Dictation's capture worklet: mixes to mono and resamples to the 16 kHz Float32 T3's speech stream
// takes. dictation.ts loads this file by URL, so Vite emits it as an asset of the app's own origin and
// the page's `script-src 'self'` allows it without a `blob:` script.
// Ported from apps/web/src/speech/{pcmWorklet,pcmResampler}.ts.

declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

const TARGET_RATE = 16000;

class PcmResampler {
  private readonly ratio: number;
  private readonly coefficients: Float64Array;
  private readonly history: Float32Array;
  private position = 0;
  private phase = 0;

  constructor(rate: number) {
    this.ratio = rate / TARGET_RATE;
    this.coefficients = new Float64Array(rate === TARGET_RATE ? 1 : 63);
    this.history = new Float32Array(this.coefficients.length);
    const middle = (this.coefficients.length - 1) / 2;
    const cutoff = 7200 / rate;
    let sum = 0;

    for (let i = 0; i < this.coefficients.length; i += 1) {
      const x = i - middle;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = middle === 0 ? 1 : 0.54 - 0.46 * Math.cos((Math.PI * i) / middle);

      this.coefficients[i] = sinc * window;
      sum += this.coefficients[i]!;
    }

    for (let i = 0; i < this.coefficients.length; i += 1) this.coefficients[i] = this.coefficients[i]! / sum;
  }

  push(samples: Float32Array): Float32Array {
    const output: number[] = [];

    for (const sample of samples) {
      this.history[this.position] = sample;
      this.phase += 1;

      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        let value = 0;

        for (let tap = 0; tap < this.coefficients.length; tap += 1) {
          const index = (this.position - tap + this.history.length) % this.history.length;

          value += this.history[index]! * this.coefficients[tap]!;
        }

        output.push(Math.max(-1, Math.min(1, value)));
      }

      this.position = (this.position + 1) % this.history.length;
    }

    return Float32Array.from(output);
  }
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new PcmResampler(sampleRate);
  private readonly chunk = new Float32Array(8000);
  private length = 0;

  private publish() {
    const pcm = this.chunk.slice(0, this.length);

    this.port.postMessage(pcm, [pcm.buffer]);
    this.length = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];

    if (channels === undefined || channels[0] === undefined) return true;
    const mono = new Float32Array(channels[0].length);

    for (const channel of channels) for (let i = 0; i < mono.length; i += 1) mono[i] = mono[i]! + channel[i]! / channels.length;

    for (const sample of this.resampler.push(mono)) {
      this.chunk[this.length] = sample;
      this.length += 1;

      if (this.length === this.chunk.length) this.publish();
    }

    return true;
  }
}

registerProcessor("t3-overlay-pcm", PcmCaptureProcessor);
