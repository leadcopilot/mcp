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

// ── Connection status (graceful; Meta OAuth wiring pending) ──────────
router.get('/connections/status', requireAuth(AD_ROLES), (_req, res) => {
  // No per-org Meta token is stored in the integrated setup yet, so always
  // "not connected" for now; app creds being present only means we CAN connect.
  const metaConfigured = !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
  res.json({
    meta: { connected: false, configured: metaConfigured, connect_url: '/auth/meta' },
    google: { connected: false, configured: false },
  });
});

module.exports = router;
