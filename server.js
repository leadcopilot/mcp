require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const path    = require('path');

const authRoutes = require('./routes/auth');
const apiRoutes  = require('./routes/api');
const socialRoutes = require('./routes/social');
const researchRoutes = require('./routes/research');
const { getDb }  = require('./lib/db');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors({ origin: true, credentials: true }));
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

app.use('/auth', authRoutes);
app.use('/api/research', researchRoutes);
app.use('/api',  apiRoutes);
app.use('/social', socialRoutes);

// Health check
app.get('/health', async (req, res) => {
  // Check if Playwright chromium browser binary is present
  let playwrightReady = false;
  try {
    const { chromium } = require('playwright');
    const execPath = chromium.executablePath();
    const fs = require('fs');
    playwrightReady = !!(execPath && fs.existsSync(execPath));
  } catch {}

  res.json({
    status: 'ok',
    time:   new Date().toISOString(),
    env: {
      gemini:     !!process.env.GEMINI_API_KEY,
      groq:       !!process.env.GROQ_API_KEY,
      meta:       !!(process.env.META_APP_ID && process.env.META_APP_SECRET),
      google:     !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_DEVELOPER_TOKEN),
      tavily:     !!process.env.TAVILY_API_KEY ? 'tavily' : 'duckduckgo',
      playwright: playwrightReady,
    },
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

// Initialise database on startup
getDb();

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

