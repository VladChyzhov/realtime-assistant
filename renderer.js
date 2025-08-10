import { createRealtimeConnection } from './utils/openai.js';

document.addEventListener('DOMContentLoaded', () => {
  const transcriptEl = document.getElementById('transcript');
  const answerEl = document.getElementById('answer');

  const connection = createRealtimeConnection();

  connection.addEventListener('transcript', (event) => {
    const text = event.detail;
    console.log('Transcript received:', text);
    transcriptEl.textContent = text;
  });

  connection.addEventListener('response', (event) => {
    const text = event.detail;
    console.log('Answer received:', text);
    answerEl.textContent = text;
  });

  connection.addEventListener('error', (event) => {
    console.error('Connection error:', event.detail);
  });
});
