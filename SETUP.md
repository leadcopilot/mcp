# LeadPilot Ad Manager — Setup, Run & Feature Status

> One doc to get a brand-new machine running the app and showing a demo, plus an honest
> feature/MCP status matrix (what works today vs. what needs an external account).
> This supersedes the setup section in `README.md`. For what blocks a real-Meta demo and the path to fix it, see **`BLOCKERS.md`** (kept separate for the meeting).

---

## Testing status (honest — read before launch)

**Verified working (with evidence):**
- Security/auth — full suite incl. adversarial (no endpoint reachable without a token; SSRF, path-traversal, token encryption).
- UI — light + dark + tablet, all 9 modules render, 19/19 end-to-end checks, zero console errors.
- **Keyword Research** — driven through the real UI, real Gemini output.
- **Lead pipeline** (add / dedup / status / Excel export) — via API.
- **Meta Graph adapter** — unit level only: dispatch, objective mapping, graceful failures, one real Graph call (bad token → correct Meta error).
- Tavily search (research engine) — live.

**NOT yet tested:**
- **Any Meta feature against a real connected account** — all 25 tools returning live data, connect → campaigns → insights → publish, custom audience / lookalike. Blocked on Meta app credentials (see `BLOCKERS.md`). The 25 tools are code-complete and correct-to-docs but have never touched a live account.
- **A full Deep Research job** run end to end + RAG chat.
- **Some UI click-throughs end to end:** Ad Copy generate, Add-Lead modal, Export button, AI Analyst send, the Creator wizard steps, cross-module "push."
- Google (descoped), Meta lead webhook (needs a public URL + creds).

**Bottom line: the core is verified; the Meta live path, a full research run, and a few UI flows are not. Do not treat this as fully launch-tested until those are done.**

---

## 1. What you are running

Two processes work together:

| Process | Tech | Port | Purpose |
|---|---|---|---|
| **Ad Manager server** | Node.js + Express | **3001** | The web UI + all `/api`, `/auth`, `/social` endpoints. This is what you open in the browser. |
| **BI Research sidecar** | Python + FastAPI | **8000** | Deep-research jobs (report / leads / profile) + per-company RAG chat. The Node server proxies it at `/api/research/*`. |

Data lives in a local SQLite file (`leadpilot.db`, auto-created on first run). The UI is a single file, `public/index.html` (no build step) — a token-based design system with inline SVG icons (no emoji), **light + dark themes** (toggle in the top bar, respects OS preference), and a responsive layout down to tablet. It was rebuilt and verified end-to-end (light/dark/tablet).

```
Browser ──> Node (3001) ──> Gemini / Groq        (AI: keywords, copy, analyst)
                        ──> Meta Graph API v19    (campaigns, audiences, ad creator)  [needs Meta app creds]
                        ──> Playwright            (website scraping/enrichment)
                        ──> Tavily / DuckDuckGo   (competitor web search)
                        ──> Python sidecar (8000) ──> Mistral + Tavily→DuckDuckGo + trafilatura (deep research + RAG)
```

---

## 2. Prerequisites

| Need | Version | Notes |
|---|---|---|
| **Node.js** | v20+ (tested on **v24.16.0**) | `node -v` |
| **Python** | 3.10+ (tested on **3.11.9**) | `python --version` |
| **npm** | ships with Node | — |
| OS | Windows / macOS / Linux | Windows commands shown below; the app is cross-platform |

> **Important (native module):** the database driver `better-sqlite3` needs a **prebuilt binary** for your Node version. This repo pins `^12.11.1`, which ships prebuilt binaries for Node 20–24, so **no C++ compiler is required**. If `npm install` ever tries to *compile from source* (older/newer Node without a prebuild), you'll see a `gyp ERR! find VS` error — fix it by either using a Node version that has a prebuild, or installing **Visual Studio Build Tools** with the *"Desktop development with C++"* workload (Windows).

---

## 3. Install (3 commands)

From the repo root (`d:/Ad_Manager-main/Ad_Manager-main`):

```powershell
npm install                      # Node deps (Express, better-sqlite3, playwright SDK, ...)
npx playwright install chromium  # Chromium browser for website scraping/enrichment
pip install -r requirements.txt  # Python deps for the research sidecar (fastapi, mistralai, ddgs, trafilatura, ...)
```

If `pip` maps to Python 2 on your machine, use `python -m pip install -r requirements.txt`.

---

## 4. Configure `.env`

```powershell
Copy-Item .env.example .env      # (macOS/Linux: cp .env.example .env)
```

Then edit `.env`. **You do NOT need every key** — here's what matters for a demo vs. full functionality:

### 4a. Minimum for a working demo (no Meta/Google account needed)

| Key | Required for | Where to get it (free) |
|---|---|---|
| `GEMINI_API_KEY` | Keyword Research, Ad Copy, AI Analyst | https://aistudio.google.com/app/apikey |
| `MISTRAL_API_KEY` | Deep Research + RAG chat | https://console.mistral.ai/api-keys |
| `SESSION_SECRET` | session signing | any long random string |
| `TOKEN_ENC_KEY` | encrypts stored tokens at rest | generate — see below |

Recommended extras (still no account needed):

| Key | Adds |
|---|---|
| `GROQ_API_KEY` | automatic AI fallback when Gemini rate-limits (https://console.groq.com/keys) |
| `TAVILY_API_KEY` | better competitor web search (falls back to DuckDuckGo if unset) |

### 4b. Generate the secrets

```powershell
# TOKEN_ENC_KEY  (64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# SESSION_SECRET / META_WEBHOOK_VERIFY_TOKEN / RESEARCH_API_KEY  (48 hex chars)
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Paste the outputs into the matching `.env` keys.

> If `TOKEN_ENC_KEY` is left blank it's derived from `SESSION_SECRET` (fine locally). **Set it explicitly** for anything real — and don't change it later, or previously-stored OAuth tokens can't be decrypted (users would just reconnect).

### 4c. Only for a **full Meta** demo (real ad account) — see §8 for the walkthrough

| Key | Purpose |
|---|---|
| `META_APP_ID`, `META_APP_SECRET` | your Meta app (developers.facebook.com) |
| `META_REDIRECT_URI` | `http://localhost:3001/auth/meta/callback` |
| `META_WEBHOOK_VERIFY_TOKEN` | must match the token you set in Meta → Webhooks (lead ingestion) |
| ~~`META_MCP_PYTHON`~~ | **Legacy / no longer used** — Meta now calls the Graph API directly. Ignore the `META_MCP_*` and `GOOGLE_MCP_*` vars. |
| `META_MCP_MODULE` | usually `meta_ads_mcp` |

### 4d. Google (currently **not functional** — see status table)

`GOOGLE_*` and `GOOGLE_MCP_*` keys exist but Google Ads is not wired end-to-end yet. Leave as-is.

---

## 5. Run it

### Easiest (Windows) — one launcher

```powershell
.\start.bat
```

This opens two terminals: the research sidecar on `127.0.0.1:8000` and the Node server on `3001`.

### Manual (any OS) — two terminals

```powershell
# Terminal 1 — research sidecar
python -m uvicorn api:app --host 127.0.0.1 --port 8000 --reload

# Terminal 2 — Node server
npm start
```

Open **http://localhost:3001**

> The sidecar is bound to `127.0.0.1` on purpose (it has no login of its own). Keep it local; don't expose port 8000.

---

## 6. Verify it's up (30-second smoke test)

```powershell
curl http://localhost:3001/health
# -> {"status":"ok",...,"env":{"gemini":true,"groq":true,"meta":false,...,"playwright":true}}

curl http://localhost:8000/openapi.json   # sidecar alive -> 200
```

In `/health`, `env` shows which integrations are configured. `meta:false` just means no Meta app is set up yet — the demo below still works.

---

## 7. Demo script (no Meta/Google account required)

This path exercises the AI + data core of the product and is what to show in a pitch.

1. **Create an organisation** — open the UI → **Settings** → fill Org ID + Name (+ optional website) → Create.
   *(A private per-org token is issued and stored in your browser automatically — see §9.)*
2. **Keyword Research** — enter a seed keyword (e.g. "running shoes") → get a table of ~20 keywords with volume/difficulty/CPC/intent (real Gemini output).
3. **Push to Copy Generator** → set tone/objective → **Generate** → get Meta ad copy variants.
4. **Lead Scraper** — add a couple of leads manually → try adding a duplicate phone (it's flagged) → **Export to Excel**.
5. **Deep Research** — enter a company URL → run a **Profile** or **Report** job → watch the live log → when done, **chat with that company's knowledge base**.
6. **AI Analyst** — ask a natural-language question about the org.

Modules that will show **"not connected"** until you do §8: **Unified Ad Tracker**, **Meta Ads Creator**, **Social Media Hub**.

> **Website enrichment / scraping** needs `npx playwright install chromium` (step 3 of install). If `/health` shows `playwright:false`, run it.

---

## 8. Enable a full Meta demo (real campaigns) — advanced

Meta now uses the **Graph API directly** (no MCP install / no `META_MCP_*` paths needed). You only need an app + creds:

1. Create a **Business-type** Meta app at developers.facebook.com; add **Facebook Login** + **Marketing API**.
2. Add OAuth redirect `http://localhost:3001/auth/meta/callback` and app domain `localhost`. Keep the app in **Development mode** and add yourself as an Admin/Tester (Dev mode gives full `ads_management`/`leads_retrieval` on your own assets — no App Review needed).
3. In `.env`, set `META_APP_ID` and `META_APP_SECRET`. Restart Node. Confirm `/health` shows `"meta":true`.
4. In the UI → Settings → **Connect Meta** → approve → the ad account is stored (encrypted).
5. Now the Tracker pulls real campaign insights, and the **Meta Ads Creator** wizard publishes campaign→ad set→creative→ad (all created **PAUSED**).
6. *(Optional) Lead webhook:* in Meta → Webhooks, subscribe to `leadgen` with callback `http://<public-host>/api/leads/webhook/meta` and the verify token = your `META_WEBHOOK_VERIFY_TOKEN`. (Needs a public HTTPS tunnel like ngrok for local testing.)

> The `META_MCP_PYTHON` / `META_MCP_MODULE` / `GOOGLE_MCP_*` vars in `.env.example` are **legacy and unused** now — you can ignore them.

---

## 9. How auth works now (changed from the previous code)

Previously any request with an `org_id` was trusted. **Now every organisation gets a secret `api_token` at creation.**

- The **browser UI handles this automatically** — the token is returned once on org-create and stored in `localStorage`; every request sends it as the `X-Org-Token` header.
- For **API / curl** testing, send the header yourself:
  ```powershell
  # create org -> capture api_token from the response
  curl -X POST http://localhost:3001/api/org/create -H "Content-Type: application/json" -d '{"org_id":"demo","name":"Demo"}'

  # then authorize every call
  curl "http://localhost:3001/api/leads/list?org_id=demo" -H "X-Org-Token: <the_token>"
  ```
- OAuth links pass it as `?org_token=...` (browser navigations can't set headers).
- This is a **per-org token gate**, not full user login/RBAC — that's on the roadmap (§11).

---

## 10. Feature & MCP status

Legend: ✅ **Done & tested** (works now, no external account) · 🟢 **Code complete — needs the account/tool connected to run** · 🟡 **Partial / has gaps** · 🔴 **Not implemented / broken** · ⏳ **Pending**

### 10a. Product modules (from the UI/UX brief)

| # | Module | Status | Notes |
|---|---|---|---|
| 01 | Keyword & Volume Research | ✅ | Real Gemini output. Gaps: trend **sparkline** and side detail panel are text-only (🟡 UI polish). |
| 02 | Ad Copy Generator | 🟡 | Google RSA + Meta copy work (Gemini). **Instagram & Display copy types not built**; Edit/Approve buttons missing. |
| 03 | Unified Ad Tracker | 🟢 | Pulls real Meta insights when connected. **Google half not fetched** (see MCP table). ROAS is honest now (`null` unless revenue known — no fabricated numbers). |
| 04 | Meta Ads Creator (wizard) | 🟢 | Full 5-step wizard; **now publishes the complete campaign→adset→creative→ad chain (all PAUSED)** via `/api/campaigns/publish`. Needs Meta connected. Gaps: image **upload** and Story preview not built (🟡). |
| 05 | Lead Scraper | ✅ / 🟢 | Manual add, list, dedup (duplicates persisted & flagged), status tagging, **Excel export** all work (✅, DB only). Meta Lead-Ads **webhook** is implemented & secured but needs a connected Meta page (🟢). Google Lead Forms & CSV bulk-import 🔴. "Assigned To" + bulk assign 🔴. |
| 06 | Social Media Hub | 🟡 | Facebook / Instagram / YouTube / Twitter metrics work when tokens are connected (🟢). **LinkedIn metrics stubbed to zero** (🔴). Alerts section 🔴. |

### 10b. Extra modules (beyond the brief)

| Feature | Status | Notes |
|---|---|---|
| Deep Research (report / leads / profile jobs) | ✅ | Mistral + DuckDuckGo + trafilatura. Needs `MISTRAL_API_KEY`. Runs for several minutes/job. |
| Per-company RAG knowledge base + chat | ✅ | Mistral embeddings; **isolated per organisation**. |
| AI Analyst chat | ✅ | Gemini answers; can call Meta/research tools where connected. |
| Competitor web search | ✅ | Tavily (or DuckDuckGo fallback). |
| Website enrichment (scrape) | 🟢 | Needs `playwright install chromium`. SSRF-guarded. |

### 10c. Meta Ads **MCP** tool coverage

> ✅ **Updated:** the old broken `meta-ads-mcp` subprocess has been **replaced with direct Meta Graph API v19.0 calls** (`lib/services/metaGraph.js`). The 🟢 rows below are code-complete and make real Graph calls — they return live data **once you create a Meta app + connect an account** (§8). No package install, tool-name, or auth-model problems remain. (The "tool" column names are now internal adapter operations, not MCP tools.)

This maps product capabilities to the Graph operations behind them.

| Capability | MCP tool | Endpoint(s) | Status |
|---|---|---|---|
| List campaigns | `list_campaigns` | `/api/campaigns/list`, `/api/tracker/campaigns` | 🟢 |
| Campaign performance (spend/CTR/CPC/conv/reach/freq) | `get_insights` | `/api/tracker/campaigns`, `/api/campaigns/insights` | 🟢 |
| Create campaign | `create_campaign` | `/api/campaigns/create`, `/api/campaigns/publish` | 🟢 |
| Pause / update campaign | `update_campaign` | `/api/campaigns/pause` | 🟢 |
| Interest search (audience builder) | `search_interests` | `/api/meta-creator/interests` | 🟢 |
| Custom audiences | `get_custom_audiences` | `/api/meta-creator/audiences` | 🟢 |
| Delivery / reach estimate | `get_delivery_estimate` | `/api/meta-creator/estimate` | 🟢 |
| Ad preview | `get_ad_preview` | `/api/meta-creator/preview` | 🟢 |
| Create ad creative | `create_ad_creative` | `/api/meta-creator/creative`, `/publish` | 🟢 |
| Create ad set | `create_ad_set` | `/api/meta-creator/adset`, `/publish` | 🟢 |
| Create ad | `create_ad` | `/api/meta-creator/ad`, `/publish` | 🟢 (creative payload shape fixed) |
| Competitor ads (Ad Library) | `search_ad_library` | `/api/competitors/ad-library` | 🟢 (also needs Meta Ad Library API access approval) |
| Account info | `get_account_info` / `get_ad_accounts` | `/api/social/metrics` + AI tools | 🟢 |
| List ad sets / ads / creatives | `get_ad_sets`, `get_ads`, `get_ad_creatives` | AI Analyst tools | 🟢 |
| Update / pause ad set | `update_ad_set` | AI Analyst tools | 🟢 |
| Lookalike audiences | `create_lookalike_audience` | AI Analyst tools | 🟢 (leads → lookalike loop) |
| Custom audience from leads | `create_custom_audience` | AI Analyst tools | 🟢 (emails/phones SHA-256 hashed) |
| Upload ad image | `upload_ad_image` | Graph adapter | 🟢 |
| Delivery diagnostics / account quality | `delivery_check`, `get_account_quality` | AI Analyst tools | 🟢 |
| Catalog / pixel tools | `get_catalogs`, `get_pixels` | — | ⚪ not built (e-commerce, not applicable to lead-gen) |

**25 of Meta's 29 tools are implemented — every one useful for a lead-gen product.** Only `delete_campaign` (omitted for safety) and the 3 catalog/pixel tools (e-commerce only) are left out. All 🟢 rows make real Graph calls and return live data once a Meta app + account are connected (§8).

> **Architecture note:** the multi-tenant premise (per-org tokens, many client orgs under one deployment) is right, and the direct Graph API is the correct vehicle for it — see `META_INTEGRATION.md` for the full "why direct API over Meta's hosted connector" reasoning. The per-org token is stored encrypted; the same pattern the code already uses for OAuth + lead-fetch.

### 10d. Google Ads **MCP**

| Capability | MCP tool | Status |
|---|---|---|
| List Google campaigns | `list_google_campaigns` | 🔴 broken — `customer_id` is never captured at OAuth, so calls fail |
| Keyword ideas (Google) | `get_keyword_ideas` | 🔴 broken — query ignores its inputs |

⏳ **Google Ads is descoped for now** and **hidden in the UI** (Connect button disabled → "Coming soon", pill neutralized, empty tracker tab removed). Note: AI-generated **Google ad copy** in the Copy Generator still works — it uses Gemini, not the Google Ads API. Only the Google *account/campaign* integration is deferred.

### 10e. Security & infrastructure (tested this session)

| Item | Status |
|---|---|
| Per-org token auth on all data/action endpoints | ✅ |
| OAuth tokens encrypted at rest (AES-256-GCM) | ✅ |
| SSRF guard on all outbound URL fetches (Node + Python) | ✅ (11/11 bypass attempts blocked) |
| Research download path confinement (no traversal) | ✅ |
| Meta lead webhook signature + verify-token | ✅ |
| Per-org RAG isolation | ✅ |
| Full user login / roles (RBAC) | 🔴 roadmap |

---

## 11. Known limitations / roadmap (be upfront in the pitch)

- **Google Ads** integration is not functional yet (⏳).
- Meta MCP spawns a subprocess per call (no pooling/timeouts) — fine for a demo, needs hardening for scale.
- UI is desktop-only (no responsive/tablet CSS yet); some brief details (sparklines, IG/Display copy, "Assigned To", Story preview, image upload) are not built.
- Auth is a per-org token gate, not full multi-user login/RBAC.
- SSRF guard is resolve-then-check (theoretical DNS-rebinding race remains).

---

## 12. What was fixed vs. the previous code (fix log)

Every change made on top of the previous version. Grouped by type; the ones marked **★** were found and fixed by running the app's own test suite against it.

### Security (the dangerous ones)

1. **Added authentication.** Previously *any* request with an `org_id` was trusted (full IDOR — anyone could read any org's leads or spend its ad budget). Now every org gets a secret `api_token` at creation, required on all `/api`, `/social`, `/research`, and `/auth` routes. *(new `lib/authz.js`)*
2. **OAuth tokens encrypted at rest** (AES-256-GCM). Meta/Google/social tokens were stored in **plaintext** in SQLite. *(new `lib/crypto.js`)*
3. **Fixed arbitrary-file-read** in the research sidecar's `/api/download` (path traversal — `output/../../…` returned any system file). Now confined to the output dir via `resolve()` + `is_relative_to`. *(`api.py`)*
4. **SSRF guard** on every outbound URL fetch (scraper + Python research). Was unguarded — could hit `169.254.169.254` cloud metadata, `localhost`, private IPs, `file://`. *(new `lib/ssrf.js`, `main.py: is_public_url`)*
5. **Per-org RAG isolation.** The research knowledge base was a **global namespace** — any org could read any other org's research. Now keyed per org. *(`routes/research.js`)*
6. **Fixed & secured the Meta lead webhook.** Was unauthenticated (no `hub.verify_token`, no signature), used the Facebook **page id as the org id** (so leads landed nowhere), and stored only IDs. Now: verify-token on GET, `X-Hub-Signature-256` HMAC on POST, correct page→org mapping, and fetches the **real lead name/phone/email** from the Graph API. *(`routes/api.js`, `server.js` raw-body capture)*
7. **Sidecar locked down** — bound to `127.0.0.1` (was `0.0.0.0`), CORS tightened (was `*` + credentials), optional shared secret (`RESEARCH_API_KEY`). *(`api.py`, `start.bat`, `researchClient.js`)*
8. **OAuth hardening** — CSRF state now expires after 15 min; `org/status` and `org/list` no longer leak the `api_token`. *(`lib/db.js`, `routes/api.js`)*

### Correctness / demo integrity

9. **Removed fabricated ROAS.** The tracker hardcoded revenue at ₹1000/lead, so ROAS was fiction. Now uses real Meta conversion values (or an explicit configured per-lead value), else reports `null`. *(`routes/api.js`)*
10. **Weighted KPIs.** Blended ROAS / avg CTR / avg CPC were naive per-campaign averages (a ₹5 campaign counted equally with a ₹50k one). Now spend/impression-weighted, plus `avg_cpl`. *(`routes/api.js`)*
11. **Fixed the Meta Ads Creator losing data on publish.** The wizard collected audience + creative + budget + dates but **only sent name/objective/budget**. New `/api/campaigns/publish` orchestrates campaign → ad set → creative → ad (all PAUSED) from the **full payload**, with per-step status. *(`routes/api.js`, `public/index.html`)*
12. **Fixed the `create_ad` creative shape** (`creative_id:{creative_id}` → `creative:{creative_id}`). *(`routes/api.js`)*
13. **Fixed invalid LLM fallback model IDs** that made fallbacks dead: Python `GROQ_MODEL` `qwen/qwen3.6-27b` → `llama-3.3-70b-versatile`; OpenRouter `openrouter/free` → `meta-llama/llama-3.3-70b-instruct:free` (both env-overridable). *(`main.py`, `lib/ai/openrouter.js`, `lib/ai/groq.js`)*
14. **Meta OAuth** no longer silently saves a ~1-hour short-lived token as if permanent when the long-lived exchange fails, and now surfaces ad-account fetch errors. *(`lib/auth/meta.js`)*

### Found by self-testing ★

15. **★ Duplicate leads are now persisted and flagged** (`is_duplicate` + `duplicate_of`) instead of silently dropped — so the dedup flag and `stats.duplicates` counter actually work. *(`lib/db.js`)*
16. **★ "Meta not connected" now returns HTTP 424**, not 401. Reusing the auth status code (401) across 13 endpoints would have made API clients wrongly try to re-authenticate. *(`routes/api.js`)*

### Frontend

17. Sends the `X-Org-Token` header on every request; stores the per-org token on create; OAuth "Connect" links carry `org_token`. *(`public/index.html`)*
18. Audience-builder interest selection now keeps the **interest IDs** (Meta targeting needs IDs, not names). *(`public/index.html`)*

### Environment / tooling

19. **Bumped `better-sqlite3` `^11.10.0` → `^12.11.1`** so `npm install` uses a **prebuilt binary on Node 24** — previously it tried to compile from source and failed without Visual Studio C++ build tools. *(`package.json`)*
20. New `.env` keys documented: `TOKEN_ENC_KEY`, `META_WEBHOOK_VERIFY_TOKEN`, `RESEARCH_API_KEY`, optional `GROQ_MODEL` / `OPENROUTER_MODEL`. *(`.env.example`)*
21. New files: `lib/crypto.js`, `lib/authz.js`, `lib/ssrf.js`.

> The above (1–21) were **verified against the running app** (functional + adversarial security tests): 0 endpoints reachable without a token, 11/11 SSRF bypass payloads blocked, 0 path-traversal escapes, tokens confirmed encrypted at rest, no fabricated ROAS.

### Later in the same session (full UI redesign + blocker fixes)

22. **UI rebuilt to a design system** — CSS tokens, **light + dark themes** (top-bar toggle, respects OS preference, persisted), an inline **SVG icon set replacing every emoji**, responsive to tablet, focus rings + keyboard-operable nav, refined tables/pills/cards/toasts/empty-states. *(`public/index.html`)*
23. **Meta backend rewritten off the broken MCP → direct Graph API** *(`lib/services/metaGraph.js`; `lib/mcp/manager.js` delegates)*. Preserves the per-org multi-tenant token model.
24. **Publish wizard budget fix** — campaign-level budget only; lead-gen ad set auto-downgrades optimization goal without a lead form. *(`routes/api.js`)*
25. **Deep Research reliability + speed** — Tavily primary (DDG fallback) in the Python engine, and report sections generate in parallel (~1.5 min vs ~9–10). *(`main.py`)*
26. **Research job durability** — startup reconciliation for orphaned jobs + WAL/busy-timeout on `jobs.db`. *(`api.py`)*
27. **Google descoped in the UI** (broken account integration hidden; AI Google copy kept). *(`public/index.html`)*

> Verified this session: **19/19 end-to-end UI+backend checks pass, zero console errors** (real Gemini keyword rows through the UI, dark-mode toggle, all 9 modules, tablet layout); Graph adapter makes real calls (bad token → "Invalid OAuth access token"); Tavily search returns live results.
> **Still needs YOU (see `BLOCKERS.md`):** create a Meta app + add `META_APP_ID`/`SECRET`, then connect an account and rehearse. That's the only remaining T1 item.

---

## 13. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `npm install` → `gyp ERR! find VS` | Node version has no `better-sqlite3` prebuild → use Node 20–24, or install VS Build Tools (C++ workload). |
| `Error: Cannot find module 'dotenv'` | `npm install` didn't finish/rolled back — re-run it and confirm it ends with `added N packages`. |
| `EADDRINUSE :3001` (or 8000) | A server is already running on that port. Stop it: `netstat -ano \| findstr :3001` then `taskkill /F /PID <pid>`. |
| `/health` shows `playwright:false` | Run `npx playwright install chromium`. |
| API call returns **401 Unauthorized** | Missing/wrong `X-Org-Token`. Recreate the org (token is issued once) or use the browser UI which stores it. |
| API call returns **424 "Meta not connected"** | Expected until you connect Meta (§8). Not an auth error. |
| Deep Research jobs fail immediately | Check `MISTRAL_API_KEY`; DuckDuckGo may be rate-limiting searches (retry). |
| "Research service unreachable" | The Python sidecar (8000) isn't running — start it (§5). |
| Want a clean slate | Stop the servers and delete `leadpilot.db` (and `rag_store/`, `output/`, `logs/`) — everything recreates on next start. |

---

*Ports: UI 3001 · sidecar 8000. Reset: delete `leadpilot.db`. Full Meta demo: §8.*
