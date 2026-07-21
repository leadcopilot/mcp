/**
 * Per-org bearer-token authorization.
 *
 * Every org gets an `api_token` at creation (see db.createOrg). Data/action
 * requests must present it via `X-Org-Token`, `Authorization: Bearer <token>`,
 * or an `org_token` body/query field (the query form exists for the OAuth
 * redirect flows, which are plain browser navigations and cannot set headers).
 *
 * This is a pragmatic multi-tenant gate, not full user auth/RBAC — it stops an
 * unauthenticated caller from reading another org's data or spending its ad
 * budget. Full per-user login/RBAC is a separate, larger piece of work.
 */

const { safeEqual } = require('./crypto');

function extractToken(req) {
  const h = req.headers['x-org-token'];
  if (h) return h;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return req.body?.org_token || req.query?.org_token || null;
}

function checkOrgToken(req, org) {
  if (!org || !org.api_token) return false;
  const provided = extractToken(req);
  return provided ? safeEqual(provided, org.api_token) : false;
}

module.exports = { extractToken, checkOrgToken };
