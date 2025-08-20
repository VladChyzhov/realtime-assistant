// playground/capture-electron-win/main.cjs
const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { initSender, sendPCMChunk, finalizeSender } = require("./pcm-sender.cjs");
require('dotenv').config();
const DG_KEY = process.env.DG_KEY || process.env.DEEPGRAM_API_KEY;

let win;
let dgConn = null;
let dgOpen = false;
let dgReady = false;
let bufQueue = [];
let statIpcChunks = 0;      // сколько чанков приняли по IPC
let statQueuedChunks = 0;   // сколько положили в очередь
let statSentChunks = 0;     // сколько отправили в DG

// авто-финализация, если нет аудио > 2.5 c
let inactivityTimer = null;
function scheduleFinalize() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    try {
      console.log('[DG] finalize due to inactivity');
      dgConn?.finish();
      setTimeout(() => { try { dgConn?.close(); } catch {} }, 800);
    } catch (e) { console.error('[DG] finalize error:', e); }
  }, 2500); // 2.5 секунды
}

const MAX_QUEUED = 200; // ~4 сек по 20мс
let keepAliveTimer = null;
let statsTimer = null;
let sentBytes = 0;

// ---------- DEBUG: каталог для сырых чанков ----------
const debugDir = path.join(__dirname, 'debug');
if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
let frameId = 0; // для save-raw-chunk (кадры с ворклета)

// Источники (экраны)
ipcMain.handle('get-desktop-sources', async (_e, opts) => {
  return await desktopCapturer.getSources(opts);
});

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // важно для Node API в preload
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.openDevTools();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function flushQueued() {
  if (!dgConn || !dgReady) return;
  while (bufQueue.length) {
    const ab = bufQueue.shift(); // ArrayBuffer
    statQueuedChunks = bufQueue.length;
    try {
      if (statSentChunks < 5) console.log('[MAIN→DG] flushing chunk len=', ab.byteLength);
      dgConn.send(ab);
      sentBytes += ab.byteLength || 0;
      statSentChunks++;
    } catch (e) {
      console.error('[DG] send error in flushQueued:', e);
      break;
    }
  }
}

// Старт Deepgram Live (SDK)
ipcMain.handle('dg-start', async (event) => {
  const webContents = event.sender;
  if (!DG_KEY) {
    webContents.send('dg-message', { error: 'Нет DG_KEY в окружении' });
    return;
  }

  // Корректно остановим предыдущую сессию, если была
  try { if (dgConn) dgConn.finish(); } catch {}
  try { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } } catch {}
  try { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } } catch {}
  dgConn = null;

  const dgClient = createClient(DG_KEY);
  dgOpen = false;
  dgReady = false;
  bufQueue = [];
  sentBytes = 0;

  // Опции, согласованные с тестом
  dgConn = dgClient.listen.live({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: 16000,
    language: 'multi',           // или 'ru' при строго русской речи
    interim_results: true,
    smart_format: true,
    vad_events: true,
    utterance_end_ms: 1200,
  });

  dgConn.on(LiveTranscriptionEvents.Open, () => {
    console.log('[DG] Connection opened');
    dgOpen = true;
    dgReady = true;
    webContents.send('dg-message', { info: 'Deepgram WS open' });

    // sendSampleWavToDeepgram(); // ← оставляем выключенным

    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    keepAliveTimer = setInterval(() => {
      try { if (dgConn) dgConn.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
    }, 5000);

    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    statsTimer = setInterval(() => {
      try {
        webContents?.send('dg-message', {
          info: 'stats',
          sentBytes,
          queued: bufQueue.length,
          ipcChunks: statIpcChunks,
          sentChunks: statSentChunks
        });
      } catch {}
    }, 1000);
  });

  dgConn.on(LiveTranscriptionEvents.Close, (ev) => {
    console.log('[DG] Connection closed', ev?.code, ev?.reason);
    dgOpen = false;
    dgReady = false;
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    webContents.send('dg-message', { info: 'Deepgram WS closed', code: ev?.code, reason: ev?.reason });
  });

  dgConn.on(LiveTranscriptionEvents.Transcript, (data) => {
    try { webContents.send('dg-message', data); } catch (err) { console.error('❌ Error sending to renderer:', err); }
  });

  dgConn.on(LiveTranscriptionEvents.Metadata, (data) => {
    console.log('[DG] Metadata received:', data);
    try { webContents.send('dg-message', { info: '[DG metadata]', meta: data }); } catch {}
  });

  dgConn.on(LiveTranscriptionEvents.Error, (err) => {
    const msg = (err && (err.message || err.reason || err.code)) ? (err.message || err.reason || err.code) : String(err);
    console.error('[DG Error]', msg, err);
    try { webContents.send('dg-message', { error: msg, raw: err }); } catch {}
  });

  dgConn.on(LiveTranscriptionEvents.Warning, (w) => {
    console.warn('[DG Warning]', w);
    try { webContents.send('dg-message', { warning: w }); } catch {}
  });
});

