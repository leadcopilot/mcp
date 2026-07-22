/**
 * Gemini REST client — mirrors leadpilot-backend/app/utils/gemini.py so the whole
 * product uses one Gemini convention.
 *
 * Raw generateContent REST API with the `x-goog-api-key` header (NOT ?key=, which
 * would leak the key into logged URLs). Comma-separated GEMINI_API_KEYS rotate on
 * 429/503. thinkingConfig comes from GEMINI_THINKING_LEVEL. Confirmed to work with
 * the backend's AQ.* keys + gemini-3.5-flash.
 */

const BASE_URL = () => process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

function keys() {
  return (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
    .split(',').map((k) => k.trim()).filter(Boolean);
}

let _keyIdx = 0;

/** Convert [{role, content}] -> Gemini (systemInstruction, contents). */
function toGemini(messages) {
  const sys = [];
  const contents = [];
  for (const m of messages) {
    const role = (m.role || 'user').toLowerCase();
    const text = m.content || '';
    if (role === 'system') sys.push(text);
    else contents.push({ role: role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  }
  return {
    systemInstruction: sys.length ? { parts: [{ text: sys.join('\n\n') }] } : undefined,
    contents,
  };
}

function parseText(data) {
  const cands = data.candidates || [];
  if (!cands.length) {
    const reason = data.promptFeedback?.blockReason;
    throw new Error(`Gemini returned no candidates (blockReason=${reason})`);
  }
  const parts = cands[0].content?.parts || [];
  const text = parts.filter((p) => p && p.text && !p.thought).map((p) => p.text).join('').trim();
  if (!text) throw new Error(`Gemini returned empty content (finishReason=${cands[0].finishReason})`);
  return text;
}

/** Low-level call with key rotation. `body` is a generateContent request body. */
async function generateContent(body, { model, thinkingLevel } = {}) {
  const ks = keys();
  if (!ks.length) throw new Error('No GEMINI_API_KEYS configured');
  const mdl = model || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const level = thinkingLevel || process.env.GEMINI_THINKING_LEVEL || 'low';
  if (level && body.generationConfig) body.generationConfig.thinkingConfig = { thinkingLevel: level };

  const url = `${BASE_URL()}/models/${mdl}:generateContent`;
  const maxAttempts = Math.max(ks.length * 2, 4);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const idx = _keyIdx % ks.length;
    const key = ks[idx];
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
    } catch (netErr) {
      // Transient network failure — rotate key, brief backoff, retry.
      lastErr = netErr;
      _keyIdx = (idx + 1) % ks.length;
      await sleep(1000);
      continue;
    }
    if (r.status === 429 || r.status === 503) {
      // Quota / rate limit / overload — rotate + exponential backoff, then retry.
      lastErr = new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 160)}`);
      _keyIdx = (idx + 1) % ks.length;
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }
    if (!r.ok) {
      // Hard error (bad request / invalid key / not found) — surface immediately.
      throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
    return r.json();
  }
  throw new Error(`Gemini failed after ${maxAttempts} attempt(s): ${lastErr?.message}`);
}

/** Plain text answer from a message list. */
async function geminiText(messages, opts = {}) {
  const { systemInstruction, contents } = toGemini(messages);
  const body = { contents, generationConfig: { temperature: opts.temperature ?? 0.3, maxOutputTokens: opts.maxTokens ?? 8192 } };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  return parseText(await generateContent(body, opts));
}

/** Schema-constrained JSON (structured output), mirroring backend gemini_extract. */
async function geminiJSON(messages, { schema, ...opts } = {}) {
  const { systemInstruction, contents } = toGemini(messages);
  const body = {
    contents,
    generationConfig: {
      responseMimeType: 'application/json',
      ...(schema ? { responseSchema: schema } : {}),
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: Math.max(opts.maxTokens ?? 4096, 32768),
    },
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  const text = parseText(await generateContent(body, opts));
  try {
    return JSON.parse(text);
  } catch {
    const s = text.indexOf('{'), e = text.lastIndexOf('}') + 1;
    if (s !== -1 && e > s) return JSON.parse(text.slice(s, e));
    throw new Error(`Gemini output not valid JSON: ${text.slice(0, 200)}`);
  }
}

function geminiConfigured() { return keys().length > 0; }

module.exports = { geminiText, geminiJSON, generateContent, toGemini, keys, geminiConfigured };
