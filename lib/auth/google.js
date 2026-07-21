const crypto = require('crypto');
const { saveOAuthState, consumeOAuthState, saveGoogleConnection, getGoogleConnection } = require('../db');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';

// Scopes needed for Google Ads
const SCOPES = [
  'https://www.googleapis.com/auth/adwords',
].join(' ');

// Step 1: Redirect user to Google login
function startGoogleOAuth(req, res) {
  const orgId = req.query.org_id || req.session.orgId;
  if (!orgId) {
    return res.status(400).json({ error: 'org_id required' });
  }

  const state = crypto.randomBytes(24).toString('hex');
  saveOAuthState(state, orgId, 'google');

  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',  // get refresh token
    prompt:        'consent',  // always show consent to get refresh token
    state,
  });

  console.log(`[google-oauth] redirecting org=${orgId} to Google OAuth`);
  res.redirect(`${GOOGLE_AUTH_URL}?${params}`);
}

// Step 2: Google redirects back
async function handleGoogleCallback(req, res) {
  const { code, state, error } = req.query;

  if (error) {
    console.error(`[google-oauth] error: ${error}`);
    return res.redirect(`/?google_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  const stateRow = consumeOAuthState(state);
  if (!stateRow || stateRow.provider !== 'google') {
    return res.status(400).json({ error: 'Invalid state token' });
  }

  const { org_id: orgId } = stateRow;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error);
    }

    const { access_token, refresh_token, expires_in } = tokenData;
    const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000).toISOString();

    // Save — customer_id will be updated when first API call is made
    saveGoogleConnection(orgId, access_token, refresh_token, null, expiresAt);

    console.log(`[google-oauth] org=${orgId} connected to Google Ads`);
    res.redirect(`/?google_connected=1&org_id=${orgId}`);
  } catch (err) {
    console.error('[google-oauth] failed:', err.message);
    res.redirect(`/?google_error=${encodeURIComponent(err.message)}`);
  }
}

// Refresh Google access token using refresh token
async function refreshGoogleToken(orgId) {
  const conn = getGoogleConnection(orgId);
  if (!conn) throw new Error(`Org ${orgId} has no Google connection`);

  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
      grant_type:    'refresh_token',
    }),
  });

  const data = await tokenRes.json();
  if (data.error) throw new Error(data.error_description || data.error);

  const expiresAt = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  saveGoogleConnection(orgId, data.access_token, conn.refresh_token, conn.customer_id, expiresAt);

  return data.access_token;
}

function requireGoogleToken(orgId) {
  const conn = getGoogleConnection(orgId);
  if (!conn) {
    throw new Error(`Organisation ${orgId} has not connected their Google Ads account.`);
  }
  return conn;
}

module.exports = { startGoogleOAuth, handleGoogleCallback, refreshGoogleToken, requireGoogleToken };
