// playground/capture-electron-win/preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('[PRELOAD] loaded', __filename);

contextBridge.exposeInMainWorld('electronAPI', {
  getDesktopSources: (opts) => ipcRenderer.invoke('get-desktop-sources', opts),

  dgStart: () => ipcRenderer.invoke('dg-start'),
  startDG: () => ipcRenderer.invoke('dg-start'),
  dgStop: () => ipcRenderer.invoke('dg-stop'),

  // отправка батча (как было)
  sendChunk: (data) => {
    try {
      let buf;
      if (data instanceof Uint8Array) {
        buf = Buffer.from(data);
      } else if (data instanceof ArrayBuffer) {
        buf = Buffer.from(data);
      } else if (data && data.buffer instanceof ArrayBuffer) {
        buf = Buffer.from(
          data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + (data.byteLength || data.length || 0))
        );
      } else {
        console.warn('[PRELOAD] sendChunk: unsupported', typeof data);
        return;
      }
      ipcRenderer.send('dg-chunk', buf);

      // логим первые 10
      window.__dbg_cnt = (window.__dbg_cnt || 0) + 1;
      if (window.__dbg_cnt <= 10) {
        console.log(`[PRELOAD] send batch #${window.__dbg_cnt}, len=${buf.byteLength}`);
      }
    } catch (e) {
      console.error('[PRELOAD] sendChunk error:', e);
    }
  },

  // НОВОЕ: отдельная отправка каждого маленького фрейма (640 байт) для записи в debug/frame_*.raw
  saveRawChunk: (data) => {
    try {
      let buf;
      if (data instanceof Uint8Array) {
        buf = Buffer.from(data);
      } else if (data instanceof ArrayBuffer) {
        buf = Buffer.from(data);
      } else if (data && data.buffer instanceof ArrayBuffer) {
        buf = Buffer.from(
          data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + (data.byteLength || data.length || 0))
        );
      } else {
        console.warn('[PRELOAD] saveRawChunk: unsupported', typeof data);
        return;
      }
      ipcRenderer.send('save-raw-chunk', buf);
    } catch (e) {
      console.error('[PRELOAD] saveRawChunk error:', e);
    }
  },

  onDGMessage: (cb) => {
    ipcRenderer.removeAllListeners('dg-message');
    ipcRenderer.on('dg-message', (_e, msg) => {
      try { cb(msg); } catch (err) { console.error('[onDGMessage cb error]', err); }
    });
  },
});
