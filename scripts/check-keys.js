// Check each key in CHECK_KEYS (comma-separated) against a few models.
// No secrets committed — keys come from the environment.
const keys = (process.env.CHECK_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
const models = (process.env.CHECK_MODELS || 'gemini-3.5-flash,gemini-2.5-flash').split(',').map((m) => m.trim());
const body = { contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }] };

(async () => {
  for (let i = 0; i < keys.length; i++) {
    const masked = keys[i].slice(0, 10) + '…' + keys[i].slice(-4);
    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': keys[i] }, body: JSON.stringify(body) });
        const t = await r.text();
        let out = t;
        try { const j = JSON.parse(t); out = j.error?.message || j.candidates?.[0]?.content?.parts?.[0]?.text || t; } catch {}
        console.log(`KEY ${i + 1} (${masked}) [${model}] → ${r.status}: ${String(out).slice(0, 140)}`);
      } catch (e) {
        console.log(`KEY ${i + 1} (${masked}) [${model}] → ERR ${e.message}`);
      }
    }
  }
})();
