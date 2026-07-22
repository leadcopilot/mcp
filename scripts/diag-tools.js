// Wait for the free-tier window to reset, then fire ONE function-calling request
// on key 2 to definitively confirm the tool request format is valid.
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const keys = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map((k) => k.trim()).filter(Boolean);
const key = keys[1] || keys[0];

const body = {
  contents: [{ role: 'user', parts: [{ text: 'What does teeth whitening cost? Call get_price with service="whitening".' }] }],
  tools: [{ functionDeclarations: [{
    name: 'get_price',
    description: 'Get the price in INR for a named service.',
    parameters: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
  }] }],
  generationConfig: { temperature: 0.2 },
};

(async () => {
  console.log('waiting 25s for free-tier reset...');
  await new Promise((r) => setTimeout(r, 25000));
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
  const t = await r.text();
  console.log(`STATUS ${r.status}`);
  if (r.ok) {
    const parts = JSON.parse(t).candidates?.[0]?.content?.parts;
    const call = parts?.find((p) => p.functionCall);
    console.log(call ? `✅ FUNCTION-CALLING WORKS → model called ${call.functionCall.name}(${JSON.stringify(call.functionCall.args)})`
                     : `200 but no functionCall; parts=${JSON.stringify(parts)?.slice(0, 200)}`);
  } else {
    console.log(t.slice(0, 400));
  }
})();
