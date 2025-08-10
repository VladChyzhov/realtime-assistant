import { sendAudioStream } from './utils/openai.js';

let currentStream = null;

export async function startAudioCapture() {
  if (currentStream) {
    stopAudioCapture();
  }

  try {
    // Try to capture system (speaker) audio
    currentStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: false,
    });
    console.log('System audio capture started');
  } catch (err) {
    console.warn('System audio capture failed, falling back to microphone', err);
    // Fallback to microphone
    currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  // Route the captured stream to backend via existing WebRTC/WebSocket layer
  sendAudioStream(currentStream);
  return currentStream;
}

export function stopAudioCapture() {
  if (!currentStream) return;
  currentStream.getTracks().forEach(track => track.stop());
  currentStream = null;
}
