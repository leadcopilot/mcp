/**
 * AI ad-copy generation (spec §5) — grounded ONLY in the org's real knowledge
 * base (services, pricing, brand voice, USPs) from the shared `organizations`
 * table. Structured output via Gemini so the portal always gets valid variants.
 */
const { getOrgKnowledge } = require('../org');
const { geminiJSON } = require('./geminiClient');

const COPY_SCHEMA = {
  type: 'object',
  properties: {
    variants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          primary_text: { type: 'string' },
          cta: { type: 'string' },
        },
        required: ['headline', 'primary_text', 'cta'],
      },
    },
  },
  required: ['variants'],
};

async function generateAdCopy(orgId, { goal, platform = 'meta', count = 3 } = {}) {
  const k = await getOrgKnowledge(orgId);
  if (!k) throw new Error(`Org ${orgId} not found`);

  const sys = `You are the LeadPilot Ad Manager copywriter. Write ${platform} ad copy grounded ONLY in this business's real profile. Never invent services or prices that are not present. Match the stated brand voice.`;
  const prompt = `Business profile:\n${JSON.stringify(k, null, 2)}\n\nGoal: ${goal || 'drive qualified leads'}\nProduce ${count} distinct ${platform} ad-copy variants. Each has a headline, primary_text, and cta.`;

  const out = await geminiJSON(
    [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
    { schema: COPY_SCHEMA },
  );
  return { org: k.business_name, platform, goal: goal || 'drive qualified leads', variants: out.variants || [] };
}

module.exports = { generateAdCopy };
