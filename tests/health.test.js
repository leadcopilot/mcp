import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkHealth } = require('../lib/health.js');

describe('checkHealth', () => {
  it('returns a status object with an env map', async () => {
    const h = await checkHealth();
    expect(h.status).toBe('ok');
    expect(h.env).toHaveProperty('supabase');
    expect(h.env).toHaveProperty('gemini');
    expect(['tavily', 'duckduckgo']).toContain(h.env.search);
  });
});
