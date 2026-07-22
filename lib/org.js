/**
 * Organisation access — reads the SHARED `organizations` table (the LeadPilot
 * backend's canonical org + knowledge base). The Ad Manager only reads this;
 * the founder onboarding wizard (backend) owns writes.
 *
 * shapeKnowledge() maps the DB columns into the object every AI prompt in this
 * portal grounds on (chat research, ad copy, scoring, alerts).
 */
const { getServiceClient } = require('./supabase');

const sb = () => getServiceClient();

function shapeKnowledge(org) {
  if (!org) return null;
  return {
    org_id: org.id,
    business_name: org.name,
    slug: org.slug,
    industry: org.industry,
    website: org.website_url,
    services: org.services || [],
    pricing_min: org.pricing_min,
    pricing_max: org.pricing_max,
    target_audience: org.target_audience,
    competitors: org.competitors || [],
    brand_voice: org.brand_voice,
    languages: org.languages || [],
    usps: org.usps || [],
    monthly_revenue_target: org.monthly_revenue_target,
    alert_config: org.alert_config || null,
  };
}

async function getOrg(orgId) {
  const { data, error } = await sb().from('organizations').select('*').eq('id', orgId).maybeSingle();
  if (error) throw new Error(`getOrg failed: ${error.message}`);
  return data;
}

async function getOrgKnowledge(orgId) {
  return shapeKnowledge(await getOrg(orgId));
}

async function listOrgs() {
  const { data, error } = await sb().from('organizations').select('id,name,slug,industry').order('name');
  if (error) throw new Error(`listOrgs failed: ${error.message}`);
  return data || [];
}

module.exports = { getOrg, getOrgKnowledge, listOrgs, shapeKnowledge };
