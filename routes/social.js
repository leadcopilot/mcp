const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fetch = require('node-fetch');

const {
  getOrg,
  getMetaConnection,
  saveSocialConnection,
  getSocialConnections,
  deleteSocialConnection,
  saveSocialMetricsHistory,
  getSocialMetricsHistory,
  saveOAuthState,
  consumeOAuthState
} = require('../lib/db');

const {
  getFacebookPages,
  getFacebookPageMetrics,
  getInstagramAccount,
  getInstagramMetrics,
  getYouTubeMetrics,
  getTwitterMetrics,
  getLinkedInCompanyMetrics
} = require('../lib/services/social');

const { checkOrgToken } = require('../lib/authz');

// Middleware to ensure org is valid and the caller holds its token
function withOrg(req, res, next) {
  const orgId = req.body?.org_id || req.query?.org_id;
  if (!orgId) return res.status(400).json({ error: 'org_id required' });
  const org = getOrg(orgId);
  if (!org) return res.status(404).json({ error: `Organisation "${orgId}" not found.` });
  if (!checkOrgToken(req, org)) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid org token' });
  }
  req.orgId = orgId;
  req.org = org;
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// 1. FACEBOOK PAGE
// ════════════════════════════════════════════════════════════════════════════
router.get('/auth/facebook-pages', withOrg, async (req, res) => {
  try {
    const metaConn = getMetaConnection(req.orgId);
    if (!metaConn) return res.status(400).json({ error: 'Connect Meta in Settings first.' });

    const pages = await getFacebookPages(metaConn.access_token);
    res.json({ success: true, pages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/connect/facebook-page', withOrg, async (req, res) => {
  const { page_id, page_name, access_token } = req.body;
  if (!page_id || !access_token) return res.status(400).json({ error: 'page_id and access_token required' });

  saveSocialConnection(req.orgId, 'Facebook', {
    access_token,
    page_id,
    page_name
  });

  // Automatically check for Instagram Business Account
  try {
    const igAccount = await getInstagramAccount(page_id, access_token);
    if (igAccount && igAccount.id) {
      saveSocialConnection(req.orgId, 'Instagram', {
        access_token, // IG uses the FB page token
        page_id: igAccount.id,
        page_name: 'Instagram via ' + page_name
      });
    }
  } catch (err) {
    console.error('Failed to link Instagram:', err.message);
  }

  res.json({ success: true, message: 'Facebook Page connected successfully.' });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. YOUTUBE (Google OAuth)
// ════════════════════════════════════════════════════════════════════════════
const YOUTUBE_SCOPES = 'https://www.googleapis.com/auth/youtube.readonly';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

router.get('/auth/youtube', withOrg, (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  saveOAuthState(state, req.orgId, 'youtube');

  // Need a specific redirect URI for YouTube, e.g., /social/auth/youtube/callback
  // Ensure process.env.YOUTUBE_REDIRECT_URI is set or fallback to host based
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || `http://${req.get('host')}/social/auth/youtube/callback`;

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
});

router.get('/auth/youtube/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect(`/?social_error=${encodeURIComponent(error)}`);
  
  const stateRow = consumeOAuthState(state);
  if (!stateRow || stateRow.provider !== 'youtube') {
    return res.redirect('/?social_error=Invalid_state_token');
  }

  try {
    const redirectUri = process.env.YOUTUBE_REDIRECT_URI || `http://${req.get('host')}/social/auth/youtube/callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    saveSocialConnection(stateRow.org_id, 'YouTube', {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token
    });

    res.redirect(`/?social_connected=YouTube&org_id=${stateRow.org_id}`);
  } catch (err) {
    res.redirect(`/?social_error=${encodeURIComponent(err.message)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. LINKEDIN
// ════════════════════════════════════════════════════════════════════════════
router.get('/auth/linkedin', withOrg, (req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  saveOAuthState(state, req.orgId, 'linkedin');

  const redirectUri = process.env.LINKEDIN_REDIRECT_URI || `http://${req.get('host')}/social/auth/linkedin/callback`;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.LINKEDIN_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
    scope: 'r_organization_social_analytics r_liteprofile'
  });

  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params}`);
});

router.get('/auth/linkedin/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.redirect(`/?social_error=${encodeURIComponent(error_description || error)}`);

  const stateRow = consumeOAuthState(state);
  if (!stateRow || stateRow.provider !== 'linkedin') {
    return res.redirect('/?social_error=Invalid_state_token');
  }

  try {
    const redirectUri = process.env.LINKEDIN_REDIRECT_URI || `http://${req.get('host')}/social/auth/linkedin/callback`;
    const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET
      })
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description);

    saveSocialConnection(stateRow.org_id, 'LinkedIn', {
      access_token: tokenData.access_token
    });

    res.redirect(`/?social_connected=LinkedIn&org_id=${stateRow.org_id}`);
  } catch (err) {
    res.redirect(`/?social_error=${encodeURIComponent(err.message)}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. TWITTER / X (App-only / Bearer Token style)
// ════════════════════════════════════════════════════════════════════════════
router.post('/connect/twitter', withOrg, async (req, res) => {
  const { handle } = req.body;
  if (!handle) return res.status(400).json({ error: 'Twitter handle required' });

  if (!process.env.TWITTER_BEARER_TOKEN) {
    return res.status(400).json({ error: 'TWITTER_BEARER_TOKEN not configured in backend.' });
  }

  try {
    // Verify it works right away
    await getTwitterMetrics(handle, process.env.TWITTER_BEARER_TOKEN);

    saveSocialConnection(req.orgId, 'Twitter/X', {
      username: handle,
      access_token: process.env.TWITTER_BEARER_TOKEN // we just store the global bearer for this row or we can just read from env
    });

    res.json({ success: true, message: 'Twitter connected successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DISCONNECT
// ════════════════════════════════════════════════════════════════════════════
router.post('/disconnect', withOrg, (req, res) => {
  const { platform } = req.body;
  deleteSocialConnection(req.orgId, platform);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════
// LIVE METRICS FETCH (The big one)
// ════════════════════════════════════════════════════════════════════════════
router.post('/metrics', withOrg, async (req, res) => {
  const connections = getSocialConnections(req.orgId);
  const platforms = [];

  const promises = connections.map(async (conn) => {
    try {
      let metrics;
      if (conn.platform === 'Facebook') {
        metrics = await getFacebookPageMetrics(conn.page_id, conn.access_token);
      } else if (conn.platform === 'Instagram') {
        metrics = await getInstagramMetrics(conn.page_id, conn.access_token);
      } else if (conn.platform === 'YouTube') {
        metrics = await getYouTubeMetrics(conn.access_token);
      } else if (conn.platform === 'Twitter/X') {
        // We can use the connection's stored username and backend's bearer token
        metrics = await getTwitterMetrics(conn.username, process.env.TWITTER_BEARER_TOKEN || conn.access_token);
      } else if (conn.platform === 'LinkedIn') {
        // If we don't have the org URN we might need it from the connection or just return dummy for now
        // LinkedIn API requires an organization URN, normally obtained during auth
        metrics = { followers: 0, posts_30d: 0, avg_reach: 0, engagement: 0 }; 
      }

      if (metrics) {
        saveSocialMetricsHistory(req.orgId, conn.platform, metrics);
        platforms.push({ platform: conn.platform, connected: true, ...metrics });
      }
    } catch (err) {
      console.error(`Error fetching ${conn.platform}:`, err.message);
      platforms.push({ platform: conn.platform, connected: true, error: err.message });
    }
  });

  await Promise.allSettled(promises);

  // Add unconnected platforms so the UI knows they exist
  const supported = ['Facebook', 'Instagram', 'YouTube', 'LinkedIn', 'Twitter/X'];
  supported.forEach(p => {
    if (!platforms.find(x => x.platform === p)) {
      platforms.push({ platform: p, connected: false, followers: 0 });
    }
  });

  // Get historical data for the chart (last 30 days)
  const history = getSocialMetricsHistory(req.orgId, null, 30);

  res.json({ success: true, platforms, history });
});

module.exports = router;
