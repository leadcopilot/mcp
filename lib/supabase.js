/**
 * Supabase clients.
 * - getServiceClient(): server-trusted, bypasses RLS. Webhooks + background jobs ONLY.
 * - getUserClient(jwt): carries the end-user's JWT so Postgres RLS applies. All /api work.
 */
const { createClient } = require('@supabase/supabase-js');

const URL = () => process.env.SUPABASE_URL;

let serviceClient;
function getServiceClient() {
  if (serviceClient) return serviceClient;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL() || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  serviceClient = createClient(URL(), key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return serviceClient;
}

function getUserClient(accessToken) {
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!URL() || !anon) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  return createClient(URL(), anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
  });
}

function isConfigured() {
  return !!(URL() && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

module.exports = { getServiceClient, getUserClient, isConfigured };
