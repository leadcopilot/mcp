# LeadPilot Ad Manager Portal — Frontend API & Feature Contract

**For:** Frontend developer • **Backend base URL (local):** `http://localhost:3001`
**Status date:** 2026-07-22 • **Auth:** Bearer JWT (shared LeadPilot backend)

> This is the **contract to build the frontend against.** Each endpoint is tagged:
> ✅ **Live** (integrated + working) · 🟡 **Wiring** (logic built, endpoint being connected) · ⛔ **Planned** (contract fixed, not built).
> Shapes below are stable — build UI against them now; I wire the backend to match.

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

## 14. Health
### `GET /health` ✅
```jsonc
{ "status": "ok", "env": { "supabase": true, "gemini": true, "meta": true,
  "search": "duckduckgo", "playwright": true } }
```

---

## Implementation status summary (be honest with the team)

| Module | Frontend can build UI? | Backend live? |
|---|---|---|
| Auth (Bearer JWT) | ✅ yes | 🟡 middleware ready, routes gating next |
| Org profile / knowledge | ✅ yes | ✅ read works |
| AI ad-copy | ✅ yes | ✅ engine; 🟡 endpoint |
| AI analyst chat | ✅ yes | 🟡 engine; tools wiring |
| Keyword research | ✅ yes | ⛔ building |
| Meta connect + campaigns + creator | ✅ yes | ⛔ router building (creds now set) |
| Leads (list/add/update-status) | ✅ yes | ✅ live (shared Supabase table) |
| Competitors / Social / Research | ✅ yes | 🟡 / ⛔ |

**Frontend can start now** on: auth flow, layout/nav (6 modules), org profile, ad-copy generator, keyword table, campaign tracker table, lead table, AI chat. All shapes above are final.
