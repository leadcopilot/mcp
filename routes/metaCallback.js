// Integrated Meta OAuth callback (Supabase-backed). Mounted at /auth before the
// legacy auth router so /auth/meta/callback uses this handler.
const express = require('express');
const { handleMetaCallback } = require('../lib/auth/metaOAuth');

const router = express.Router();
router.get('/meta/callback', handleMetaCallback);
module.exports = router;
