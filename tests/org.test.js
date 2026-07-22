import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shapeKnowledge, listOrgs, getOrgKnowledge } = require('../lib/org.js');

describe('org knowledge shaping (unit)', () => {
  it('maps organizations columns into the AI knowledge object', () => {
    const k = shapeKnowledge({
      id: 'o1', name: 'Acme Dental', slug: 'acme', industry: 'Dental',
      website_url: 'https://acme.com', services: ['whitening'], pricing_min: 5000,
      pricing_max: 50000, competitors: ['BrightSmile'], brand_voice: 'premium',
      languages: ['English'], usps: ['painless'], target_audience: 'urban 25-45',
    });
    expect(k).toMatchObject({
      org_id: 'o1', business_name: 'Acme Dental', website: 'https://acme.com',
      services: ['whitening'], competitors: ['BrightSmile'], brand_voice: 'premium',
    });
  });
});

const live = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? describe : describe.skip;

live('org access (live Supabase)', () => {
  it('lists the real orgs and reads one knowledge base', async () => {
    const orgs = await listOrgs();
    expect(orgs.length).toBeGreaterThan(0);
    const k = await getOrgKnowledge(orgs[0].id);
    expect(k.org_id).toBe(orgs[0].id);
    expect(k.business_name).toBeTruthy();
  });
});
