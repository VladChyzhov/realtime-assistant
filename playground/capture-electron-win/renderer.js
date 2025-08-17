// playground/capture-electron-win/renderer.js
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const volEl    = document.getElementById('vol');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');

function setStatus(msg) {
  console.log('[STATUS]', msg);
  if (statusEl) statusEl.textContent = msg;
}

function appendTranscript(text, isFinal) {
  if (!transcriptEl) return;
  if (isFinal) {
    transcriptEl.innerText += text + '\n';
  } else {
    transcriptEl.innerText = transcriptEl.innerText.replace(/(↩️.*)?$/, '') + text + ' ↩️';
  }
}

async function startCaptureSystemAudio() {
  try {
    // 1) Сначала открываем Deepgram, затем захват
    setStatus('Открываем соединение с Deepgram...');
    await window.electronAPI.dgStart();
    setStatus('Deepgram: открыто. Ищем экраны через preload/electronAPI...');

    // 2) Выбор источника экрана
    const sources = await window.electronAPI.getDesktopSources({ types: ['screen'] });
    if (!sources?.length) { setStatus('Нет экранов'); return; }
    const source = sources[0];
    setStatus('Выбран экран: ' + source.name);

    // 3) Захват системного аудио (просим и видео, и аудио)
    let stream;
    const constraints = {
      audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } }
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Fallback через getDisplayMedia, затем по отдельности
      try {
        const ds = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        stream = ds;
      } catch (e2) {
        const v = await navigator.mediaDevices.getUserMedia({ video: constraints.video, audio: false });
        const a = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio, video: false });
        stream = new MediaStream([...a.getAudioTracks(), ...v.getVideoTracks()]);
      }
    }

    setStatus('Системный звук захвачен. PCM 16k моно отправляется в Deepgram...');

         const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
     console.log("[RENDERER] Loading audio worklet...");
     await audioCtx.audioWorklet.addModule('./pcm-worklet.js');
     console.log("[RENDERER] Audio worklet loaded successfully");

    const srcNode = audioCtx.createMediaStreamSource(stream);
    const preGain = audioCtx.createGain();
    preGain.gain.value = 2.5; // лёгкое усиление до даунсемплера
    srcNode.connect(preGain);

    // Уровень громкости для UI
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    preGain.connect(analyser);
    const freq = new Uint8Array(analyser.frequencyBinCount);
    (function tick() {
      analyser.getByteFrequencyData(freq);
      const avg = freq.reduce((s, v) => s + v, 0) / freq.length;
      if (volEl) volEl.textContent = 'Volume: ' + avg.toFixed(2);
      requestAnimationFrame(tick);
    })();

         // Downsampler worklet (48k -> 16k) и сборка 20мс чанков Int16
     const worklet = new AudioWorkletNode(audioCtx, 'pcm-downsampler', {
       numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2
     });

    // Включаем в граф через "тихий" выход, чтобы process() гарантированно тикал
    const silent = audioCtx.createGain(); silent.gain.value = 0;
    preGain.connect(worklet);
    worklet.connect(silent);
    silent.connect(audioCtx.destination);

         // Читаем PCM чанки из ворклета и отправляем ArrayBuffer → preload (там станет Buffer)
     let sent = 0;
     worklet.port.onmessage = (ev) => {
       const d = ev.data;
       console.log("[RENDERER] got message from worklet:", typeof d, d?.constructor?.name, d?.byteLength || d?.length);
       
       if (d && typeof d === 'object' && d._debug === 'amp') {
         // Можно вывести телеметрию амплитуды при желании
         return;
       }
       // d — либо ArrayBuffer, либо TypedArray
       const ab = d instanceof ArrayBuffer ? d
                : (d && d.buffer instanceof ArrayBuffer ? d.buffer : null);
       if (!ab) {
         console.log("[RENDERER] invalid data, skipping");
         return;
       }

       console.log("[RENDERER] sending chunk to preload:", ab.byteLength, "bytes");
       window.electronAPI.sendChunk(ab);
       if (++sent % 50 === 0) console.log('[PCM] sent chunks:', sent, 'size:', ab.byteLength);
     };
    worklet.port.start?.();

    // Соединение уже открыто выше

         // События от Deepgram
     const transcriptEl = document.getElementById('transcript');

     function appendTranscriptWithLang(text, lang, isFinal) {
       if (!text?.trim()) return;
       const tag = lang ? `[${lang}] ` : '';
       if (isFinal) {
         transcriptEl.innerText += `${tag}${text}\n`;
       } else {
         // "живой" хвостик
         transcriptEl.innerText = transcriptEl.innerText.replace(/(↩️.*)?$/, '') + `${tag}${text} ↩️`;
       }
     }

           window.electronAPI.onDGMessage((msg) => {
        console.log('[DG]', msg);

        // системные сообщения
        if (msg.info) { setStatus(msg.info); return; }
        if (msg.error) { setStatus('Ошибка DG: ' + msg.error); return; }

        // основная ветка с распознаванием
        const alt = msg?.channel?.alternatives?.[0];

        // несколько попыток получить текст
        const text =
          alt?.transcript ??
          alt?.paragraphs?.transcript ??      // иногда текст лежит тут
          (Array.isArray(alt?.words) ? alt.words.map(w => w.word).join(' ') : '') ??
          '';

        const isFinal = !!(msg.is_final || msg.speech_final);

        if (text && text.trim().length) {
          appendTranscript(text, isFinal);
        } else {
          // для отладки: покажем сырой объект, чтобы увидеть его структуру
          const raw = document.createElement('div');
          raw.style.color = '#777';
          raw.style.fontSize = '12px';
          raw.textContent = '[DG raw] ' + JSON.stringify(msg);
          document.getElementById('transcript')?.appendChild(raw);
        }
      });

    // Остановка при завершении дорожки
    const [track] = stream.getAudioTracks();
    if (track) track.addEventListener('ended', () => {
      setStatus('Поток остановлен. DG закрываем.');
      window.electronAPI.dgStop();
    });

  } catch (err) {
    console.error(err);
    setStatus('Ошибка: ' + (err?.message || String(err)));
  }
}

function stopCaptureSystemAudio() {
  window.electronAPI.dgStop();
  setStatus('Захват остановлен и соединение закрыто');
}

startBtn?.addEventListener('click', startCaptureSystemAudio);
stopBtn?.addEventListener('click', stopCaptureSystemAudio);
