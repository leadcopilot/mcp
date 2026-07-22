import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const SECRET = 'test-secret-at-least-16-chars-long';
process.env.JWT_SECRET_KEY = SECRET;
const { verifyToken, requireAuth } = require('../lib/auth/jwt.js');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

describe('jwt auth', () => {
  it('verifies a valid backend token and maps claims', () => {
    const token = jwt.sign({ sub: 'u1', org_id: 'org1', role: 'ad_manager' }, SECRET, { algorithm: 'HS256' });
    expect(verifyToken(token)).toMatchObject({ userId: 'u1', orgId: 'org1', role: 'ad_manager' });
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = jwt.sign({ sub: 'u1', org_id: 'org1', role: 'ad_manager' }, 'wrong-secret', { algorithm: 'HS256' });
    expect(() => verifyToken(token)).toThrow();
  });

  it('401s without a bearer token', () => {
    const res = mockRes();
    requireAuth()({ headers: {} }, res, () => { throw new Error('next should not run'); });
    expect(res.statusCode).toBe(401);
  });

  it('403s when the role is not allowed', () => {
    const token = jwt.sign({ sub: 'u1', org_id: 'org1', role: 'telecaller' }, SECRET, { algorithm: 'HS256' });
    const res = mockRes();
    requireAuth(['ad_manager', 'founder'])({ headers: { authorization: `Bearer ${token}` } }, res, () => { throw new Error('next should not run'); });
    expect(res.statusCode).toBe(403);
  });

  it('calls next and sets req.auth for an allowed role', () => {
    const token = jwt.sign({ sub: 'u1', org_id: 'org1', role: 'founder' }, SECRET, { algorithm: 'HS256' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    let called = false;
    requireAuth(['ad_manager', 'founder'])(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.auth.orgId).toBe('org1');
  });
});
