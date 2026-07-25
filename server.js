require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const path    = require('path');
const helmet  = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const metaCallbackRoutes = require('./routes/metaCallback');
const portalRoutes = require('./routes/portal');
const apiRoutes  = require('./routes/api');
const socialRoutes = require('./routes/social');
const researchRoutes = require('./routes/research');
const { getDb }  = require('./lib/db');
const { checkHealth } = require('./lib/health');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false })); // CSP off: single-file UI uses inline scripts
app.use(cors({ origin: true, credentials: true }));

// Rate limiting (production hardening): a general cap on the API, a tighter cap on
// the AI/Meta endpoints (each call costs quota / spawns work). Disabled under test.
if (process.env.NODE_ENV !== 'test') {
  app.use('/api', rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false }));
}
// Capture the raw body so the Meta webhook can verify X-Hub-Signature-256.
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'leadpilot-local-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }, // 24 hours
}));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/auth', metaCallbackRoutes);   // integrated Meta callback (takes precedence)
app.use('/auth', authRoutes);
app.use('/api/research', researchRoutes);
app.use('/api',  portalRoutes);   // integrated, auth-gated (takes precedence)
app.use('/api',  apiRoutes);      // legacy prototype routes (being migrated)
app.use('/social', socialRoutes);

// Health check
app.get('/health', async (_req, res) => res.json(await checkHealth()));

// ─── Start ────────────────────────────────────────────────────────────────────

// Initialise database on startup
getDb();

// ─── ROI Monitor Agent — always-on background check (spec §9) ───────────────
const { runAllOrgs } = require('./lib/roiMonitor');
const { isConfigured } = require('./lib/supabase');
if (isConfigured()) {
  const ROI_INTERVAL_MS = Number(process.env.ROI_MONITOR_INTERVAL_MS) || 30 * 60 * 1000;
  setTimeout(() => runAllOrgs().catch((e) => console.error('[roi-monitor]', e.message)), 15000);
  setInterval(() => {
    runAllOrgs()
      .then((n) => n && console.log(`[roi-monitor] persisted ${n} new alert(s)`))
      .catch((e) => console.error('[roi-monitor]', e.message));
  }, ROI_INTERVAL_MS).unref();
}

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║      LeadPilot Ad Manager — v2 Local Server      ║');
  console.log(`║   Running at: http://localhost:${PORT}               ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('Modules:');
  console.log('  01  POST /api/keywords/research   — Keyword research table');
  console.log('  02  POST /api/copy/generate       — Structured ad copy');
  console.log('  03  POST /api/tracker/campaigns   — Campaign tracker + diagnostics');
  console.log('  04  POST /api/campaigns/create    — Meta Ads Creator wizard');
  console.log('  05  GET  /api/leads/list          — Lead scraper + dedup');
  console.log('  05  GET  /api/leads/export        — Excel export');
  console.log('  06  POST /api/social/metrics      — Social media hub');
  console.log('  07  POST /api/research/jobs/*     — Deep Research (report/leads/profile)');
  console.log('  07  POST /api/research/ask        — Deep Research RAG chat');
  console.log('');
  console.log('Infrastructure:');
  console.log('  POST /api/org/create              — Create organisation');
  console.log('  GET  /api/org/status              — Check connection status');
  console.log('  POST /api/org/enrich              — AI-powered website enrichment');
  console.log('  GET  /auth/meta                   — Connect Meta (OAuth)');
  console.log('  GET  /auth/google                 — Connect Google Ads (OAuth)');
  console.log('  POST /api/ai-analyst              — AI Analyst Chat');
  console.log('  POST /api/leads/webhook/meta      — Meta lead webhook receiver');
  console.log('  GET  /health                      — Health + Playwright check');
  console.log('');
});

