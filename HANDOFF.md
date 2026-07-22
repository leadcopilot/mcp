# LeadPilot Ad Manager Portal — Backend (FINAL / handoff)

**This folder is the canonical deliverable.** Branch: `main`. Give **this** repo to the team.
(The other folder, `Ad_Manager-developer`, is an older divergent copy — do NOT use it.)

---

## What this is
The Ad Manager Portal backend — the **3rd portal** of LeadPilot, integrated onto the **shared Supabase database** and the shared FastAPI backend's **auth** (HS256 JWT). Node/Express + a Python research sidecar. AI runs on **Gemini** (free/keyed).

## ✅ Working & tested (live-verified)
- **Supabase Postgres** connection + migrations (`supabase/migrations/`), reconciled with the existing telecaller/founder tables (their data untouched).
- **Auth** — verifies the shared backend's HS256 JWT (`lib/auth/jwt.js`), scopes by `org_id`, gates by role (`founder`/`ad_manager`).
- **Gemini** client mirroring the backend (`lib/ai/geminiClient.js`) — text, JSON, and **function-calling** all validated live.
- **Org knowledge base** read from shared `organizations` (`lib/org.js`).
- **AI ad-copy generation** (`lib/ai/adCopy.js`) — grounded, zero-hallucination, live-verified on real org data.
- **AI keyword research** (`lib/ai/keywords.js`) and **AI Analyst chat** (`lib/ai/analyst.js`).
- **Integrated API** (`routes/portal.js`) — auth-gated: `GET /api/org/profile`, `POST /api/copy/generate`, `POST /api/keywords/research`, `POST /api/ai-analyst`, `GET /api/connections/status`, `GET /health`.
- **23 tests** (`npm test`).

## 🟡 / ⛔ Pending (not yet integrated)
- **Meta tool execution** (campaigns/insights/creator + the ~135-tool catalog) — App ID/Secret are set; the Graph/MCP router + OAuth-to-Supabase wiring is **not built yet**. Meta runs dev-mode (own account only; clients need Meta App Review).
- **Legacy routes** (`routes/api.js`, `auth.js`, `research.js`, `social.js`) still run on the **old local SQLite `lib/db.js` + old Gemini SDK** — leads, competitors, meta-creator, deep-research. Being migrated to Supabase/Gemini.
- Dashboard, ROI-monitor agent, monthly report, social module — **spec'd, not built** (see `docs/superpowers/specs/`).

## Run it
```bash
npm install
npx playwright install chromium      # for scraping (optional)
npm start                            # http://localhost:3001
npm test                             # vitest
```

## Required config (`.env`, gitignored — see `.env.example`)
| Var | Note |
|---|---|
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_DB_URL` | shared project `otbdjrexiscbxqlcnnvx` |
| `GEMINI_API_KEYS` / `GEMINI_MODEL` | use a **credited** key; `gemini-flash-latest` works (3.5-flash is often 503-overloaded) |
| `JWT_SECRET_KEY` | **MUST equal the FastAPI backend's** `JWT_SECRET_KEY` for shared login |
| `META_APP_ID` / `META_APP_SECRET` | set (dev mode) |

## For the frontend developer
See **`docs/FRONTEND_API.md`** — the full API + feature contract (auth, every endpoint's request/response, per-endpoint status). The frontend can build against it now.

## Design docs
- `docs/superpowers/specs/2026-07-21-admanager-phase1-supabase-gemini-design.md` — architecture + the integration pivot (§1a).
- `ARCHITECTURE.md`, `META_INTEGRATION.md`, `BLOCKERS.md` — prior context.
