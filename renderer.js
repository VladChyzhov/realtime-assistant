import { initVAD } from './utils/vad.js';
import { SYSTEM_PROMPT } from './utils/prompt.js';

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const transcriptDiv = document.getElementById('transcript');
const modelSelect = document.getElementById('model');
const remoteAudio = document.getElementById('remote');

let pc;let localStream;let dataChannel;let vad;

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);

async function start() {
  startBtn.disabled = true; stopBtn.disabled = false;
  transcriptDiv.textContent = '';

  const token = await window.api.createEphemeralKey();
  const model = modelSelect.value;

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  vad = initVAD(localStream);

  pc = new RTCPeerConnection();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  dataChannel = pc.createDataChannel('oai-events');
  dataChannel.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'response.transcript.delta') {
        transcriptDiv.textContent += msg.text;
      }
    } catch(e){ console.error('bad message', e); }
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    remoteAudio.srcObject = stream;
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=${model}`, {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/sdp'
    }
  });

  const answer = { type: 'answer', sdp: await sdpResponse.text() };
  await pc.setRemoteDescription(answer);
}

async function stop() {
  startBtn.disabled = false; stopBtn.disabled = true;
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
}
