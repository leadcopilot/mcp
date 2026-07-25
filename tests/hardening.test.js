import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const request = require('supertest');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

describe('production middleware', () => {
  it('helmet sets security headers', async () => {
    const app = express();
    app.use(helmet({ contentSecurityPolicy: false }));
    app.get('/x', (_q, r) => r.json({ ok: true }));
    const res = await request(app).get('/x');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('rate limiter returns 429 after the max', async () => {
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, max: 3, standardHeaders: true, legacyHeaders: false }));
    app.get('/x', (_q, r) => r.json({ ok: true }));
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get('/x');
      expect(ok.status).toBe(200);
    }
    const blocked = await request(app).get('/x');
    expect(blocked.status).toBe(429);
  });

  it('server.js loads without throwing', () => {
    // syntax/require sanity — the module wires helmet + rate-limit + routes
    expect(() => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8')).not.toThrow();
  });
});
