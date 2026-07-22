import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listOrgs } = require('../lib/org.js');
const { generateAdCopy } = require('../lib/ai/adCopy.js');

const live = process.env.SUPABASE_URL && (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY)
  ? describe : describe.skip;

live('ad copy generation (live)', () => {
  it('generates grounded variants for a real org', async (ctx) => {
    let res;
    try {
      const orgs = await listOrgs();
      res = await generateAdCopy(orgs[0].id, { goal: 'test', count: 2 });
    } catch (e) {
      if (/\b(400|429|503)\b|credits|quota|depleted|RESOURCE_EXHAUSTED|high demand/i.test(e.message)) {
        ctx.skip();
        return;
      }
      throw e;
    }
    expect(Array.isArray(res.variants)).toBe(true);
    expect(res.variants.length).toBeGreaterThan(0);
    expect(res.variants[0]).toHaveProperty('headline');
    expect(res.variants[0]).toHaveProperty('cta');
  }, 60000);
});
