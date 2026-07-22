/**
 * AI keyword research (spec module 1). Gemini estimates keyword ideas grounded in
 * the org's real services + market. NOTE: volume/CPC are AI ESTIMATES, not live
 * Google Ads data (that needs the Google Ads API / DataForSEO — a later upgrade).
 */
const { getOrgKnowledge } = require('../org');
const { geminiJSON } = require('./geminiClient');

const KW_SCHEMA = {
  type: 'object',
  properties: {
    keywords: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          volume: { type: 'integer' },
          difficulty: { type: 'integer' },
          cpc_low: { type: 'number' },
          cpc_high: { type: 'number' },
          intent: { type: 'string' },
          trend: { type: 'string' },
        },
        required: ['keyword', 'intent'],
      },
    },
  },
  required: ['keywords'],
};

async function researchKeywords(orgId, { seed_keyword, location = 'IN', count = 20 } = {}) {
  if (!seed_keyword) throw new Error('seed_keyword is required');
  const k = await getOrgKnowledge(orgId);

  const sys = 'You are a paid-search keyword strategist. From a seed keyword and the business profile, produce realistic keyword ideas, each with: estimated monthly search volume (integer), difficulty 0-100 (integer), CPC range in INR (cpc_low/cpc_high numbers), intent (Informational|Commercial|Transactional|Navigational), and trend (up|down|flat). Ground ideas in the business services + location. Values are approximate estimates.';
  const prompt = `Business profile: ${JSON.stringify(k)}\nSeed keyword: "${seed_keyword}"\nMarket: ${location}\nReturn ${count} keyword ideas.`;

  const out = await geminiJSON([{ role: 'system', content: sys }, { role: 'user', content: prompt }], { schema: KW_SCHEMA });
  return { seed: seed_keyword, location, estimated: true, keywords: out.keywords || [] };
}

module.exports = { researchKeywords };
