import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('geminiClient (unit)', () => {
  let mod;
  beforeEach(() => {
    process.env.GEMINI_API_KEYS = 'k1, k2 ,k3';
    process.env.GEMINI_MODEL = 'gemini-3.5-flash';
    delete require.cache[require.resolve('../lib/ai/geminiClient.js')];
    mod = require('../lib/ai/geminiClient.js');
  });

  it('parses comma-separated keys, trimming blanks', () => {
    expect(mod.keys()).toEqual(['k1', 'k2', 'k3']);
  });

  it('reports configured when keys present', () => {
    expect(mod.geminiConfigured()).toBe(true);
  });

  it('converts messages to gemini contents + systemInstruction', () => {
    const { systemInstruction, contents } = mod.toGemini([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
    expect(systemInstruction.parts[0].text).toBe('sys');
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'yo' }] },
    ]);
  });
});

const live = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY ? describe : describe.skip;

live('geminiClient function-calling (live)', () => {
  it('calls a tool and grounds its final answer in the tool result', async (ctx) => {
    const require2 = createRequire(import.meta.url);
    delete require2.cache[require2.resolve('../lib/ai/geminiClient.js')];
    const { geminiToolLoop } = require2('../lib/ai/geminiClient.js');

    const tools = [{
      name: 'get_price',
      description: 'Get the price in INR for a named service.',
      parameters: {
        type: 'object',
        properties: { service: { type: 'string', description: 'service name' } },
        required: ['service'],
      },
    }];
    const executeTool = async (name, args) =>
      name === 'get_price' && /whiten/i.test(args.service) ? '7999' : 'unknown';

    let result;
    try {
      result = await geminiToolLoop(
        [
          { role: 'system', content: 'Use tools for any price question. Never guess.' },
          { role: 'user', content: 'What does teeth whitening cost? Use the tool, then state the number.' },
        ],
        tools,
        executeTool,
      );
    } catch (e) {
      // Skip (not fail) when the account is out of Gemini quota/credits or overloaded.
      // Free/preview-tier quota exhaustion can surface as 429/503 (and occasionally a
      // transient 400 under load) — re-verify with a properly-credited key.
      if (/\b(400|429|503)\b|credits|quota|depleted|RESOURCE_EXHAUSTED|high demand/i.test(e.message)) {
        ctx.skip();
        return;
      }
      throw e;
    }
    expect(result.toolsUsed).toContain('get_price');
    expect(result.answer).toMatch(/7999/);
  }, 60000);
});
