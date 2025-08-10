const { analyzeTranscript } = require('./utils/openai');

async function processTranscription(text) {
  const qaPairs = await analyzeTranscript(text);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    const event = new CustomEvent('openai-responses', { detail: qaPairs });
    window.dispatchEvent(event);
  }
  return qaPairs;
}

module.exports = { processTranscription };
