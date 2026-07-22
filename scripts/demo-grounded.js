/**
 * Demo: prove the integrated loop — read a real org's knowledge base from the
 * shared Supabase `organizations` table and ground Gemini on it.
 * Run: node -r dotenv/config scripts/demo-grounded.js
 */
const { listOrgs, getOrgKnowledge } = require('../lib/org');
const { geminiText } = require('../lib/ai/geminiClient');

(async () => {
  const orgs = await listOrgs();
  console.log('Real orgs in shared DB:', orgs.map((o) => `${o.name} (${o.industry || '?'})`).join(' | '));

  const k = await getOrgKnowledge(orgs[0].id);
  console.log(`\nGrounding on: ${k.business_name} | services: ${JSON.stringify(k.services)} | competitors: ${JSON.stringify(k.competitors)}`);

  const sys = 'You are the LeadPilot Ad Manager AI. Ground every answer ONLY in the provided business profile.';
  const prompt = `Business profile: ${JSON.stringify(k)}\n\nWrite ONE punchy ad headline (max 15 words) for this specific business.`;
  const out = await geminiText([{ role: 'system', content: sys }, { role: 'user', content: prompt }]);
  console.log(`\n>>> GROUNDED GEMINI OUTPUT:\n${out}`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
