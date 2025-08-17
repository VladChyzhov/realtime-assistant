// playground/capture-electron-win/preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('[PRELOAD] loaded', __filename);

contextBridge.exposeInMainWorld('electronAPI', {
  getDesktopSources: (opts) => ipcRenderer.invoke('get-desktop-sources', opts),
  dgStart: () => ipcRenderer.invoke('dg-start'),
  // alias под ваш шаблон
  startDG: () => ipcRenderer.invoke('dg-start'),
  dgStop: () => ipcRenderer.invoke('dg-stop'),

     // ⚠️ Отправляем ТОЛЬКО Buffer → безопасно для IPC, без transfer-list
   // На вход ждём ArrayBuffer из renderer.
   sendChunk: (arrayBuffer) => {
     try {
       console.log("[PRELOAD] sendChunk called with:", typeof arrayBuffer, arrayBuffer?.constructor?.name, arrayBuffer?.byteLength);
       
       if (!(arrayBuffer instanceof ArrayBuffer)) {
         console.warn("[PRELOAD] Not ArrayBuffer, skipping");
         return;
       }
       
       const nodeBuf = Buffer.from(new Uint8Array(arrayBuffer));
       console.log("[PRELOAD] converted to Buffer:", nodeBuf.byteLength, "bytes");
       ipcRenderer.send('dg-chunk', nodeBuf);
       console.log("[PRELOAD] sent to main process");
     } catch (e) {
       console.error('[PRELOAD] sendChunk error:', e);
     }
   },

  onDGMessage: (cb) => {
    ipcRenderer.removeAllListeners('dg-message');
    ipcRenderer.on('dg-message', (_e, msg) => cb(msg));
  },
});
