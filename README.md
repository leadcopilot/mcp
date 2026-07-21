# LeadPilot Pipeline

AI pipeline for the LeadPilot **Ad Manager Portal** (Node server + Python research sidecar).

> **Read these first — they are current; the setup notes further down this file are older:**
> - **`SETUP.md`** — how to install and run it, plus a feature-status matrix.
> - **`BLOCKERS.md`** — what blocks a full launch (for the meeting), tiered.
> - **`META_INTEGRATION.md`** — how Meta is integrated (direct Graph API), 25 of 29 tools built, and why we didn't use Meta's hosted connector.
>
> **Note:** Meta now uses the **direct Graph API** (not an MCP subprocess), every request requires a **per-org token** (auth was added), and the "1000 clients simultaneously" line below is an aspiration, not the current capacity. See `BLOCKERS.md`.

## What this is

This is the backend pipeline that powers the LeadPilot Ad Manager Portal.
It is NOT a chat app or a Claude Desktop config. It is a real Node.js server
that any UI can call via REST API — and the Ad Manager Portal UI will plug into it.

## What it does

| Feature | How |
|---|---|
| Meta OAuth | Clients connect their Meta account by clicking a button. Token saved in DB. |
| Google OAuth | Same for Google Ads. |
| AI Analyst Chat | Ask questions in natural language. Gemini (free) calls real tools and answers. |
| Campaign management | List, create, pause Meta campaigns via MCP. |
| Competitor Intelligence | Meta Ad Library + Tavily web search + Playwright website scraping. |
| Keyword Research | AI-powered with web search for context. |
| Ad Copy Generation | AI generates Meta/Google copy using org knowledge base. |
| Org enrichment | Playwright scrapes the client's website and fills the knowledge base. |
| Deep Research | Python sidecar runs report/leads/profile research jobs on any company URL and builds a per-company RAG knowledge base you can chat with. |

## Architecture

```
Ad Manager Portal UI  →  POST /api/ai-analyst  →  AI Runner (Gemini → Groq fallback)
                                                         ↓
                      Meta MCP Server (Python)  ←  Tool Executor (workspace-aware)
                      Google MCP Server (Python) ←  (uses each org's own token)
                      Tavily API                ←
                      Playwright (headless)     ←
                      Research Engine (HTTP)    ←  (RAG knowledge-base tools)

Ad Manager Portal UI  →  /api/research/*  →  BI Research Engine (FastAPI :8000)
                                              Mistral + DuckDuckGo + trafilatura
                                              output/ (md, pdf, csv deliverables)
                                              rag_store/ (per-company RAG stores)
```

### BI Research Engine (Python sidecar)

The Deep Research module is powered by a FastAPI sidecar (`api.py`, `main.py`,
`rag_agent.py`) running as a persistent process on port 8000, started together
with the Node server by `start.bat`. It runs three job types per company URL —
a full research report, a qualified-leads list, and a company profile — and
feeds every job's outputs into that company's RAG knowledge store
(`rag_store/`, Mistral embeddings). The Node server proxies it at
`/api/research/*` and the AI Analyst can query the knowledge bases through the
`list_research_companies` / `ask_research_knowledge_base` tools.

### Multi-tenant design

Every organisation (client) has their own Meta and Google tokens stored in SQLite.
When their AI Analyst runs a tool, the MCP server is spawned with THEIR token.
1000 clients can use the system simultaneously — each gets their own isolated data.

This is the "workspace-aware MCP proxy" described in the LeadPilot blueprint.

## Setup

### 1. Prerequisites

Make sure these are installed and working on your Mac:

- meta-ads-mcp (pipeboard-co): `pip install -e /path/to/meta-ads-mcp`
- google-ads-mcp: cloned at `~/Desktop/mcp_practice/google-ads-mcp`
- Node.js v20+

### 2. Install dependencies

