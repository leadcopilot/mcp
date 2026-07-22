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

const router = express.Router();
const AD_ROLES = ['founder', 'ad_manager'];

// Map AI quota/overload errors to 429 (client should retry), everything else 500.
function aiErrorStatus(msg) {
  return /\b(429|503)\b|quota|credits|depleted|RESOURCE_EXHAUSTED|high demand/i.test(msg) ? 429 : 500;
}

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

// ── AI Analyst chat (spec §4) ────────────────────────────────────────
router.post('/ai-analyst', requireAuth(AD_ROLES), async (req, res) => {
  if (!req.body?.query) return res.status(400).json({ error: 'query is required' });
  try {
    res.json(await runAnalyst(req.auth.orgId, req.body.query));
  } catch (e) {
    res.status(aiErrorStatus(e.message)).json({ error: e.message });
  }
});

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
