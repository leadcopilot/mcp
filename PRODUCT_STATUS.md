# LeadPilot Ad Manager — Product Status vs Spec + Your Setup Guide

Assessed against `LeadPilot_AdManagerPortal_Spec-1.docx` (v2.0). Branch `main` in `D:\Ad_Manager-main`.

---

## 1. Spec compliance — section by section

| Spec § | Feature | Status | Where / what's needed |
|---|---|---|---|
| §3 | **Org & Business Profile** (knowledge base) | ✅ **Done** | Reads shared `organizations` (services, pricing, competitors, brand voice, USPs) — `lib/org.js`, `GET /api/org/profile` |
| §4 | **Research by Simple Chat** (AI Analyst) | ✅ **Done** | `POST /api/ai-analyst` — Gemini function-calling over web search + scrape + 15 Meta read tools, grounded in org profile |
| §5 | **Ad Copy Creation** | ✅ **Done** | `POST /api/copy/generate` — grounded, zero-hallucination (live-verified on Personiks) |
| §5 | **Direct push to Meta** | ✅ **Live-verified** | Endpoints built + **verified against a real connected ad account** (`act_3183801585260453`); each org connects its own account via `/api/connections/meta/start` |
| §6 | **Meta Ads tool reference** | ✅ **Done** | 27 direct Graph tools (Tier 1) + the **134-tool `@mikusnuz/meta-ads-mcp` server (Tier 2)** — the full Meta Marketing API surface — vendored & wired per-org (`/api/meta-mcp/*`), live-verified against the real account |
| §7 | **Unified Command Dashboard** | ✅ **Done** | `GET /api/dashboard/summary` — leads + telecaller call-quality + ads (when connected) |
| §8 | **Monthly Reporting** | ✅ **Done** | `GET /api/reports/monthly` — AI-generated, grounded (live-verified) |
| §9 | **Smart Alerts & ROI Monitor Agent** | ✅ **Built** | Always-on scheduler + persisted `ad_alerts` + `GET /api/alerts`; lead-volume/quality triggers live, CPL/budget triggers attach on Meta connect |
| §10 | **Social Media Engagement** | 🟡 **FB/IG live** | Facebook + Instagram metrics live via the Meta token (`/api/social/metrics`); YouTube/LinkedIn/Twitter built but need their own OAuth apps; unified inbox/replies still to build |
| §11 | **Cross-Portal Data Flow** | ✅ **Built** | Shared DB (org/user/leads); call-quality read; **attribution columns added** (`source_campaign`/`source_ad_id`/`meta_lead_id`/`platform`) + wired into `addLead`. ⚠️ Backend team: add these to the SQLAlchemy `Lead` model so Alembic autogenerate keeps them |
| — | Leads / Competitors / Keyword research | ✅ **Done** | `/api/leads/*`, `/api/competitors/*`, `/api/keywords/research` |

**Score:** the two "most important deliverables" per the spec are the **Monthly Report (✅ done)** and the **ROI Monitor Agent (⛔ not built)**. Everything AI + data + dashboard + reporting is done; the Meta-live and always-on-agent and social pieces remain.

---

## 2. Will the frontend have to rework because of the 135 tools / pending items? **NO.**

- The frontend builds against **`docs/FRONTEND_API.md`** — a **stable contract** (URLs + JSON shapes).
- Pending items (ROI alerts, social, full Meta data) **ADD new endpoints**; they do **not** change existing ones.
- **Proof:** I already swapped Leads from SQLite→Supabase and migrated Meta onto the integrated stack — the contract shapes never changed.
- The "135 tools" are **never** called by the frontend directly — they run **inside** `/api/ai-analyst`. So the frontend has one endpoint (`/api/ai-analyst`) regardless of whether it's 15, 27, or 135 tools behind it. **Zero rework.**

---

## 3. What YOU need to do — step by step, in order

### Step 1 — Gemini (make AI reliable)
- Today it runs on your free `AIza` key + `gemini-flash-latest` (works, but 503s under load).
- **To make it production-smooth:** enable billing on one Gemini project at **aistudio.google.com → Billing**, then put that key in `.env` `GEMINI_API_KEYS`. (Optional — free key works for testing.)

