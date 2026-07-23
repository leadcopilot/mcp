/**
 * Integrated Meta OAuth (Supabase-backed). The frontend calls
 * GET /api/connections/meta/start (authed) to get an auth URL, redirects the user
 * to Facebook, and Meta redirects back to /auth/meta/callback (this handler).
 */
const { newOAuthState, consumeOAuthState, saveMetaConnection } = require('../connections');

const META_GRAPH = 'https://graph.facebook.com/v19.0';
// Core dev-mode scopes only. `leads_retrieval`/`business_management` are advanced
// perms that error ("Invalid Scopes") until app-reviewed — add later via META_SCOPES.
const SCOPES = process.env.META_SCOPES
  || ['ads_read', 'ads_management', 'pages_show_list', 'pages_read_engagement'].join(',');

async function buildMetaAuthUrl(orgId) {
  const state = await newOAuthState(orgId, 'meta');
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: process.env.META_REDIRECT_URI,
    scope: SCOPES,
    response_type: 'code',
    state,
  });
  return `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
}

async function handleMetaCallback(req, res) {
  const { code, state, error, error_description } = req.query;
  if (error) return res.redirect(`/?meta_error=${encodeURIComponent(error_description || error)}`);
  if (!code || !state) return res.status(400).json({ error: 'Missing code or state from Meta' });

  const stateRow = await consumeOAuthState(state);
  if (!stateRow || stateRow.provider !== 'meta') {
    return res.status(400).json({ error: 'Invalid or expired state (possible CSRF)' });
  }
  const orgId = stateRow.org_id;

  try {
    const tokenData = await (await fetch(`${META_GRAPH}/oauth/access_token?` + new URLSearchParams({
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: process.env.META_REDIRECT_URI,
      code,
    }))).json();
    if (tokenData.error) throw new Error(tokenData.error.message);

    const longData = await (await fetch(`${META_GRAPH}/oauth/access_token?` + new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: tokenData.access_token,
    }))).json();
    if (longData.error || !longData.access_token) {
      throw new Error(`Long-lived token exchange failed: ${longData.error?.message || 'no access_token'}`);
    }
    const finalToken = longData.access_token;
    const expiresAt = longData.expires_in ? new Date(Date.now() + longData.expires_in * 1000).toISOString() : null;

    const accts = await (await fetch(`${META_GRAPH}/me/adaccounts?fields=id,name,account_status&access_token=${finalToken}`)).json();
    if (accts.error) throw new Error(`Could not read ad accounts: ${accts.error.message}`);
    const adAccountId = accts.data?.[0]?.id || null;

    await saveMetaConnection(orgId, { access_token: finalToken, ad_account_id: adAccountId, scope: SCOPES, expires_at: expiresAt });
    res.redirect(`/?meta_connected=1&ad_account=${adAccountId || ''}`);
  } catch (err) {
    res.redirect(`/?meta_error=${encodeURIComponent(err.message)}`);
  }
}

module.exports = { buildMetaAuthUrl, handleMetaCallback, SCOPES };
