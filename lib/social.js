/**
 * Social Media Hub (spec §10). Facebook + Instagram metrics come from the org's
 * already-connected Meta token (pages_show_list + pages_read_engagement scopes).
 * YouTube/LinkedIn/Twitter read stored social_connections — each needs its own
 * OAuth app (client id/secret) before it can be connected.
 */
const { getMetaConnection } = require('./connections');
const { getServiceClient } = require('./supabase');
const svc = require('./services/social');

async function getSocialMetrics(orgId) {
  const out = { facebook: [], instagram: [], youtube: null, linkedin: null, twitter: null, notes: {} };

  const meta = await getMetaConnection(orgId);
  if (!meta) {
    out.notes.facebook = 'Connect Meta to see Facebook/Instagram metrics.';
  } else {
    try {
      const pages = await svc.getFacebookPages(meta.access_token);
      if (!pages || !pages.length) out.notes.facebook = 'No Facebook Pages on this account.';
      for (const p of pages || []) {
        try {
          out.facebook.push({ page: p.name, ...(await svc.getFacebookPageMetrics(p.id, p.access_token)) });
        } catch (e) { out.notes.facebook = e.message; }
        try {
          const ig = await svc.getInstagramAccount(p.id, p.access_token);
          if (ig?.id) out.instagram.push({ page: p.name, ...(await svc.getInstagramMetrics(ig.id, p.access_token)) });
        } catch { /* no IG linked to this page */ }
      }
    } catch (e) {
      out.notes.facebook = e.message;
    }
  }

  // YouTube / LinkedIn / Twitter — from stored connections (need their own OAuth apps)
  const { data: conns } = await getServiceClient().from('social_connections').select('platform').eq('org_id', orgId);
  const connected = new Set((conns || []).map((c) => c.platform));
  for (const plat of ['youtube', 'linkedin', 'twitter']) {
    if (!connected.has(plat)) out.notes[plat] = `Connect ${plat} — requires a ${plat} OAuth app (client id/secret).`;
  }
  return out;
}

module.exports = { getSocialMetrics };
