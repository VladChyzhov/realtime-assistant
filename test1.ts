import fs from 'fs';
import WebSocket, { RawData } from 'ws';
import { argv, env, exit } from 'process';

// usage:
//   PowerShell: $env:DG_KEY="..."; npx ts-node --project tsconfig.node.json test_stt.ts sample16k.wav
//   Git Bash : DG_KEY=... npx ts-node --project tsconfig.node.json test_stt.ts sample16k.wav

const wavPath = argv[2] || 'sample16k.wav';
const DG_KEY = env.DG_KEY || env.DEEPGRAM_API_KEY;
if (!DG_KEY) { console.error('❌ Нет DG_KEY'); exit(1); }
if (!fs.existsSync(wavPath)) { console.error('❌ Нет файла:', wavPath); exit(1); }

// Найти начало PCM (data-чанк)
function findWavDataOffset(buf: Buffer): number {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Не WAV RIFF/WAVE');
  }
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (id === 'data') return pos;
    pos += size;
  }
  throw new Error('data-чанк не найден');
}

// Параметры: русская речь, промежуточные, VAD + финализация
const url = 'wss://api.deepgram.com/v1/listen'
  + '?model=nova-3'
  + '&encoding=linear16'
  + '&sample_rate=16000'
  + '&language=multi'
  + '&interim_results=true'
  + '&smart_format=true'
  + '&vad_events=true'
  + '&utterance_end_ms=1200';

console.log('Connecting to:', url);

const ws = new WebSocket(url, { headers: { Authorization: 'Token ' + DG_KEY } });

// Поймать причину 400/403
ws.on('unexpected-response', (_req, res) => {
  console.error('HTTP', res.statusCode, res.statusMessage);
  console.error('dg-error:', res.headers['dg-error']);
  console.error('dg-request-id:', res.headers['dg-request-id']);
  let body = ''; res.on('data', c => body += c.toString()); res.on('end', () => console.error('Body:', body));
});

ws.on('open', () => {
  console.log('✅ WS open');

  // KeepAlive каждые 5с (на случай длинных пауз)
  const ka = setInterval(() => {
    try { ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
  }, 5000);

  // Загружаем wav и отрезаем заголовок
  const wav = fs.readFileSync(wavPath);
  const dataOffset = findWavDataOffset(wav);
  const pcm = wav.subarray(dataOffset);

  // Проверки формата
  if (pcm.length % 2 !== 0) console.warn('⚠️ PCM длина нечётная (ожидалось кратно 2 байтам)');
  const durationSec = pcm.length / (16000 * 2);
  console.log(`PCM bytes: ${pcm.length} (~${durationSec.toFixed(2)}s @16k mono)`);

  // Отправляем по 20мс = 640 байт
  const frameBytes = 640;
  let off = 0, chunks = 0, sentBytes = 0;

  (function pump() {
    if (off >= pcm.length) {
      console.log(`📦 Отправлено чанков: ${chunks}, байт: ${sentBytes}. Финализируем...`);
      try { ws.send(JSON.stringify({ type: 'Finalize' })); } catch {}
      clearInterval(ka);
      // Дадим серверу до 5с, потом сами закроем, чтобы не ловить NET-0001
      setTimeout(() => { try { ws.close(); } catch {} }, 5000);
      return;
    }
    const end = Math.min(off + frameBytes, pcm.length);
    const chunk = pcm.subarray(off, end);
    ws.send(chunk);
    off = end; chunks++; sentBytes += chunk.length;
    setTimeout(pump, 20);
  })();
});

ws.on('message', (m: RawData) => {
  let j: any; try { j = JSON.parse(m.toString()); } catch { return; }

  if (j.type === 'Metadata') return;

  const alt = j?.channel?.alternatives?.[0];
  const text = alt?.transcript ?? '';
  const isFinal = !!(j.is_final || j.speech_final);

  if (text.trim()) {
    console.log(isFinal ? '🟩 FINAL:' : '🟨 interim:', text);
  } else {
    // Разкомментируйте для полной диагностики
    // console.log('[DG raw]', JSON.stringify(j, null, 2));
  }
});

ws.on('close', (c, r) => console.log('🔻 close', c, r?.toString() || ''));
ws.on('error', e => console.error('❌ ws error:', (e as Error).message));





