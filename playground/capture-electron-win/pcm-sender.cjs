// Тестовая отправка PCM чанков в Deepgram из Electron main process

const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

let conn = null;
let finalizeTimeout = null;

function initSender(dgKey) {
  if (!dgKey) {
    console.error('❌ Нет ключа DG_KEY');
    return;
  }

  const dg = createClient(dgKey);

  conn = dg.listen.live({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: 16000,
    language: 'multi',
    interim_results: true,
    smart_format: true,
    vad_events: true,
    utterance_end_ms: 1200,
  });

  conn.on(LiveTranscriptionEvents.Open, () => {
    console.log('✅ Deepgram WebSocket открыт');
  });

  conn.on(LiveTranscriptionEvents.Close, (ev) => {
    console.log('🔻 Deepgram закрыт', ev?.code, ev?.reason || '');
  });

  conn.on(LiveTranscriptionEvents.Error, (e) => {
    console.error('❌ Deepgram Error:', e);
  });

  conn.on(LiveTranscriptionEvents.Transcript, (msg) => {
    const alt = msg?.channel?.alternatives?.[0];
    const text = alt?.transcript || '';
    if (!text.trim()) return;
    const isFinal = !!(msg.is_final || msg.speech_final);
    console.log(isFinal ? '🟩 FINAL:' : '🟨 interim:', text);
  });

  // можно добавить Metadata при необходимости
}

// Автоматическая финализация через 3 секунды
function scheduleFinalize() {
  if (finalizeTimeout) clearTimeout(finalizeTimeout);
  finalizeTimeout = setTimeout(() => {
    try {
      console.log('🛑 Финализируем поток...');
      conn.finalize();
    } catch (e) {
      console.error('❌ Ошибка при finalize:', e.message);
    }
  }, 3000); // 3 секунды тишины
}

function sendPCMChunk(data) {
  if (!conn) return;

  let u8;
  if (Buffer.isBuffer(data)) {
    u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    u8 = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
  } else {
    console.warn('[sendPCMChunk] Unsupported data type:', typeof data);
    return;
  }

  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  conn.send(ab);
  scheduleFinalize(); // перезапуск финализации
}

module.exports = {
  initSender,
  sendPCMChunk,
};