### Step 2 — Shared login secret (`JWT_SECRET_KEY`)
- The Ad Manager must verify the **same** JWT the FastAPI backend issues.
- Generate one: `python -c "import secrets; print(secrets.token_hex(32))"`
- Put the **identical value** in **both** `.env` files: the FastAPI backend's and `D:\Ad_Manager-main\.env`.
- Until then, login is shared only if the secrets match.

### Step 3 — Meta app (one-time, ~30 min) — at developers.facebook.com → your app `2013485862872973`
1. Add products: **Facebook Login** + **Marketing API**.
2. **Facebook Login → Settings → Valid OAuth Redirect URIs:** add `http://localhost:3001/auth/meta/callback`.
3. **App Roles → Roles:** add your **dummy Meta account** as **Admin** or **Tester**.
4. Make sure that dummy account has: an **Ad Account** (business.facebook.com) **and** a **Facebook Page** (Pages need it to build creatives).
5. Keep the app in **Development mode** (fine for your own/dummy account).

### Step 4 — Connect the Meta account (the browser click I can't do)
1. Run the backend: `cd D:\Ad_Manager-main\Ad_Manager-main && npm start`
2. Get a JWT (from the backend login, or I generate a dev one).
3. Call `GET http://localhost:3001/api/connections/meta/start` with that token → it returns an `auth_url`.
4. **Open `auth_url` in your browser** → approve the permissions.
5. It redirects to `/auth/meta/callback` → token stored (encrypted) in Supabase.
6. Now `POST /api/campaigns/list` returns your real campaigns. ✅

### Step 5 — Supabase
- ✅ Nothing to do — connected, migrated, verified.

### Step 6 — Production (later)
- **Meta App Review + Business Verification** — required to manage *clients'* ad accounts (not your own). Meta's timeline: days–weeks. Start it when you onboard the first real client.
- **Real keyword search volumes (optional):** buy Google Ads API or DataForSEO access — today volumes are AI-*estimated* (labelled `"estimated": true`).

### Step 7 — Social accounts (when the social module lands)
- You'll OAuth-connect Facebook/Instagram/YouTube/LinkedIn/X in the browser (same pattern as Meta).

---

## 4. What's left for ME to build (no ambiguity)

| # | Item | Needs your browser step? | Notes |
|---|---|---|---|
| 1 | ✅ **Deep-research** Mistral→Gemini | done | **Done** — Python Gemini chat + embeddings verified; **removes the last paid API** |
| 2 | **Social module** (OAuth connect + metrics + inbox) | ✅ yes (to test) | Build code; you set up LinkedIn/Twitter/Google OAuth apps + connect |
| 3 | ✅ **ROI Monitor Agent** (§9) | done | **Done** — always-on scheduler + persisted alerts; CPL/budget triggers attach on Meta connect |
| 4 | ✅ **Campaign→lead attribution columns** (§11) | done | **Done** — columns added + wired; backend team should mirror in the Lead model |
| 5 | 🟡 **Social module** (§10) | partial | **FB/IG live**; YouTube/LinkedIn/Twitter need OAuth apps you create; inbox/replies to build |
| 6 | ✅ **Meta MCP (Tier 2)** | done | **Done** — `@mikusnuz/meta-ads-mcp` (134 tools) vendored + wired + live-verified |
| 7 | ✅ **Meta live execution** (§5/§6) | done | **Connected + verified live** on `act_3183801585260453` — campaigns/insights/account all working |

> **No paid APIs remain.** The whole system runs on Gemini (free-tier key) + Supabase + Groq/DuckDuckGo fallbacks. Mistral (the last paid dependency) is gone.
> *Note:* existing `rag_store/*.json` were embedded with Mistral (1024-dim); re-run Deep Research per company to re-embed with Gemini (3072-dim).

---

## 5. Which doc goes to whom
- **Frontend dev →** `docs/FRONTEND_API.md` (contract + quick-start). **Only this.**
- **Whoever runs/deploys →** `HANDOFF.md` (setup, config, run).
- **You / product →** this file (`PRODUCT_STATUS.md`).
- **Architecture/decisions →** `docs/superpowers/specs/2026-07-21-…-design.md`.
