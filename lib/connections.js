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

module.exports = { newOAuthState, consumeOAuthState, saveMetaConnection, getMetaConnection };
