// Stream mono microphone audio as 20 ms G.711 mu-law frames at 8 kHz.
// Weighted averaging maintains phase across render blocks, including at 44.1 kHz.
class BrowserAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Uint8Array(160);
    this.index = 0;
    this.sum = 0;
    this.weight = 0;
    this.ratio = sampleRate / 8000;
  }
  encode(value) {
    let sample = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
    const sign = sample < 0 ? 128 : 0;
    sample = Math.min(Math.abs(sample), 32635) + 132;
    let exponent = 7;
    for (let mask = 16384; exponent > 0 && !(sample & mask); mask >>= 1) exponent--;
    return (~(sign | (exponent << 4) | ((sample >> (exponent + 3)) & 15))) & 255;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-8) {
          this.frame[this.index++] = this.encode(this.sum / this.weight);
          this.sum = 0;
          this.weight = 0;
          if (this.index === 160) {
            this.port.postMessage(this.frame, [this.frame.buffer]);
            this.frame = new Uint8Array(160);
            this.index = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('browser-audio', BrowserAudioProcessor);
