export async function createEphemeralKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.MODEL || 'gpt-4o-realtime-preview';
  if (!apiKey) throw new Error('OPENAI_API_KEY missing');

  const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create session: ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.client_secret.value;
}
