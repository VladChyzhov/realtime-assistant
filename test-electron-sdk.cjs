// test-electron-sdk.cjs
const fs = require("fs");
const path = require("path");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");

// 🔧 Настройки
const DG_KEY = process.env.DG_KEY || process.env.DEEPGRAM_API_KEY;
const wavPath = path.resolve(__dirname, "sample16k.wav");

if (!DG_KEY) {
  console.error("❌ Нет API ключа (DG_KEY)");
  process.exit(1);
}
if (!fs.existsSync(wavPath)) {
  console.error("❌ Файл не найден:", wavPath);
  process.exit(1);
}

// ---- найти начало PCM (data-чанк)
function findWavDataOffset(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Файл не WAV RIFF/WAVE");
  }
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (id === "data") return pos;
    pos += size;
  }
  throw new Error("data-чанк не найден");
}

// ---- подключение к Deepgram SDK
const dg = createClient(DG_KEY);
const conn = dg.listen.live({
  model: "nova-3",
  encoding: "linear16",
  sample_rate: 16000,
  language: "multi",
  interim_results: true,
  smart_format: true,
  vad_events: true,
  utterance_end_ms: 1200,
});

conn.on(LiveTranscriptionEvents.Open, () => {
  console.log("✅ WebSocket открыт");

  const wav = fs.readFileSync(wavPath);
  const offset = findWavDataOffset(wav);
  const pcmBuf = wav.subarray(offset);

  const duration = pcmBuf.length / (16000 * 2);
  console.log(`🔊 PCM: ${pcmBuf.length} байт (~${duration.toFixed(2)} сек)`);

  const frameBytes = 640;
  let off = 0;

  const ka = setInterval(() => {
    try { conn.send(JSON.stringify({ type: "KeepAlive" })); } catch {}
  }, 5000);

  (function pump() {
    if (off >= pcmBuf.length) {
      console.log("📦 Финализируем поток...");
      try { conn.finalize(); } catch {}
      clearInterval(ka);
      return;
    }

    const end = Math.min(off + frameBytes, pcmBuf.length);
    const chunk = pcmBuf.subarray(off, end);
    const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    conn.send(ab);
    off = end;

    setTimeout(pump, 20); // 20мс
  })();
});

conn.on(LiveTranscriptionEvents.Transcript, (msg) => {
  const alt = msg?.channel?.alternatives?.[0];
  const text = alt?.transcript || "";
  if (!text.trim()) return;
  const isFinal = !!(msg.is_final || msg.speech_final);
  console.log(isFinal ? "🟩 FINAL:" : "🟨 interim:", text);
});

conn.on(LiveTranscriptionEvents.Error, (e) => console.error("❌ Deepgram Error:", e));
conn.on(LiveTranscriptionEvents.Close, (ev) => {
  console.log("🔻 WebSocket закрыт", ev?.code, ev?.reason || "");
});
