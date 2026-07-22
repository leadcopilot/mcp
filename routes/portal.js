/**
 * Integrated Ad Manager API — auth-gated (shared backend JWT), Supabase-backed,
 * Gemini-powered. These endpoints supersede the prototype routes for the same
 * paths (mounted before them in server.js).
 */
const express = require('express');
const { requireAuth } = require('../lib/auth/jwt');
const { getOrgKnowledge } = require('../lib/org');
const { generateAdCopy } = require('../lib/ai/adCopy');
const { researchKeywords } = require('../lib/ai/keywords');
const { runAnalyst } = require('../lib/ai/analyst');
const { listLeads, leadStats, addLead, updateLeadStatus } = require('../lib/leads');
const { buildMetaAuthUrl } = require('../lib/auth/metaOAuth');
const { getMetaConnection } = require('../lib/connections');
const { executeMetaTool } = require('../lib/services/metaGraph');
const { dashboardSummary, dashboardDetail } = require('../lib/dashboard');
const { monthlyReport } = require('../lib/reports');
const { checkAlerts, listStoredAlerts, acknowledgeAlert } = require('../lib/roiMonitor');
const { driftCheck } = require('../lib/drift');
const { webSearch, scrape, analyse } = require('../lib/competitors');

const router = express.Router();
const AD_ROLES = ['founder', 'ad_manager'];

// Map AI quota/overload errors to 429 (client should retry), everything else 500.
function aiErrorStatus(msg) {
  return /\b(429|503)\b|quota|credits|depleted|RESOURCE_EXHAUSTED|high demand/i.test(msg) ? 429 : 500;
}

// ── Current user context (frontend header/session) ──────────────────
router.get('/me', requireAuth(), async (req, res) => {
  let business_name = null;
  try {
    const k = await getOrgKnowledge(req.auth.orgId);
    business_name = k?.business_name || null;
  } catch { /* org lookup best-effort */ }
  res.json({ user_id: req.auth.userId, org_id: req.auth.orgId, role: req.auth.role, business_name });
});

