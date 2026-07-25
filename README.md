# LeadPilot — Ad Manager Portal (Backend)

The Ad Manager portal of **LeadPilot** — the 3rd portal alongside Telecaller and Founder, integrated on one shared **Supabase** database and the shared FastAPI backend's auth. AI runs on **Gemini** (free-tier keyed). Node/Express API + a Python deep-research sidecar.

## What it does
- **Org knowledge base** — grounds every AI action in the business's real services/pricing/brand voice.
- **AI Analyst chat** — natural-language questions; the AI orchestrates web search, scraping, and Meta read tools.
- **Ad-copy generation** — grounded, zero-hallucination.
- **Keyword research** — AI-estimated volumes/CPC/intent.
- **Unified dashboard** — leads + telecaller call-quality + ad insights, with funnel / telecaller cross-reference / quality-trend drill-downs.
- **Auto monthly report** — AI-written, wasted-spend log included, exportable as a **shareable PDF**.
- **ROI Monitor Agent** — always-on alerts on lead-volume/quality (CPL/budget triggers on Meta connect).
- **Meta integration** — OAuth (auto-refreshing tokens) + **27 direct Graph tools** (Tier 1) **and the 134-tool `@mikusnuz/meta-ads-mcp` catalog** (Tier 2), per-org encrypted tokens.
- **Deep research** — per-company research + RAG chat (Gemini).
- **Leads / competitors / drift detection.**

## Tech stack
Node 24 · Express · Supabase (Postgres) · `@supabase/supabase-js` · Gemini (REST, key-rotated) · Meta Graph API v19 · Playwright · Vitest · Python + FastAPI (research sidecar). **No paid APIs.**

## Quick start
```bash
npm install
npx playwright install chromium
cp .env.example .env            # fill in Supabase + Gemini + Meta + JWT_SECRET_KEY
npm start                       # http://localhost:3001
npm test                        # vitest
```
`.env` config is documented in `.env.example`. `JWT_SECRET_KEY` **must match** the shared FastAPI backend's value.

## Documentation
| Doc | For |
|---|---|
| **`docs/FRONTEND_API.md`** | **Frontend developers** — every endpoint + request/response + quick-start |
| **`PRODUCT_STATUS.md`** | **Product** — spec compliance + setup guide |
| **`SYSTEM_DESIGN.md`** | Architecture + 2026-standard assessment + optimization roadmap |
| **`HANDOFF.md`** | Running / deploying the backend |
| `docs/superpowers/specs/` | Design spec + the shared-backend integration decision |

## Status
Pilot-ready foundation: AI, auth, dashboard, reporting, ROI alerts, leads — all live and tested. Meta live-data + the social module activate once the respective accounts are connected. See `PRODUCT_STATUS.md`.
