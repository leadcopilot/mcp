// Demo: generate grounded ad copy for the real org with the richest knowledge base.
const { listOrgs, getOrgKnowledge } = require('../lib/org');
const { generateAdCopy } = require('../lib/ai/adCopy');

(async () => {
  const orgs = await listOrgs();
  // Pick the org with the most populated knowledge.
  let best = null, bestScore = -1;
  for (const o of orgs) {
    const k = await getOrgKnowledge(o.id);
    const score = (k.services?.length || 0) + (k.usps?.length || 0) + (k.competitors?.length || 0) + (k.target_audience ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = { o, k }; }
  }
  console.log(`Chosen org: ${best.k.business_name} (industry=${best.k.industry || '?'}, services=${JSON.stringify(best.k.services)}, usps=${JSON.stringify(best.k.usps)})\n`);

  const res = await generateAdCopy(best.o.id, { goal: 'book more consultations', platform: 'meta', count: 3 });
  console.log(`>>> ${res.variants.length} grounded ad-copy variants for ${res.org}:\n`);
  res.variants.forEach((v, i) => {
    console.log(`--- Variant ${i + 1} ---`);
    console.log(`Headline: ${v.headline}`);
    console.log(`Primary:  ${v.primary_text}`);
    console.log(`CTA:      ${v.cta}\n`);
  });
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
