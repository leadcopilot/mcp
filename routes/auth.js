const express = require('express');
const router  = express.Router();

const { startMetaOAuth, handleMetaCallback }     = require('../lib/auth/meta');
const { startGoogleOAuth, handleGoogleCallback } = require('../lib/auth/google');
const { getOrg }                                 = require('../lib/db');
const { checkOrgToken }                          = require('../lib/authz');

// The org must already exist and the caller must hold its token. The token
// arrives as ?org_token=... because this is a top-level browser navigation
// (a redirect to Meta/Google) that cannot carry an Authorization header.
function ensureOrg(req, res, next) {
  const orgId = req.query.org_id;
  if (!orgId) return res.status(400).json({ error: 'org_id is required' });
  const org = getOrg(orgId);
  if (!org) return res.status(404).json({ error: `Organisation "${orgId}" not found. Create it first.` });
  if (!checkOrgToken(req, org)) {
    return res.status(401).send('Unauthorized: missing or invalid org token');
  }
  next();
}

// ─── Meta OAuth ──────────────────────────────────────────────────────────────
// Step 1: Start Meta OAuth (redirect to Facebook login)
router.get('/meta', ensureOrg, startMetaOAuth);

// Step 2: Meta callback (Facebook redirects here after user approves)
router.get('/meta/callback', handleMetaCallback);

// ─── Google OAuth ─────────────────────────────────────────────────────────────
router.get('/google', ensureOrg, startGoogleOAuth);
router.get('/google/callback', handleGoogleCallback);

module.exports = router;
