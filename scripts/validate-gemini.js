// Validate text + function-calling on the configured Gemini key (with backoff).
const { geminiText, geminiToolLoop } = require('../lib/ai/geminiClient');

(async () => {
  const pong = await geminiText([{ role: 'user', content: 'Reply with exactly: PONG' }]);
  console.log('TEXT →', JSON.stringify(pong));

  const tools = [{
    name: 'get_price',
    description: 'Get the price in INR for a named service.',
    parameters: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
  }];
  const exec = async (n, a) => (n === 'get_price' && /whiten/i.test(a.service) ? '7999' : 'unknown');

  const { answer, toolsUsed } = await geminiToolLoop(
    [
      { role: 'system', content: 'Use tools for any price question. Never guess.' },
      { role: 'user', content: 'What does teeth whitening cost? Use the tool, then state the number.' },
    ],
    tools, exec,
  );
  console.log('FUNCTION-CALLING → toolsUsed:', toolsUsed, '| answer:', JSON.stringify(answer));
  console.log(toolsUsed.includes('get_price') && /7999/.test(answer) ? '\n✅ FULL AI ANALYST PATH WORKS' : '\n⚠️ unexpected result');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