```bash
npm install
npx playwright install chromium
pip install -r requirements.txt   # Python deps for the BI Research Engine
```

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Key | Where to get it |
|---|---|
| `GEMINI_API_KEY` | https://aistudio.google.com/app/apikey (free) |
| `GROQ_API_KEY` | https://console.groq.com/keys (free) |
| `META_APP_ID` | developers.facebook.com → Practice App → Settings → Basic |
| `META_APP_SECRET` | Same place |
| `META_REDIRECT_URI` | `http://localhost:3001/auth/meta/callback` |
| `GOOGLE_CLIENT_ID` | Your downloaded credentials JSON |
| `GOOGLE_CLIENT_SECRET` | Same JSON |
| `GOOGLE_REDIRECT_URI` | `http://localhost:3001/auth/google/callback` |
| `GOOGLE_DEVELOPER_TOKEN` | ads.google.com → API Center |
| `TAVILY_API_KEY` | https://tavily.com (free 1000/month) |
| `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys (powers Deep Research + RAG) |
| `RESEARCH_API_BASE_URL` | `http://localhost:8000` (the research sidecar) |

### 4. Add Meta OAuth redirect URL

Go to: developers.facebook.com → Practice App → Settings → Basic → App Domains

Add: `localhost`

Go to: Products → Facebook Login → Settings → Valid OAuth Redirect URIs

Add: `http://localhost:3001/auth/meta/callback`

### 5. Start the servers

```bash
start.bat        # Windows: launches the research engine (:8000) + Node server (:3001)
```

Or start each by hand:

```bash
python -m uvicorn api:app --host 0.0.0.0 --port 8000 --reload
npm start
```

Open: http://localhost:3001

## API Reference

All POST requests require `org_id` in the body.

### Organisation

```
POST /api/org/create        { org_id, name, website }
GET  /api/org/status?org_id=xxx
POST /api/org/enrich        { website_url }
```

### OAuth (GET requests — redirect flow)

```
GET /auth/meta?org_id=xxx        → redirects to Facebook login
GET /auth/meta/callback          → Facebook redirects here after approval
GET /auth/google?org_id=xxx      → redirects to Google login
GET /auth/google/callback        → Google redirects here after approval
```

### AI Analyst

```
POST /api/ai-analyst        { org_id, query, tools? }
```

The AI automatically picks which tools to use. You can restrict tools with the `tools` array.

### Campaigns

```
POST /api/campaigns/list    { org_id, status?, limit? }
POST /api/campaigns/insights { org_id, campaign_id?, date_preset? }
POST /api/campaigns/create  { org_id, name, objective, daily_budget?, confirmed? }
POST /api/campaigns/pause   { org_id, campaign_id, confirmed? }
```

### Competitors

```
POST /api/competitors/ad-library { org_id, search_terms, country? }
POST /api/competitors/web-search { org_id, query, max_results? }
POST /api/competitors/scrape     { org_id, url, extract? }
POST /api/competitors/analyse    { org_id, competitor_name, industry?, location? }
```

### Keywords & Copy

```
POST /api/keywords/research { org_id, seed_keyword, location? }
POST /api/copy/generate     { org_id, keywords, landing_url?, tone?, platform? }
```

### Deep Research (proxied to the Python sidecar)

```
POST /api/research/jobs/report   { org_id, company_url, audience? }
POST /api/research/jobs/leads    { org_id, company_url, audience?, count? }
POST /api/research/jobs/profile  { org_id, company_url }
GET  /api/research/jobs?org_id=xxx
GET  /api/research/jobs/:jobId?org_id=xxx
GET  /api/research/jobs/:jobId/log?org_id=xxx      (plaintext live log)
GET  /api/research/companies?org_id=xxx            (RAG knowledge stores)
POST /api/research/ask           { org_id, company, question }
GET  /api/research/download?org_id=xxx&path=...
```

Jobs run for several minutes and are tracked per organisation. Every completed
job feeds the company's RAG knowledge store, which both the Deep Research chat
panel and the AI Analyst can query.

## About Ad Library

Meta Ad Library requires a separate identity verification step.

Go to: https://www.facebook.com/settings?tab=ads_library_api

Upload Aadhaar → Submit → Wait for approval (minutes to hours).

Once approved, `search_ad_library` and `search_ad_archive` tools work automatically.
No code change needed.

## Fallback behaviour

| Failure | What happens |
|---|---|
| Gemini rate limit (429) | Automatically retries with Groq |
| Meta token expired | Returns clear error with connect URL |
| Google not connected | Returns clear error |
| Playwright fails to load page | Returns error with details |
| Tool not found | Returns honest error |

Nothing is mocked. Errors are passed through honestly.
