# System Design Review — LeadPilot Ad Manager (2026)

Honest assessment of the integrated system: what's already at 2026 standard, what's reliable, and the ranked optimizations (with when each is actually needed — no premature optimization).

---

## 1. Architecture (as built)

```
Browser (frontend)
  │  Authorization: Bearer <HS256 JWT from shared FastAPI backend>
  ▼
Node + Express (:3001)
  ├─ requireAuth middleware → verify JWT → { userId, orgId, role }
  ├─ routes/portal.js  → integrated, auth-gated API (org, ai, dashboard, reports, alerts, leads, competitors, meta)
  ├─ Supabase JS (service-role for jobs; per-user JWT client for RLS)  → Supabase Postgres (shared DB)
  ├─ lib/ai/geminiClient.js → Gemini REST (key rotation + backoff + thinking)
  ├─ lib/services/metaGraph.js → Meta Graph API v19 (27 tools, per-org token)
  ├─ ROI Monitor scheduler (setInterval) → writes ad_alerts
  └─ Python sidecar (:8000) → Deep Research (Gemini LLM + embeddings)
```

## 2. What's already 2026-standard / reliable ✅

- **Managed Postgres (Supabase)** — one shared DB across all three portals, versioned SQL migrations (`supabase/migrations/`).
- **Stateless JWT auth** — shared identity provider, HS256 verify, role-gated; no server session state.
- **Secrets discipline** — OAuth tokens **encrypted at rest** (AES-256-GCM); service-role/JWT client separation; nothing secret in git (verified).
- **Resilient AI layer** — Gemini via REST with **multi-key rotation + exponential backoff**; graceful skip on quota; Groq/DuckDuckGo free fallbacks. **Zero paid APIs.**
- **Graceful degradation** — Meta not connected → clean `409` with `connect_url`, never a crash; AI quota → `429` retry.
- **Tested** — Vitest suite (auth gating, RLS-safe scoping, provider rotation, route validation); every feature live-verified on real data.
- **Honest tool safety** — writes (create campaign/ad) require explicit confirmation; the AI analyst auto-calls only **read** tools.

## 3. Ranked optimizations (with the trigger for each — none blocking today)

| # | Optimization | Why | Do it when |
|---|---|---|---|
| 1 | **SQL aggregation** (Postgres RPC / views) for dashboard + ROI | Today aggregations fetch rows and count in JS — fine at pilot scale, O(rows) at 100k+ | An org exceeds ~10k leads |
| 2 | **Redis cache** for dashboard/insights (short TTL) | Repeated dashboard loads + Meta insights are cacheable | Dashboard traffic grows |
| 3 | **Split `routes/portal.js`** by domain (ai/dashboard/leads/meta) | 300 lines now; keep files focused | Before it passes ~500 lines |
| 4 | ✅ **Meta token refresh** | **Done** — auto-refresh within 7 days of expiry + manual `/api/connections/meta/refresh` | — |
| 5 | **Rate limiting + observability** (logs/metrics/alerts) | Production hardening | Before public/multi-client load |
| 6 | **Durable job queue** (BullMQ) for Deep Research + ROI scheduler | `setInterval` is fine single-box; not multi-instance safe | When running >1 server instance |
| 7 | **TypeScript** migration (incremental) | Type safety across a growing multi-portal codebase | Ongoing, module by module |
| 8 | **Migrate remaining legacy routes** off SQLite (`routes/api.js`) | competitors/creator/research still hybrid | Next sprint |
| 9 | **Containerize + CI/CD** | Reproducible deploy | At "combine all 3 backends + host" |

**Principle:** the current design is **right-sized for pilot** (per the blueprint's own phased plan). Items 1–2 are the classic "optimize when you have the scale," not before — doing them now would be premature.

## 4. Reliability posture

- **Single points of failure today:** the `setInterval` ROI scheduler (single-box) and in-process Deep Research jobs — both fine on one server, both flagged for a durable queue at multi-instance scale.
- **Data safety:** additive migrations only on the shared `leads` table; destructive ops never auto-run; the telecaller/founder data was verified intact after every change.
- **Backpressure:** AI calls rotate keys + back off; Meta calls fail closed with clear errors.

## 5. Verdict

**Reliable and appropriately-optimized for a pilot / first paying clients — not over-engineered, not fragile.** The path to full production scale is the ranked list above, each item independently shippable. This matches the blueprint's Phase-1→Phase-3 evolution.
