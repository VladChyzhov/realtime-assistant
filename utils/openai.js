const OpenAI = (() => {
  try {
    return require('openai');
  } catch (err) {
    console.warn('openai package is not installed. Responses will be empty.');
    return null;
  }
})();

let client = null;
function getClient() {
  if (!client && OpenAI) {
    try {
      client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } catch (err) {
      console.error('Failed to initialize OpenAI client', err);
    }
  }
  return client;
}

function detectQuestions(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const questionRegex = /^(who|what|when|where|why|how|is|are|am|do|does|did|can|could|would|should|may|might|will|shall)\b/i;
  return sentences
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => s.endsWith('?') || questionRegex.test(s));
}

async function fetchResponses(question) {
  const api = getClient();
  if (!api) return [];
  try {
    const res = await api.chat.completions.create({
      model: process.env.MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: question }],
      n: 3
    });
    return (res.choices || []).map(c => c.message && c.message.content).filter(Boolean);
  } catch (err) {
    console.error('OpenAI request failed:', err);
    return [];
  }
}

async function analyzeTranscript(text) {
  const questions = detectQuestions(text);
  const results = [];
  for (const q of questions) {
    const answers = await fetchResponses(q);
    results.push({ question: q, answers });
  }
  return results;
}

module.exports = { analyzeTranscript, detectQuestions };
