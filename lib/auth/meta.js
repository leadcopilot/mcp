const crypto = require('crypto');
const { saveOAuthState, consumeOAuthState, saveMetaConnection, getMetaConnection } = require('../db');

const META_GRAPH = 'https://graph.facebook.com/v19.0';

// Permissions LeadPilot needs from Meta
// ads_read + ads_management = read and manage campaigns
// leads_retrieval = download lead form submissions
// pages_read_engagement = read page data for Social Hub
const SCOPES = [
  'ads_read',
  'ads_management',
  'leads_retrieval',
  'pages_read_engagement',
  'pages_show_list',
  'business_management',
].join(',');

// Step 1: Redirect user to Meta login
function startMetaOAuth(req, res) {
  const orgId = req.query.org_id || req.session.orgId;
  if (!orgId) {
    return res.status(400).json({ error: 'org_id required. Pass ?org_id=your_org_id' });
  }

  // State token prevents CSRF
  const state = crypto.randomBytes(24).toString('hex');
  saveOAuthState(state, orgId, 'meta');

  const params = new URLSearchParams({
    client_id:     process.env.META_APP_ID,
    redirect_uri:  process.env.META_REDIRECT_URI,
    scope:         SCOPES,
    response_type: 'code',
    state,
  });

  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
  console.log(`[meta-oauth] redirecting org=${orgId} to Meta OAuth`);
  res.redirect(authUrl);
}

// Step 2: Meta redirects back with ?code=xxx&state=xxx
async function handleMetaCallback(req, res) {
  const { code, state, error, error_description } = req.query;

  if (error) {
    console.error(`[meta-oauth] error from Meta: ${error} — ${error_description}`);
    return res.redirect(`/?meta_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state from Meta callback' });
  }

  // Verify state — prevents CSRF
  const stateRow = consumeOAuthState(state);
  if (!stateRow || stateRow.provider !== 'meta') {
    console.error('[meta-oauth] invalid or expired state token');
    return res.status(400).json({ error: 'Invalid state. Possible CSRF attempt.' });
  }

  const { org_id: orgId } = stateRow;

  try {
    // Exchange code for access token
    const tokenRes = await fetch(`${META_GRAPH}/oauth/access_token?` + new URLSearchParams({
      client_id:     process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri:  process.env.META_REDIRECT_URI,
      code,
    }));

    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      throw new Error(tokenData.error.message);
    }

    const shortToken = tokenData.access_token;

    // Exchange for long-lived token (60 days)
    const longTokenRes = await fetch(`${META_GRAPH}/oauth/access_token?` + new URLSearchParams({
      grant_type:        'fb_exchange_token',
      client_id:         process.env.META_APP_ID,
      client_secret:     process.env.META_APP_SECRET,
      fb_exchange_token: shortToken,
    }));

    const longTokenData = await longTokenRes.json();
    // If the long-lived exchange failed, don't silently persist a ~1h short token
    // as if it were permanent — surface it so the user reconnects.
    if (longTokenData.error || !longTokenData.access_token) {
      throw new Error(
        `Long-lived token exchange failed: ${longTokenData.error?.message || 'no access_token returned'}`
      );
    }
    const finalToken = longTokenData.access_token;
    const expiresIn  = longTokenData.expires_in;
    const expiresAt  = expiresIn
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : null;

    // Fetch the user's ad accounts so we can store the first one
    const adAccountsRes = await fetch(
      `${META_GRAPH}/me/adaccounts?fields=id,name,account_status&access_token=${finalToken}`
    );
    const adAccountsData = await adAccountsRes.json();
    if (adAccountsData.error) {
      throw new Error(`Could not read ad accounts: ${adAccountsData.error.message}`);
    }
    const firstAdAccount = adAccountsData.data?.[0];
    const adAccountId = firstAdAccount?.id || null; // already in act_XXXX format
    if (!adAccountId) {
      console.warn(`[meta-oauth] org=${orgId} connected but has no ad accounts`);
    }

    // Save to DB
    saveMetaConnection(orgId, finalToken, adAccountId, SCOPES, expiresAt);

    console.log(`[meta-oauth] org=${orgId} connected. ad_account=${adAccountId}`);

    // Redirect back to UI with success
    res.redirect(`/?meta_connected=1&org_id=${orgId}&ad_account=${adAccountId || ''}`);
  } catch (err) {
    console.error('[meta-oauth] token exchange failed:', err.message);
    res.redirect(`/?meta_error=${encodeURIComponent(err.message)}`);
  }
}

// Helper: get a valid Meta token for an org — fails clearly if not connected
function requireMetaToken(orgId) {
  const conn = getMetaConnection(orgId);
  if (!conn) {
    throw new Error(`Organisation ${orgId} has not connected their Meta account. Visit /auth/meta?org_id=${orgId}`);
  }
  return { token: conn.access_token, adAccountId: conn.ad_account_id };
}

module.exports = { startMetaOAuth, handleMetaCallback, requireMetaToken };