// ── Org knowledge base (read from shared organizations) ──────────────
router.get('/org/profile', requireAuth(AD_ROLES), async (req, res) => {
  try {
    const k = await getOrgKnowledge(req.auth.orgId);
    if (!k) return res.status(404).json({ error: 'Organisation not found' });
    res.json(k);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI ad-copy generation (spec §5) ──────────────────────────────────
router.post('/copy/generate', requireAuth(AD_ROLES), async (req, res) => {
  try {
    res.json(await generateAdCopy(req.auth.orgId, req.body || {}));
  } catch (e) {
    res.status(aiErrorStatus(e.message)).json({ error: e.message });
  }
});

// ── AI keyword research (spec module 1) ──────────────────────────────
router.post('/keywords/research', requireAuth(AD_ROLES), async (req, res) => {
  if (!req.body?.seed_keyword) return res.status(400).json({ error: 'seed_keyword is required' });
  try {
    res.json(await researchKeywords(req.auth.orgId, req.body));
  } catch (e) {
    res.status(aiErrorStatus(e.message)).json({ error: e.message });
  }
});

// ── AI Analyst chat (spec §4) — orchestrates real tools ──────────────
const WEB_TOOLS = [
  { name: 'search_web', description: 'Search the live web for competitor info, market pricing, or news.', parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer' } }, required: ['query'] } },
  { name: 'scrape_website', description: 'Fetch a specific website URL and extract its content (competitor pricing/services).', parameters: { type: 'object', properties: { url: { type: 'string' }, extract: { type: 'string' } }, required: ['url'] } },
];
// Read-only Meta Graph tools the analyst may auto-call (writes stay behind the
// explicit /campaigns/create + /meta-creator/* endpoints with a confirmation gate).
const META_READ_TOOLS = new Set([
  'list_campaigns', 'get_insights', 'get_ad_sets', 'get_ads', 'get_ad_creatives',
  'get_custom_audiences', 'get_saved_audiences', 'get_targeting_insights',
  'get_delivery_estimate', 'delivery_check', 'get_account_info', 'get_account_quality',
  'search_ad_library', 'search_interests', 'get_leads',
]);
const META_ANALYST_TOOLS = [
  { name: 'list_campaigns', description: "List this org's Meta campaigns with status and objective.", parameters: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'get_insights', description: 'Get Meta ad performance (spend, clicks, CTR, CPL, conversions).', parameters: { type: 'object', properties: { campaign_id: { type: 'string' }, date_preset: { type: 'string' } } } },
  { name: 'get_ad_sets', description: 'List ad sets (targeting, budget) for a campaign.', parameters: { type: 'object', properties: { campaign_id: { type: 'string' } } } },
  { name: 'get_ads', description: 'List ads and their creatives for a campaign.', parameters: { type: 'object', properties: { campaign_id: { type: 'string' } } } },
  { name: 'delivery_check', description: "Diagnose why a campaign/ad set isn't spending.", parameters: { type: 'object', properties: { object_id: { type: 'string' } } } },
  { name: 'search_ad_library', description: 'Search the Meta Ad Library for competitor ads.', parameters: { type: 'object', properties: { search_terms: { type: 'string' }, country: { type: 'string' } }, required: ['search_terms'] } },
  { name: 'search_interests', description: 'Find Meta interest-targeting options for a keyword.', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
];

async function makeAnalystExecutor(orgId) {
  const conn = await getMetaConnection(orgId);
  return async (name, args = {}) => {
    if (name === 'search_web') {
      const r = await webSearch(args.query, args.max_results || 5);
      return r.success ? JSON.stringify(r.results?.slice(0, 5) || r.answer || 'no results') : `search error: ${r.error}`;
    }
    if (name === 'scrape_website') {
      const r = await scrape(args.url, args.extract || 'all');
      return r.success ? String(r.full_text || r.title || JSON.stringify(r)).slice(0, 1500) : `scrape error: ${r.error}`;
    }
    if (META_READ_TOOLS.has(name)) {
      if (!conn) return 'The Meta account is not connected for this org.';
      const r = await executeMetaTool(name, args, conn.access_token, conn.ad_account_id);
      return r.success ? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)) : `Meta error: ${r.error}`;
    }
    return `Unknown tool: ${name}`;
  };
}

router.post('/ai-analyst', requireAuth(AD_ROLES), async (req, res) => {
  if (!req.body?.query) return res.status(400).json({ error: 'query is required' });
  try {
    const conn = await getMetaConnection(req.auth.orgId);
    const tools = [...WEB_TOOLS, ...(conn ? META_ANALYST_TOOLS : [])];
    const executeTool = await makeAnalystExecutor(req.auth.orgId);
    res.json(await runAnalyst(req.auth.orgId, req.body.query, { tools, executeTool }));
  } catch (e) {
    res.status(aiErrorStatus(e.message)).json({ error: e.message });
  }
});

// ── Dashboard (spec §7) + Monthly report (spec §8) ───────────────────
router.get('/dashboard/summary', requireAuth(AD_ROLES), async (req, res) => {
  try {
    res.json(await dashboardSummary(req.auth.orgId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/dashboard/detail', requireAuth(AD_ROLES), async (req, res) => {
  try {
    res.json(await dashboardDetail(req.auth.orgId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/org/drift-check', requireAuth(AD_ROLES), async (req, res) => {
  try {
    res.json(await driftCheck(req.auth.orgId));
  } catch (e) {
    res.status(aiErrorStatus(e.message)).json({ error: e.message });
  }
});
router.get('/reports/monthly', requireAuth(AD_ROLES), async (req, res) => {
  try {
    res.json(await monthlyReport(req.auth.orgId));
  } catch (e) {
    res.status(aiErrorStatus(e.message)).json({ error: e.message });
  }
});

// ── ROI Monitor Agent alerts (spec §9) ───────────────────────────────
// On-demand live check:
router.get('/alerts/check', requireAuth(AD_ROLES), async (req, res) => {
  try {
    res.json(await checkAlerts(req.auth.orgId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Persisted alerts (written by the always-on scheduler) — the frontend polls this:
router.get('/alerts', requireAuth(AD_ROLES), async (req, res) => {
  try {
    res.json({ alerts: await listStoredAlerts(req.auth.orgId, req.query.status || 'open') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/alerts/:id/ack', requireAuth(AD_ROLES), async (req, res) => {
  try {
    res.json(await acknowledgeAlert(req.auth.orgId, req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Competitor intelligence ──────────────────────────────────────────
router.post('/competitors/web-search', requireAuth(AD_ROLES), async (req, res) => {
  if (!req.body?.query) return res.status(400).json({ error: 'query is required' });
  try {
    res.json(await webSearch(req.body.query, req.body.max_results || 5));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/competitors/scrape', requireAuth(AD_ROLES), async (req, res) => {
  if (!req.body?.url) return res.status(400).json({ error: 'url is required' });
  try {
    res.json(await scrape(req.body.url, req.body.extract || 'all'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/competitors/analyse', requireAuth(AD_ROLES), async (req, res) => {
  if (!req.body?.competitor_name) return res.status(400).json({ error: 'competitor_name is required' });
  try {
    res.json(await analyse(req.auth.orgId, req.body));
  } catch (e) {
    res.status(aiErrorStatus(e.message)).json({ error: e.message });
  }
});

// ── Meta Ads Creator wizard (Graph; 409 if not connected) ────────────
const CREATOR_TOOLS = {
  interests: 'search_interests',
  estimate: 'get_delivery_estimate',
  creative: 'create_ad_creative',
  adset: 'create_ad_set',
  ad: 'create_ad',
  preview: 'get_ad_preview',
  'ad-library': 'search_ad_library',
};
for (const [path, tool] of Object.entries(CREATOR_TOOLS)) {
  router.post(`/meta-creator/${path}`, requireAuth(AD_ROLES), async (req, res) => {
    const conn = await metaConnOr409(req.auth.orgId, res); if (!conn) return;
    const r = await executeMetaTool(tool, req.body || {}, conn.access_token, conn.ad_account_id);
    return r.success ? res.json({ data: r.data }) : res.status(502).json({ error: r.error });
  });
}

// ── Leads (spec module 5) — shared Supabase leads table ─────────────
router.get('/leads/list', requireAuth(AD_ROLES), async (req, res) => {
  try {
    const leads = await listLeads(req.auth.orgId, { status: req.query.status, limit: Number(req.query.limit) || 100 });
    const stats = await leadStats(req.auth.orgId);
    res.json({ leads, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/leads/add', requireAuth(AD_ROLES), async (req, res) => {
  try {
    res.json(await addLead(req.auth.orgId, req.body || {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/leads/update-status', requireAuth(AD_ROLES), async (req, res) => {
  if (!req.body?.lead_id) return res.status(400).json({ error: 'lead_id is required' });
  try {
    res.json(await updateLeadStatus(req.auth.orgId, req.body.lead_id, req.body));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Meta connection + campaigns (Graph API, per-org token) ───────────
router.get('/connections/meta/start', requireAuth(AD_ROLES), async (req, res) => {
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    return res.status(400).json({ error: 'Meta app not configured (META_APP_ID/SECRET)' });
  }
  try {
    res.json({ auth_url: await buildMetaAuthUrl(req.auth.orgId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/connections/status', requireAuth(AD_ROLES), async (req, res) => {
  const conn = await getMetaConnection(req.auth.orgId);
  res.json({
    meta: conn
      ? { connected: true, ad_account_id: conn.ad_account_id }
      : { connected: false, configured: !!(process.env.META_APP_ID && process.env.META_APP_SECRET), connect_url: '/api/connections/meta/start' },
    google: { connected: false, configured: false },
  });
});

async function metaConnOr409(orgId, res) {
  const conn = await getMetaConnection(orgId);
  if (!conn) {
    res.status(409).json({ error: 'Connect your Meta account first', connect_url: '/api/connections/meta/start' });
    return null;
  }
  return conn;
}

router.post('/campaigns/list', requireAuth(AD_ROLES), async (req, res) => {
  const conn = await metaConnOr409(req.auth.orgId, res); if (!conn) return;
  const r = await executeMetaTool('list_campaigns', req.body || {}, conn.access_token, conn.ad_account_id);
  return r.success ? res.json({ data: r.data }) : res.status(502).json({ error: r.error });
});

router.post('/campaigns/insights', requireAuth(AD_ROLES), async (req, res) => {
  const conn = await metaConnOr409(req.auth.orgId, res); if (!conn) return;
  const r = await executeMetaTool('get_insights', req.body || {}, conn.access_token, conn.ad_account_id);
  return r.success ? res.json({ data: r.data }) : res.status(502).json({ error: r.error });
});

router.post('/campaigns/create', requireAuth(AD_ROLES), async (req, res) => {
  if (!req.body?.confirmed) return res.json({ requires_confirmation: true, preview: req.body || {} });
  const conn = await metaConnOr409(req.auth.orgId, res); if (!conn) return;
  const r = await executeMetaTool('create_campaign', req.body, conn.access_token, conn.ad_account_id);
  return r.success ? res.json({ data: r.data }) : res.status(502).json({ error: r.error });
});

module.exports = router;
