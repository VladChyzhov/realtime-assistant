// playground/capture-electron-win/pcm-worklet.js
// Ресемплер 48k → 16k, моно, выдаёт 20мс фреймы (320 сэмплов = 640 байт Int16 LE).

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();

    this.targetRate = 16000;                 // целевая частота
    this.srcRate    = sampleRate;            // частота контекста (обычно 48000)
    this.ratio      = Math.round(this.srcRate / this.targetRate); // ожидаем 3:1
    this.frameMs    = 20;
    this.outSamples = (this.targetRate * this.frameMs / 1000) | 0; // 320
    this.inSamples  = this.outSamples * this.ratio;                 // 960 @ 48k
    this.buffer48k  = new Float32Array(0);   // ⚠️ Храним ТОЛЬКО 48кГц вход!

    this._sent = 0;
    console.log(`[AudioWorklet] init: ${this.srcRate}Hz → ${this.targetRate}Hz, ratio=${this.ratio}, frame=${this.outSamples} samples`);
  }

  _append48k(mono) {
    const a = this.buffer48k;
    const out = new Float32Array(a.length + mono.length);
    out.set(a, 0);
    out.set(mono, a.length);
    this.buffer48k = out;
  }

  _emitFrame320(resampledF32) {
    // float [-1..1] → Int16 LE
    const outI16 = new Int16Array(resampledF32.length);
    for (let i = 0; i < resampledF32.length; i++) {
      let s = resampledF32[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      outI16[i] = (s < 0 ? s * 0x8000 : s * 0x7FFF) | 0;
    }
    const ab = outI16.buffer.slice(0);
    this.port.postMessage(ab, [ab]); // transfer ownership
    this._sent++;
    if (this._sent <= 10) console.log(`[WORKLET] Sent frame #${this._sent} (${outI16.byteLength} bytes)`);
  }

  process(inputs/*, outputs, parameters */) {
    const input = inputs[0] || [];
    if (!input.length) return true;

    // Берём 2 канала, если есть, и усредняем в моно
    const ch0 = input[0] || new Float32Array(0);
    const ch1 = input[1];
    let mono;
    if (ch1 && ch1.length === ch0.length) {
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
    } else {
      mono = ch0;
    }
    if (!mono.length) return true;
    
    console.log(`[WORKLET.process] Input mono.length: ${mono.length}`);
    this._append48k(mono);
    console.log(`[WORKLET.process] buffer48k.length after append: ${this.buffer48k.length}, inSamples for chunk: ${this.inSamples}`);

    // Пока хватает входа на один кадр 20мс — генерим выход
    while (this.buffer48k.length >= this.inSamples) {
      // Берём первые 960 входных сэмплов @48k
      const src = this.buffer48k.subarray(0, this.inSamples);
      console.log(`[WORKLET.process] Processing src.length: ${src.length}`);

      // Простейший «антиалиас» перед децимацией: бокс-фильтр группы по ratio (3)
      // Т.е. усредняем каждые 3 входных сэмпла → 1 выходной @16k
      const outF32 = new Float32Array(this.outSamples);
      let dst = 0;
      for (let i = 0; i < this.inSamples; i += this.ratio) {
        let sum = 0;
        for (let k = 0; k < this.ratio; k++) sum += src[i + k];
        outF32[dst++] = sum / this.ratio;
      }
      console.log(`[WORKLET.process] Generated outF32.length: ${outF32.length}`);

      // Сдвигаем буфер 48к на оставшуюся часть
      const remain = this.buffer48k.length - this.inSamples;
      if (remain > 0) {
        const rest = new Float32Array(remain);
        rest.set(this.buffer48k.subarray(this.inSamples));
        this.buffer48k = rest;
      } else {
        this.buffer48k = new Float32Array(0);
      }
      console.log(`[WORKLET.process] buffer48k.length after shift: ${this.buffer48k.length}`);

      // Отправляем готовый 20мс кадр (320 сэмплов → 640 байт)
      this._emitFrame320(outF32);
    }

    return true; // продолжать обрабатывать
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
