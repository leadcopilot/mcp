/**
 * Profile drift detection (spec §3). Scrapes the org's website and asks Gemini to
 * flag services/prices in the stored profile that no longer match the site (or vice
 * versa) — so live ads never promote something the website contradicts.
 */
const { getOrg } = require('./org');
const { scrapeWebsite } = require('./services/scraper');
const { geminiJSON } = require('./ai/geminiClient');

const SCHEMA = {
  type: 'object',
  properties: {
    drift_detected: { type: 'boolean' },
    mismatches: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['drift_detected', 'summary'],
};

async function driftCheck(orgId) {
  const org = await getOrg(orgId);
  if (!org?.website_url) return { drift_detected: false, summary: 'No website URL on file for this org.' };

  const scraped = await scrapeWebsite(org.website_url, 'all');
  if (!scraped.success) return { drift_detected: null, error: `Could not scrape ${org.website_url}: ${scraped.error}` };

  const sys = 'You compare a stored business profile against the current website. Flag any service or price in the profile NOT reflected on the website, and any prominent website service/price missing from the profile. Only flag real, confident mismatches — never guess.';
  const prompt = `Stored profile:\n- services: ${JSON.stringify(org.services || [])}\n- pricing: ${org.pricing_min ?? '?'}–${org.pricing_max ?? '?'}\n\nWebsite prices found: ${JSON.stringify(scraped.prices_found || [])}\nWebsite content (excerpt):\n${String(scraped.full_text || '').slice(0, 4000)}`;

  const out = await geminiJSON([{ role: 'system', content: sys }, { role: 'user', content: prompt }], { schema: SCHEMA });
  return { website: org.website_url, ...out };
}

module.exports = { driftCheck };
