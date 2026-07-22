import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const SECRET = 'test-secret-at-least-16-chars-long';
process.env.JWT_SECRET_KEY = SECRET;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes/portal.js'));
  return app;
}
const token = (role, org = 'org1') => jwt.sign({ sub: 'u1', org_id: org, role }, SECRET, { algorithm: 'HS256' });

describe('portal router — auth gating & validation', () => {
  const app = makeApp();

  it('401 without a token', async () => {
    const r = await request(app).get('/api/org/profile');
    expect(r.status).toBe(401);
  });

  it('403 for a telecaller (wrong role)', async () => {
    const r = await request(app).get('/api/org/profile').set('Authorization', `Bearer ${token('telecaller')}`);
    expect(r.status).toBe(403);
  });

  it('400 when ai-analyst query is missing', async () => {
    const r = await request(app).post('/api/ai-analyst').set('Authorization', `Bearer ${token('ad_manager')}`).send({});
    expect(r.status).toBe(400);
  });

  it('400 when keyword seed is missing', async () => {
    const r = await request(app).post('/api/keywords/research').set('Authorization', `Bearer ${token('ad_manager')}`).send({});
    expect(r.status).toBe(400);
  });

  it('connections/status returns the expected shape for an authed user', async () => {
    const r = await request(app).get('/api/connections/status').set('Authorization', `Bearer ${token('founder')}`);
    expect(r.status).toBe(200);
    expect(r.body.meta).toHaveProperty('connected');
    expect(r.body.google).toHaveProperty('connected');
  });
});
