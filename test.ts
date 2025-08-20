import fs from "fs";
import { argv, env, exit } from "process";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";

// usage:
//   PowerShell: $env:DG_KEY="..." ; npx ts-node --project tsconfig.node.json test.ts sample16k.wav
//   Git Bash : DG_KEY=... npx ts-node --project tsconfig.node.json test.ts sample16k.wav

const wavPath = argv[2] || "sample16k.wav";
const DG_KEY = env.DG_KEY || env.DEEPGRAM_API_KEY;

if (!DG_KEY) { console.error("❌ Нет DG_KEY"); exit(1); }
if (!fs.existsSync(wavPath)) { console.error("❌ Не найден файл:", wavPath); exit(1); }

// ---- найти начало PCM (data-чанк) и отрезать заголовок WAV
function findWavDataOffset(buf: Buffer): number {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Файл не выглядит как WAV RIFF/WAVE");
  }
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (id === "data") return pos; // начало PCM
    pos += size;
  }
  throw new Error("Не найден data-чанк в WAV");
}

// ---- Deepgram live
const dg = createClient(DG_KEY);

const conn = dg.listen.live({
  model: "nova-3",
  encoding: "linear16",
  sample_rate: 16000,
  language: "multi",          // можно 'ru' если точно русская речь
  interim_results: true,
  smart_format: true,
  vad_events: true,
  utterance_end_ms: 1200,
});

// детальный лог ошибок рукопожатия/сокета
conn.on(LiveTranscriptionEvents.Error, (e) => {
  console.error("❌ DG Error:", e);
});
conn.on(LiveTranscriptionEvents.Close, (ev: any) => {
  console.log("🔻 closed", ev?.code, ev?.reason || "");
});

// транскрипты (как в Electron)
conn.on(LiveTranscriptionEvents.Transcript, (msg: any) => {
  const alt = msg?.channel?.alternatives?.[0];
  const text = alt?.transcript || "";
  if (!text.trim()) return;
  const isFinal = !!(msg.is_final || msg.speech_final);
  console.log(isFinal ? "🟩 FINAL:" : "🟨 interim:", text);
});

// метаданные можно раскомментировать
// conn.on(LiveTranscriptionEvents.Metadata, (m) => console.log("[meta]", m));

conn.on(LiveTranscriptionEvents.Open, () => {
  console.log("✅ WS open");

  // читаем wav и получаем PCM
  const wav = fs.readFileSync(wavPath);
  const dataOffset = findWavDataOffset(wav);
  const pcmBuf = wav.subarray(dataOffset);

  const duration = pcmBuf.length / (16000 * 2);
  console.log(`PCM bytes: ${pcmBuf.length} (~${duration.toFixed(2)}s @16k mono)`);

  // 20 мс @16kHz mono 16-bit -> 640 байт
  const frameBytes = 640;
  let off = 0, chunks = 0, sentBytes = 0;

  const keepAlive = setInterval(() => {
    try { conn.send(JSON.stringify({ type: "KeepAlive" })); } catch {}
  }, 5000);

  (function pump() {
    if (off >= pcmBuf.length) {
      console.log(`📦 Отправлено чанков: ${chunks}, байт: ${sentBytes}. Финализируем...`);
      try { conn.finalize(); } catch {}
      clearInterval(keepAlive);
      return;
    }

    const end = Math.min(off + frameBytes, pcmBuf.length);
    const chunk = pcmBuf.subarray(off, end);

    // ✅ ВАЖНО: передавать ЧИСТЫЙ ArrayBuffer с корректным срезом
    const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    conn.send(ab as ArrayBuffer);

    off = end;
    chunks++;
    sentBytes += chunk.length;

    setTimeout(pump, 20); // темп "реального времени"
  })();
});


