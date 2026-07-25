/**
 * Ad-platform connection storage on Supabase (replaces the old SQLite path).
 * OAuth CSRF state + per-org Meta tokens (encrypted at rest via crypto.js).
 */
const crypto = require('crypto');
const { getServiceClient } = require('./supabase');
const { encrypt, decrypt } = require('./crypto');

const sb = () => getServiceClient();
const OAUTH_TTL_MS = 15 * 60 * 1000;

async function newOAuthState(orgId, provider) {
  const state = crypto.randomBytes(24).toString('hex');
  const { error } = await sb().from('oauth_states').insert({ state, org_id: orgId, provider });
  if (error) throw new Error(error.message);
  return state;
}

async function consumeOAuthState(state) {
  const { data } = await sb().from('oauth_states').select('*').eq('state', state).maybeSingle();
  if (data) await sb().from('oauth_states').delete().eq('state', state);
  if (!data) return null;
  const age = Date.now() - new Date(data.created_at).getTime();
  if (Number.isFinite(age) && age > OAUTH_TTL_MS) return null;
  return data;
}

async function saveMetaConnection(orgId, { access_token, ad_account_id, page_id, scope, expires_at }) {
  const { error } = await sb().from('meta_connections').upsert({
    org_id: orgId,
    access_token: encrypt(access_token),
    ad_account_id, page_id, scope, expires_at,
    connected_at: new Date().toISOString(),
  }, { onConflict: 'org_id' });
  if (error) throw new Error(error.message);
}

async function getMetaConnection(orgId) {
  const { data } = await sb().from('meta_connections').select('*').eq('org_id', orgId).maybeSingle();
  if (data) data.access_token = decrypt(data.access_token);
  return data;
}

// Re-exchange the stored long-lived token for a fresh one (Meta tokens expire ~60d).
async function refreshMetaToken(orgId) {
  const conn = await getMetaConnection(orgId);
  if (!conn) return null;
  const res = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' + new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: conn.access_token,
  }));
  const d = await res.json();
  if (d.error || !d.access_token) throw new Error(`Meta token refresh failed: ${d.error?.message || 'no token'}`);
  const expiresAt = d.expires_in ? new Date(Date.now() + d.expires_in * 1000).toISOString() : null;
  await saveMetaConnection(orgId, {
    access_token: d.access_token, ad_account_id: conn.ad_account_id,
    page_id: conn.page_id, scope: conn.scope, expires_at: expiresAt,
  });
  return { refreshed: true, expires_at: expiresAt };
}

// Connection with a transparent refresh when within 7 days of expiry.
async function getValidMetaConnection(orgId) {
  const conn = await getMetaConnection(orgId);
  if (!conn) return null;
  if (conn.expires_at) {
    const msLeft = new Date(conn.expires_at).getTime() - Date.now();
    if (msLeft < 7 * 24 * 60 * 60 * 1000) {
      try { await refreshMetaToken(orgId); return await getMetaConnection(orgId); } catch { /* keep current */ }
    }
  }
  return conn;
}

module.exports = {
  newOAuthState, consumeOAuthState, saveMetaConnection,
  getMetaConnection, refreshMetaToken, getValidMetaConnection,
};
