// playground/capture-electron-win/renderer.js
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const volEl    = document.getElementById('vol');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');

function setStatus(msg) {
  console.log('[STATUS]', msg);
  if (statusEl) {
    statusEl.textContent = msg;
    if (msg.includes('Ошибка') || msg.includes('error') || msg.includes('❌')) {
      statusEl.className = 'status-value error';
    } else if (msg.includes('готов') || msg.includes('Готово') || msg.includes('✅')) {
      statusEl.className = 'status-value good';
    } else {
      statusEl.className = 'status-value warning';
    }
  }
}

// Упрощённая функция записи текста в UI
function appendTranscript(text, isFinal) {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  const ph = transcriptEl.querySelector('.transcript-item em');
  if (ph) transcriptEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'transcript-item ' + (isFinal ? 'final' : 'interim');
  div.textContent = text;
  if (!isFinal) {
    const last = transcriptEl.querySelector('.transcript-item.interim');
    if (last) last.remove();
  }
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ✅ Ранняя подписка на все сообщения от main → Deepgram
console.log('[RENDERER] Arming DG message listener (early)');
window.electronAPI.onDGMessage((msg) => {
  // 1) Телеметрия: сколько байт реально ушло и сколько в очереди
  if (msg.info === 'stats') {
    const el = document.getElementById('dg-status');
    if (el) el.textContent = `sent=${((msg.sentBytes||0)/1024).toFixed(1)}KB, queued=${msg.queued||0}`;
    console.log(`[STATS] ipcChunks=${msg.ipcChunks||0}, sentChunks=${msg.sentChunks||0}, queued=${msg.queued||0}`);
    return;
  }

  // 2) Служебные статусы/ошибки
  if (msg.info)   { console.log('[DG info]', msg.info); setStatus(msg.info); return; }
  if (msg.error)  { console.error('[DG error]', msg.error); setStatus('❌ Ошибка DG: ' + msg.error); return; }
  if (msg.warning){ console.warn('[DG warn]', msg.warning); setStatus('⚠️ DG Warning: ' + msg.warning); return; }

  // 3) Результаты распознавания
  const alt = msg?.channel?.alternatives?.[0];
  const text = alt?.transcript || '';
  const isFinal = !!(msg.is_final || msg.speech_final);

  if (text.trim()) {
    console.log(isFinal ? '🟩 FINAL:' : '🟨 interim:', text);
    appendTranscript(text, isFinal);
  } else {
    // Для отладки можно временно раскрыть всю структуру:
    // console.log('[DG raw]', JSON.stringify(msg));
  }
});

async function startCaptureSystemAudio() {
  try {
    setStatus('Открываем соединение с Deepgram...');
    await window.electronAPI.dgStart();

    const sources = await window.electronAPI.getDesktopSources({
      types: ['screen'],
      thumbnailSize: { width: 150, height: 150 }
    });

    let stream = null;
    if (sources?.length) {
      const source = sources[0];
      setStatus(`Выбран экран: ${source.name}`);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, echoCancellation: false, autoGainControl: false, noiseSuppression: false } },
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: 1280, maxHeight: 720 } }
        });
      } catch (err) {
        console.warn('Не удалось захватить через desktopCapturer:', err);
      }
    }
    if (!stream) {
      setStatus('Fallback: используем getDisplayMedia...');
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false, sampleRate: 48000 }
        });
      } catch (err) {
        throw new Error('Не удалось захватить экран: ' + err.message);
      }
    }

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) throw new Error('Аудио дорожка не найдена. Убедитесь, что выбрали весь экран и включили звук.');
    setStatus(`Захвачен поток с ${audioTracks.length} аудио дорожкой(ами)`);

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    console.log("[RENDERER] AudioContext created, sampleRate:", audioCtx.sampleRate, "state:", audioCtx.state);

    try {
      await audioCtx.audioWorklet.addModule('./pcm-worklet.js');
      console.log("[RENDERER] AudioWorklet loaded successfully");
    } catch (e) {
      console.error('[RENDERER] Failed to load worklet:', e);
      setStatus('❌ Ошибка загрузки AudioWorklet: ' + e.message);
      return;
    }

    const audioContextStateEl = document.getElementById('audio-context-state');
    const sampleRateEl = document.getElementById('sample-rate');
    if (audioContextStateEl) { audioContextStateEl.textContent = audioCtx.state; audioContextStateEl.className = 'status-value good'; }
    if (sampleRateEl) { sampleRateEl.textContent = audioCtx.sampleRate + ' Hz'; sampleRateEl.className = 'status-value good'; }

    const srcNode = audioCtx.createMediaStreamSource(stream);
    console.log("[RENDERER] MediaStreamSource created");

    const preGain = audioCtx.createGain();
    preGain.gain.value = 2.5;
    srcNode.connect(preGain);
    console.log("[RENDERER] Connected source → preGain");

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    preGain.connect(analyser);
    const freq = new Uint8Array(analyser.frequencyBinCount);
    (function tick() {
      analyser.getByteFrequencyData(freq);
      const avg = freq.reduce((s, v) => s + v, 0) / freq.length;
      if (volEl) {
        volEl.textContent = avg.toFixed(2);
        if (avg > 50) volEl.className = 'status-value good';
        else if (avg > 20) volEl.className = 'status-value warning';
        else volEl.className = 'status-value';
      }
      requestAnimationFrame(tick);
    })();

    let worklet;
    try {
      worklet = new AudioWorkletNode(audioCtx, 'pcm-downsampler', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
  channelInterpretation: 'speakers'
      });
      console.log("[RENDERER] AudioWorkletNode created");
    } catch (e) {
      console.error('[RENDERER] Failed to create AudioWorkletNode:', e);
      setStatus('❌ Ошибка создания AudioWorkletNode: ' + e.message);
      return;
    }

    const silent = audioCtx.createGain();
    silent.gain.value = 0;
    preGain.connect(worklet);
    worklet.connect(silent);
    silent.connect(audioCtx.destination);
    console.log("[RENDERER] Audio pipeline connected: source → preGain → worklet → silent → destination");

    // === Стабильный батчер: шлём редко, но крупно ===
    const FRAME_BYTES = 640;             // 20мс @16k mono s16le
    const TARGET_BATCH = FRAME_BYTES * 10; // ~200мс
    let batchBytes = 0;
    let batchBufs = [];
    let sentBatches = 0;
    let recvFrames = 0;
    let lastRecvTime = Date.now();

    // Диагностика потока аудио
    setInterval(() => {
      const now = Date.now();
      const silence = now - lastRecvTime;
      console.log(`[AUDIO STATUS] frames=${recvFrames}, batches=${sentBatches}, silence=${silence}ms`);
      if (silence > 2000 && recvFrames > 0) {
        console.error('[AUDIO] ⚠️ Ворклет перестал отправлять данные!');
      }
    }, 1000);

    // приходят кадры из worklet: ArrayBuffer по 640 байт
    worklet.port.onmessage = (ev) => {
      const d = ev.data;
      if (d && typeof d === 'object' && d._debug === 'amp') return;

      const ab = d instanceof ArrayBuffer ? d
                : (d && d.buffer instanceof ArrayBuffer ? d.buffer : null);
      if (!ab) {
        console.warn('[WORKLET] Получен не-ArrayBuffer:', d);
        return;
      }

      recvFrames++;
      lastRecvTime = Date.now();

      // 🆕 Сохраняем КАЖДЫЙ исходный фрейм в debug/frame_XXXXX.raw
      try {
        window.electronAPI.saveRawChunk(new Uint8Array(ab));
      } catch (e) {
        console.warn('[RENDERER] saveRawChunk failed:', e);
      }

      if (recvFrames <= 10) {
        console.log(`[WORKLET→RENDERER] frame ${recvFrames}, size=${ab.byteLength}`);
      }

      // ниже — твой batching как было
      batchBufs.push(new Uint8Array(ab)); // копий не делаем, просто ссылки
      batchBytes += ab.byteLength;

      // если набрали ≈200мс — отправляем немедленно
      if (batchBytes >= TARGET_BATCH) flushBatch();
    };

    // принудительная отправка (если тишина или не добрали 10 кадров)
    const flushTimer = setInterval(() => flushBatch(), 120);

    function flushBatch() {
      if (!batchBytes) return;
      const out = new Uint8Array(batchBytes);
      let off = 0;
      for (const u8 of batchBufs) { out.set(u8, off); off += u8.byteLength; }
      batchBufs = [];
      batchBytes = 0;

      // Отправляем Uint8Array напрямую (preload.js умеет его обрабатывать)
      console.log(`[SEND] Uint8Array, length=${out.byteLength}`);
      window.electronAPI.sendChunk(out);

      sentBatches++;
      const chunksSentEl = document.getElementById('chunks-sent');
      if (chunksSentEl) chunksSentEl.textContent = sentBatches * (TARGET_BATCH / FRAME_BYTES);
    }

    // на стоп — очищаем таймер
    const [audioTrack] = stream.getAudioTracks();
    if (audioTrack) audioTrack.addEventListener('ended', () => clearInterval(flushTimer));

    worklet.port.start?.();

    // Обработчик сообщений Deepgram
    window.electronAPI.onDGMessage((msg) => {
      // Быстрые статусы
      if (msg.info === 'stats') {
        const el = document.getElementById('dg-status');
        if (el) el.textContent = `sent=${((msg.sentBytes||0)/1024).toFixed(1)}KB, queued=${msg.queued||0}`;
        return;
      }
      if (msg.info) { setStatus(msg.info); return; }
      if (msg.error) { setStatus('❌ Ошибка DG: ' + msg.error); return; }
      if (msg.warning) { setStatus('⚠️ DG Warning: ' + msg.warning); return; }

      const alt = msg?.channel?.alternatives?.[0];
      const text = alt?.transcript || '';
      const isFinal = !!(msg.is_final || msg.speech_final);

      if (text.trim()) {
        console.log(isFinal ? '🟩 FINAL:' : '🟨 interim:', text);
        appendTranscript(text, isFinal);
      }

      if (Array.isArray(alt?.words)) {
        for (const w of alt.words) {
          const lang = w.language || w.lang || w.detected_language || 'unk';
          const token = w.word || w.punctuated_word || '';
          const conf = typeof w.confidence === 'number' ? w.confidence : (typeof w.probability === 'number' ? w.probability : undefined);
          if (token) console.log(`[${lang}] ${token} (${conf !== undefined ? conf.toFixed(2) : '-'})`);
        }
      }
    });

    const [track] = stream.getAudioTracks();
    if (track) track.addEventListener('ended', () => {
      setStatus('Поток остановлен. Ждём финальные результаты и закрытие.');
      window.electronAPI.dgStop();
    });

  } catch (err) {
    console.error(err);
    setStatus('Ошибка: ' + (err?.message || String(err)));
  }
}

function stopCaptureSystemAudio() {
  try { window.electronAPI.dgStop(); } catch {}
  setStatus('Захват остановлен. Ждём финальные результаты и закрытие.');
}

startBtn?.addEventListener('click', startCaptureSystemAudio);
stopBtn?.addEventListener('click', stopCaptureSystemAudio);