// 🟣 ПРИЁМ «батчей» (как и было) — пишет .raw с таймштампом
ipcMain.on('dg-chunk', (_e, data) => {
  try {
    let u8;
    if (Buffer.isBuffer(data)) {
      u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    } else if (data instanceof ArrayBuffer) {
      u8 = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
    } else {
      console.warn('[MAIN] dg-chunk: unsupported type:', typeof data);
      return;
    }

    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

    // 💾 опционально — пишем батч в debug для отладки
    try {
      const chunkPath = path.join(__dirname, 'debug', `chunk_${Date.now()}.raw`);
      fs.writeFileSync(chunkPath, Buffer.from(ab));
    } catch {}

    // ✅ LIVE-отправка
    if (dgConn && dgReady) {
      dgConn.send(ab);
      sentBytes += ab.byteLength;
      statSentChunks++;
      scheduleFinalize();  // перезапускаем таймер «тишины»
    } else {
      // (опционально можно добавить буферизацию в bufQueue)
    }

    statIpcChunks++;
    if (statIpcChunks <= 3) console.log('[IPC] got batch len=', ab.byteLength);

  } catch (e) {
    console.error('[MAIN] dg-chunk error:', e);
  }
});


// 🟢 НОВОЕ: приём КАЖДОГО ФРЕЙМА от ворклета — пишет frame_00000.raw
ipcMain.on('save-raw-chunk', (_e, payload) => {
  try {
    let buf;
    if (Buffer.isBuffer(payload)) {
      buf = payload;
    } else if (payload instanceof Uint8Array) {
      buf = Buffer.from(payload);
    } else if (payload instanceof ArrayBuffer) {
      buf = Buffer.from(payload);
    } else if (payload && payload.buffer instanceof ArrayBuffer) {
      buf = Buffer.from(payload.buffer, payload.byteOffset || 0, payload.byteLength || payload.length || 0);
    } else {
      console.warn('[MAIN] save-raw-chunk: unsupported type:', typeof payload);
      return;
    }
    const filename = `frame_${String(frameId++).padStart(5, '0')}.raw`;
    fs.writeFile(path.join(debugDir, filename), buf, (err) => {
      if (err) console.error('[DEBUG] write frame error:', err);
    });
  } catch (e) {
    console.error('[MAIN] save-raw-chunk error:', e);
  }
});

// Явная остановка/финализация стрима
ipcMain.handle('dg-stop', async (event) => {
  const webContents = event.sender;
  try {
    if (dgConn) {
      try { 
        dgConn.finish(); // ← правильный метод для финализации стрима
        console.log('[DG] Called finish()');
      } catch (e) {
        console.error('[DG] finish() error:', e);
      }
      setTimeout(() => { 
        try { 
          dgConn.close(); 
          console.log('[DG] Called close()');
        } catch {} 
      }, 800);
    }
    dgConn = null;
    dgOpen = false;
    dgReady = false;
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
    bufQueue = [];
    webContents.send('dg-message', { info: 'Deepgram stopped' });
  } catch (e) {
    webContents.send('dg-message', { error: 'dg-stop error: ' + (e?.message || String(e)) });
  }
});

// --- (ниже остаются вспомогательные функции для WAV-теста, отключены) ---
function findWavDataOffset(buf) { /* … без изменений … */ }
function sendSampleWavToDeepgram() { /* … оставлено, но НЕ вызывается … */ }
