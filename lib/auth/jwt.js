/**
 * Verify the shared LeadPilot backend's HS256 JWT.
 *
 * The FastAPI backend (leadpilot-backend) is the sole identity provider for the
 * whole product — web portals + Flutter app all authenticate there. Its tokens
 * are HS256-signed with JWT_SECRET_KEY and carry: sub (user id), org_id, role
 * (founder | ad_manager | telecaller). The Ad Manager portal verifies that same
 * token and scopes every request by org_id in code (app-layer tenancy).
 */
const jwt = require('jsonwebtoken');

function verifyToken(token) {
  const secret = process.env.JWT_SECRET_KEY;
  if (!secret) throw new Error('JWT_SECRET_KEY not set');
  const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
  return { userId: claims.sub, orgId: claims.org_id, role: claims.role, raw: claims };
}

/**
 * Express middleware. Pass allowedRoles (e.g. ['founder','ad_manager']) to gate
 * by role; omit to allow any authenticated user. Attaches req.auth on success.
 */
function requireAuth(allowedRoles = null) {
  return (req, res, next) => {
    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing bearer token' });

    let auth;
    try {
      auth = verifyToken(m[1]);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (!auth.orgId) return res.status(401).json({ error: 'Token missing org_id' });
    if (allowedRoles && !allowedRoles.includes(auth.role)) {
      return res.status(403).json({ error: `Role '${auth.role}' not permitted` });
    }

    req.auth = auth;
    next();
  };
}

module.exports = { verifyToken, requireAuth };
