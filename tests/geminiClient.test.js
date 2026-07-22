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
