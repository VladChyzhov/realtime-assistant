// AudioWorklet: моно + resample 48k→16k + 20мс чанки Int16 без transfer-list.
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.chunkMs = 20;
    this.chunkSamples = (this.targetRate * this.chunkMs) / 1000 | 0; // 320
    this._accum = [];
    this._residual = 0;
    this._srcRate = sampleRate;
    this._ratio = this._srcRate / this.targetRate;
  }

  _resampleTo16k(floatMono) {
    const outLength = Math.floor((floatMono.length + this._residual) / this._ratio);
    if (outLength <= 0) return new Float32Array(0);
    const out = new Float32Array(outLength);
    let pos = this._residual;
    for (let i = 0; i < outLength; i++) {
      const idx = pos | 0, frac = pos - idx;
      const s0 = floatMono[idx] || 0, s1 = floatMono[idx + 1] || s0;
      out[i] = s0 + (s1 - s0) * frac;
      pos += this._ratio;
    }
    this._residual = pos - (floatMono.length | 0);
    return out;
  }

  _floatToInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      let s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const ch0 = input[0] || new Float32Array(128);
    const ch1 = input[1];
    const mono = new Float32Array(ch0.length);
    if (ch1) { for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5; }
    else mono.set(ch0);

    // простая телеметрия — видно, что есть звук
    const maxAmp = mono.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    if (maxAmp > 0.0008) this.port.postMessage({ _debug: 'amp', v: maxAmp });

    this._accum.push(mono);

    const accumLen = this._accum.reduce((s, a) => s + a.length, 0);
    if (accumLen >= 1024) {
      const big = new Float32Array(accumLen);
      let off = 0; for (const a of this._accum) { big.set(a, off); off += a.length; }
      this._accum.length = 0;

      const resampled = this._resampleTo16k(big);
      for (let i = 0; i + this.chunkSamples <= resampled.length; i += this.chunkSamples) {
        const slice = resampled.subarray(i, i + this.chunkSamples);
        const pcm16 = this._floatToInt16(slice);

        // ❗ Формируем явный LE-буфер (надёжно для любых платформ)
        const bytes = new ArrayBuffer(pcm16.length * 2);
        const dv = new DataView(bytes);
        for (let j = 0; j < pcm16.length; j++) dv.setInt16(j * 2, pcm16[j], true);
        this.port.postMessage(bytes);
      }

      const remain = resampled.length % this.chunkSamples;
      if (remain > 0) this._accum.push(resampled.subarray(resampled.length - remain));
    }

    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsampler);