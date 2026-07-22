# LeadPilot Ad Manager Portal — Frontend API & Feature Contract

**For:** Frontend developer • **Backend base URL (local):** `http://localhost:3001`
**Status date:** 2026-07-22 • **Auth:** Bearer JWT (shared LeadPilot backend)

> This is the **contract to build the frontend against.** Each endpoint is tagged:
> ✅ **Live** (integrated + working) · 🟡 **Wiring** (logic built, endpoint being connected) · ⛔ **Planned** (contract fixed, not built).
> Shapes below are stable — build UI against them now; I wire the backend to match.

---

## 0. Quick start (frontend dev)

- **Base URL (local):** `http://localhost:3001`
- **Every `/api/*` call needs the header:** `Authorization: Bearer <jwt>`
- **Get the JWT** from the shared LeadPilot **backend** login (`POST /api/auth/login` on the FastAPI backend, port 8000) — same token the founder/telecaller portals use.
- **First call after login:** `GET /api/me` → `{ user_id, org_id, role, business_name }` (for the header/session).

```js
const api = (path, opts = {}) => fetch(`http://localhost:3001${path}`, {
  ...opts,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
}).then(async (r) => {
  if (r.status === 401) throw new Error('login expired');
  if (r.status === 429) throw new Error('AI busy, retry');          // Gemini quota/overload
  if (r.status === 409) return r.json();                            // e.g. "connect Meta first"
  if (!r.ok) throw new Error((await r.json()).error || r.statusText);
  return r.json();
});

// examples
const me       = await api('/api/me');
const profile  = await api('/api/org/profile');
const copy     = await api('/api/copy/generate', { method: 'POST', body: JSON.stringify({ goal: 'book consults', platform: 'meta' }) });
const board    = await api('/api/dashboard/summary');
const report   = await api('/api/reports/monthly');
```

**Error contract:** JSON `{ "error": "..." }`; `401` login, `403` role, `409` needs-connection (has `connect_url`), `429` AI busy (retry), `400` bad input, `500` server.

---

## 1. Auth model (read this first)

The Ad Manager does **not** have its own login. LeadPilot's FastAPI backend is the **sole identity provider** for all portals. Flow:

1. User logs in via the **backend** `POST /api/auth/login` (email + password) → receives an **HS256 JWT**.
2. The frontend stores that token and sends it on **every** Ad Manager request:
   `Authorization: Bearer <token>`
3. The token carries `sub` (user id), `org_id`, `role` (`founder` | `ad_manager` | `telecaller`). The Ad Manager reads `org_id`/`role` from the token — **the frontend never sends `org_id` in the body.**
4. Ad Manager features require role `founder` or `ad_manager`. A `telecaller` token gets `403`.

**Error shape (all endpoints):**
```json
{ "error": "human-readable message" }
```
Status codes: `200` ok · `400` bad input · `401` missing/invalid token · `403` wrong role · `404` not found · `429` AI quota (retry) · `500` server.

---

## 2. Organisation & knowledge base

The org profile (services, pricing, competitors, brand voice, USPs) is **owned by the founder onboarding** (backend). The Ad Manager **reads** it to ground AI.

### `GET /api/org/profile` 🟡
Returns the current org's knowledge base (from the JWT's `org_id`).
```jsonc
// 200
{
  "org_id": "org_abc",
  "business_name": "Personiks",
  "industry": "Cosmetic & Plastic Surgery",
  "website": "https://personiks.com",
  "services": ["Rhinoplasty", "FUE Hair Transplant", "..."],
  "pricing_min": 15000, "pricing_max": 500000,
  "target_audience": "adults 25-55 in Hyderabad",
  "competitors": ["..."],
  "brand_voice": "premium, reassuring",
  "languages": ["English", "Telugu", "Hindi"],
  "usps": ["Top 2 in Hyderabad (Times of India 2025)", "10,000+ patients"]
}
```

---

## 3. AI Ad-Copy Generator (spec §5) — ✅ engine live

### `POST /api/copy/generate` 🟡 *(engine ✅, endpoint wiring)*
Generate platform ad-copy variants grounded ONLY in the org's real profile.
```jsonc
// request
{ "goal": "book more consultations", "platform": "meta", "count": 3 }
// 200
{
  "org": "Personiks",
  "platform": "meta",
  "goal": "book more consultations",
  "variants": [
    { "headline": "Top-Ranked Cosmetic Surgery",
      "primary_text": "Transform your confidence with Personiks…",
      "cta": "Book Now" }
  ]
}
```
`platform`: `meta` | `google` | `instagram`. Copy is **grounded** — never invents services/prices.

---

## 4. AI Keyword Research (spec module 1) — ⛔ planned (contract fixed)

### `POST /api/keywords/research`
```jsonc
// request
{ "seed_keyword": "hair transplant hyderabad", "location": "IN" }
// 200
{ "keywords": [
    { "keyword": "fue hair transplant cost", "volume": 2400, "difficulty": 38,
      "cpc_low": 12.5, "cpc_high": 60.0, "intent": "Transactional", "trend": "up" }
] }
```
Columns map 1:1 to the UI/UX brief's Keyword table (Keyword, Volume, Difficulty pill, CPC range, Intent tag, trend sparkline).

---

## 5. AI Analyst Chat (spec §4) — 🟡 engine built, tools wiring

### `POST /api/ai-analyst`
Natural-language questions; the AI decides which tools to call (campaign data, competitor web search, org knowledge) and answers in plain language.
```jsonc
// request
{ "query": "Which campaigns brought leads that converted last month?",
  "thread_id": "optional-for-follow-ups" }
// 200
{ "answer": "…plain-language answer…",
  "tools_used": ["get_campaign_insights", "search_web"],
  "data": { "optional": "structured rows for inline charts/tables" } }
```

---

## 6. Meta Connection (OAuth) — 🟡 creds set, flow wiring

### `GET /auth/meta` 🟡 → redirects the user to Facebook login (dev mode).
### `GET /auth/meta/callback` 🟡 → Meta redirects back; token stored encrypted per-org.
### `GET /api/connections/status` 🟡
```jsonc
// 200
{ "meta": { "connected": true, "ad_account_id": "act_123", "page": "Personiks" },
  "google": { "connected": false } }
```
> **Note:** Meta runs in **dev mode** (App ID/Secret set). Your **own** ad account works; managing **clients'** accounts needs Meta App Review. If not connected, Meta endpoints return `409 { "error": "connect your Meta account", "connect_url": "/auth/meta" }` — the UI should show a "Connect Meta" state, never crash.

---

## 7. Campaign Tracker & Management (Meta) — ⛔ planned (needs Meta connect + router)

### `POST /api/campaigns/list`
```jsonc
// request: { "status": "ACTIVE", "limit": 20 }
// 200
{ "campaigns": [
  { "id": "23851…", "name": "Whitening – Hyd", "status": "ACTIVE",
    "objective": "LEADS", "budget": 1000, "spend": 8450, "impressions": 120000,
    "clicks": 3400, "ctr": 2.83, "cpc": 2.48, "cpl": 210, "conversions": 40,
    "roas": 3.1, "diagnostic": { "severity": "green", "note": "scaling opportunity" } }
] }
```
### `POST /api/campaigns/insights` — `{ "campaign_id"?, "date_preset": "last_30d" }` → metric set.
### `POST /api/campaigns/create` — `{ "name", "objective", "daily_budget", "confirmed": true }` (created **PAUSED**).
### `POST /api/campaigns/pause` — `{ "campaign_id", "confirmed": true }`.
> All **write** actions require `"confirmed": true` (human-approval gate). Without it → `200 { "preview": {…}, "requires_confirmation": true }`.

---

## 8. Meta Ads Creator wizard (spec module 4) — ⛔ planned

5-step wizard endpoints (contract fixed):
- `POST /api/meta-creator/interests` — `{ "q": "skincare" }` → interest targeting options
- `POST /api/meta-creator/estimate` — `{ "targeting_spec": {…} }` → reach/CPM estimate
- `POST /api/meta-creator/creative` — `{ "headline", "primary_text", "cta", "image_url", "link" }`
- `POST /api/meta-creator/adset` / `POST /api/meta-creator/ad`
- `POST /api/campaigns/publish` — publishes the assembled campaign (PAUSED).

## 9. The full Meta tool catalog (the "135 tools")
Exposed **through the AI Analyst** (§5), not as 135 REST endpoints. Tier 1 = ~27 reliable direct-Graph tools; Tier 2 = the rest via the MCP server. **Frontend never calls these directly** — it calls `/api/ai-analyst` and the AI orchestrates them. ⛔ router being built.

---

## 10. Lead Scraper (spec module 5) — 🟡 shared `leads` table

### `GET /api/leads/list?status=New` 🟡
```jsonc
// 200
{ "leads": [
  { "id": "lead_1", "name": "…", "phone": "+91…", "source": "meta",
    "source_campaign": "23851…", "status": "New", "pipeline_stage": "New",
    "assigned_to": "user_x", "captured_at": "2026-07-20T…" }
], "stats": { "total": 120, "new": 30, "contacted": 40, "converted": 12 } }
```
### `POST /api/leads/add` · `POST /api/leads/update-status` · `GET /api/leads/export` (Excel).
> Leads live in the **shared** LeadPilot `leads` table (same as telecaller). Campaign-attribution columns (`source_campaign`, `source_ad_id`) pending a coordinated backend migration.

---

## 11. Competitor Intelligence — 🟡 web search + scrape
- `POST /api/competitors/ad-library` — `{ "search_terms", "country": "IN" }` (Meta Ad Library; needs Meta identity verification to return data)
- `POST /api/competitors/web-search` — `{ "query", "max_results": 5 }`
- `POST /api/competitors/analyse` — `{ "competitor_name", "industry", "location" }`

## 12. Social Media Hub (spec module 6) — ⛔ planned
- `POST /api/social/metrics` → per-platform followers/reach/engagement.

## 13. Deep Research (Python sidecar) — 🟡 exists, re-platforming to Gemini
- `POST /api/research/jobs/report` · `/leads` · `/profile` — long-running jobs (poll `GET /api/research/jobs/:id`)
- `POST /api/research/ask` — RAG Q&A over a researched company.

---

## 13a. Unified Dashboard & Monthly Report — ✅ live

### `GET /api/dashboard/summary` ✅
Combines the org's leads + shared telecaller call-quality + (if connected) live ad insights.
```jsonc
{
  "leads": { "total": 17, "by_status": { "contacted": 15, "new": 2 },
             "by_pipeline_stage": { "New": 11, "Closed Won": 1, "Negotiation": 1 },
             "closed_won_revenue": 55000 },
  "call_quality": { "analysed": 20, "by_verdict": { "Hot": 5, "Warm": 10, "Cold": 2, "Junk": 3 },
                    "avg_bant_score": 50 },
  "ads": { "connected": false }   // or { connected:true, insights:{…} }
}
```

### `GET /api/reports/monthly` ✅
```jsonc
{ "org": "Personiks", "generated_at": "2026-07-22T…",
  "data": { /* same as dashboard/summary */ },
  "report": "### Executive Summary\n… markdown, AI-generated from the real numbers …" }
```
Render `report` as markdown; use `data` for charts/tiles.

## 14. Health
### `GET /health` ✅
```jsonc
{ "status": "ok", "env": { "supabase": true, "gemini": true, "meta": true,
  "search": "duckduckgo", "playwright": true } }
```

---

## Implementation status summary (be honest with the team)

| Module | Endpoints | Backend live? |
|---|---|---|
| Auth (Bearer JWT) | all routes | ✅ live (JWT-gated) |
| Org profile / knowledge | `GET /api/org/profile` | ✅ live |
| AI ad-copy | `POST /api/copy/generate` | ✅ live |
| AI keyword research | `POST /api/keywords/research` | ✅ live (AI-estimated volumes) |
| AI analyst chat (tool-using) | `POST /api/ai-analyst` | ✅ live (web + Meta read tools) |
| Current user | `GET /api/me` | ✅ live (`{user_id,org_id,role,business_name}`) |
| **Unified dashboard** | `GET /api/dashboard/summary` | ✅ **live** (leads + call-quality + ads) |
| **Dashboard drill-downs** | `GET /api/dashboard/detail` | ✅ **live** (funnel, by_telecaller, quality_trend) |
| **Auto monthly report** | `GET /api/reports/monthly` (JSON) · `GET /api/reports/monthly.pdf` (shareable PDF) | ✅ **live** (AI-generated + wasted-spend log) |
| **ROI alerts (§9)** | `GET /api/alerts` (persisted, poll this) · `GET /api/alerts/check` (live) · `POST /api/alerts/:id/ack` | ✅ **live** — always-on scheduler writes alerts; +CPL/budget when Meta connected |
| **Profile drift (§3)** | `GET /api/org/drift-check` | ✅ live (website vs profile) |
| Leads (list/add/update-status) | `GET/POST /api/leads/*` | ✅ live (shared Supabase) |
| Competitors | `POST /api/competitors/{web-search,scrape,analyse}` | ✅ live |
| Meta connect | `GET /api/connections/meta/start`, `/status` | ✅ live (OAuth flow) |
| Meta campaigns + creator | `POST /api/campaigns/*`, `/api/meta-creator/*` | 🟡 built; needs a **connected** Meta account (409 until then) |
| Social / Deep Research | — | ⛔ pending |

**Frontend can start now** on: auth flow, layout/nav (6 modules), org profile, ad-copy generator, keyword table, campaign tracker table, lead table, AI chat. All shapes above are final.
