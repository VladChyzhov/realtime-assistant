// Запуск:
//   PowerShell: $env:DG_KEY="..."; node replay_debug_frames_to_deepgram.cjs
//   Git Bash : DG_KEY=... node replay_debug_frames_to_deepgram.cjs

const fs = require('fs');
const path = require('path');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const DG_KEY = process.env.DG_KEY || process.env.DEEPGRAM_API_KEY;
if (!DG_KEY) { console.error('❌ Нет DG_KEY'); process.exit(1); }

const debugDir = path.join(__dirname, 'debug');
if (!fs.existsSync(debugDir)) { console.error('❌ Нет папки:', debugDir); process.exit(1); }

function getFrameFiles() {
  const files = fs.readdirSync(debugDir)
    .filter(f => /^frame_\d+\.raw$/i.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)[0], 10);
      const nb = parseInt(b.match(/\d+/)[0], 10);
      return na - nb;
    });
  if (!files.length) {
    console.error('❌ Нет файлов frame_*.raw в', debugDir);
    process.exit(1);
  }
  return files.map(f => path.join(debugDir, f));
}

const frames = getFrameFiles();
console.log(`🔎 Найдено кадров: ${frames.length}`);

const dg = createClient(DG_KEY);
const conn = dg.listen.live({
  model: 'nova-3',
  encoding: 'linear16',
  sample_rate: 16000,
  language: 'multi',
  interim_results: true,
  smart_format: true,
  vad_events: true,
  utterance_end_ms: 1200,
});

conn.on(LiveTranscriptionEvents.Error, (e) => console.error('❌ DG Error:', e));
conn.on(LiveTranscriptionEvents.Close, (ev) => console.log('🔻 closed', ev?.code, ev?.reason || ''));

conn.on(LiveTranscriptionEvents.Transcript, (msg) => {
  const alt = msg?.channel?.alternatives?.[0];
  const text = alt?.transcript || '';
  if (!text.trim()) return;
  const isFinal = !!(msg.is_final || msg.speech_final);
  console.log(isFinal ? '🟩 FINAL:' : '🟨 interim:', text);
});

conn.on(LiveTranscriptionEvents.Open, () => {
  console.log('✅ WS open');
  let i = 0;

  (function pump() {
    if (i >= frames.length) {
      console.log('📦 Все кадры отправлены. Финализируем...');
      try { conn.finalize(); } catch {}
      return;
    }
    const buf = fs.readFileSync(frames[i]);
    if (buf.length !== 640) {
      console.warn(`⚠️ frame ${i} (${path.basename(frames[i])}) len=${buf.length} (ожидалось 640)`);
    }
    // отправляем как есть (raw PCM s16le 16k mono)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    conn.send(ab);
    i++;
    setTimeout(pump, 20); // темп «реального времени» — 20мс на кадр
  })();
});
