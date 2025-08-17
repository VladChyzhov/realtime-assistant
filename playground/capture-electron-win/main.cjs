// playground/capture-electron-win/main.cjs
const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

require('dotenv').config();
const DG_KEY = process.env.DG_KEY || process.env.DEEPGRAM_API_KEY;

let win;
let dgConn = null;
let dgOpen = false;
let dgReady = false;
let bufQueue = [];
const MAX_QUEUED = 200; // ~4 сек по 20мс
let keepAliveTimer = null;
let sentBytes = 0;

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Источники (экраны)
ipcMain.handle('get-desktop-sources', async (_e, opts) => {
  return await desktopCapturer.getSources(opts);
});

// Старт Deepgram Live (SDK)
ipcMain.handle('dg-start', async (event) => {
  const webContents = event.sender;
  if (!DG_KEY) {
    webContents.send('dg-message', { error: 'Нет DG_KEY в окружении' });
    return;
  }
  const dgClient = createClient(DG_KEY);
  dgOpen = false;
  dgReady = false;
  bufQueue = [];

  dgConn = dgClient.listen.live({
    model: 'nova-3',
    sample_rate: 16000,
    encoding: 'linear16',
    channels: 1,
    interim_results: true,
    utterances: true,
    punctuate: true,
    smart_format: true,
    // Числовой endpointing
    endpointing: 100,
    vad_events: true,
    language: 'multi',
  });

  dgConn.on(LiveTranscriptionEvents.Open, () => {
    dgOpen = true;
    dgReady = true;
    webContents.send('dg-message', { info: 'Deepgram WS open' });
    // сброс очереди
    while (bufQueue.length) {
      try { dgConn.send(bufQueue.shift()); } catch { break; }
    }
    // keep-alive (опционально)
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    keepAliveTimer = setInterval(() => {
      try { if (dgConn) dgConn.send(JSON.stringify({ type: 'KeepAlive' })); } catch {}
    }, 4000);
  });

  // Метаданные — считаем готовностью и здесь
  dgConn.on(LiveTranscriptionEvents.Metadata, (m) => {
    try { webContents.send('dg-message', { info: '[DG metadata]', meta: m }); } catch (_) {}
    if (!dgReady) {
      dgReady = true;
      while (bufQueue.length) {
        try { dgConn.send(bufQueue.shift()); } catch { break; }
      }
    }
  });

  // Предупреждения
  dgConn.on(LiveTranscriptionEvents.Warning, (w) => {
    try { webContents.send('dg-message', { warning: w }); } catch (_) {}
    console.warn('[DG Warning]', w);
  });

  dgConn.on(LiveTranscriptionEvents.Transcript, (data) => {
    webContents.send('dg-message', data);
  });

  dgConn.on(LiveTranscriptionEvents.Error, (err) => {
    const msg = (err && (err.message || err.reason || err.code)) ? (err.message || err.reason || err.code) : String(err);
    console.error('[DG Error]', msg, err);
    try { webContents.send('dg-message', { error: msg, raw: err }); } catch (_) {}
  });

  dgConn.on(LiveTranscriptionEvents.Close, () => {
    dgOpen = false;
    dgReady = false;
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    webContents.send('dg-message', { info: 'Deepgram WS closed' });
  });
});

// Бинарные PCM-чанки из renderer → Deepgram
ipcMain.on('dg-chunk', (_e, data) => {
  // data может быть: Buffer | ArrayBuffer | Uint8Array | DataView | любой TypedArray
  let payload = null;

  if (Buffer.isBuffer(data)) {
    payload = data; // уже Buffer
  } else if (data instanceof ArrayBuffer) {
    payload = Buffer.from(new Uint8Array(data));
  } else if (ArrayBuffer.isView(data)) {
    // Uint8Array / Int16Array / DataView и т.п.
    payload = Buffer.from(
      new Uint8Array(data.buffer, data.byteOffset ?? 0, data.byteLength ?? data.byteLength)
    );
  }

  if (!payload) {
    console.warn('[MAIN] dg-chunk: unsupported type:', data?.constructor?.name);
    return;
  }

  // диагностика
  if (!ipcMain._dgCount) ipcMain._dgCount = 0;
  if (++ipcMain._dgCount % 10 === 0) {
    console.log('[MAIN] got chunk bytes:', payload.byteLength, 'total:', ipcMain._dgCount);
  }

  try {
    if (dgConn && dgReady) {
      dgConn.send(payload);
      sentBytes += payload.byteLength;
      if (sentBytes % (640 * 100) === 0) {
        console.log('[DG] sent bytes total:', sentBytes);
      }
    } else {
      bufQueue.push(payload);
      if (bufQueue.length > MAX_QUEUED) bufQueue.shift();
    }
  } catch (err) {
    console.error('[MAIN] dgConn.send error:', err);
  }
});

// Стоп
ipcMain.handle('dg-stop', async () => {
  if (dgConn) {
    dgConn.finish();
    dgConn = null;
  }
  ipcMain._dgCount = 0;
  bufQueue = [];
  dgOpen = false;
  dgReady = false;
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
});
