# LeadPilot Ad Manager Portal — Phase-1 Foundation Design

**Date:** 2026-07-21
**Status:** Draft for review
**Scope owner:** Manthan Patil

---

## 1. Context

LeadPilot is a multi-org (multi-tenant) SaaS with three portals (Ad Manager, Telecaller, Founder). This spec covers **only the Ad Manager Portal backend/foundation**, taking the existing prototype to a pilot-ready, multi-org, free-API footing.

Two prototype repos exist:

- **`Ad_Manager-main`** — direct Meta Graph API adapter (`metaGraph.js`, 27 working tools), full security layer (AES-256-GCM token encryption, per-org authz gate, SSRF/path-traversal guards), bug-fixes (publish wizard, parallel research, WAL), and design docs. **Chosen base.**
- **`Ad_Manager-developer`** — declares 36 AI tools but routes them all through a broken external MCP subprocess (hardcoded Mac path), no security layer. Its value is the broader tool declarations, which we port.

The comparative review concluded: **base on `main`, port `developer`'s tool breadth, wire the external MCP server as an optional layer.** Same end capability, least risk.

---

## 1a. Revision 2 (2026-07-22) — Integration Pivot (supersedes §5, §6 auth)

**Discovery:** the target Supabase project (`otbdjrexiscbxqlcnnvx`) already hosts the live **LeadPilot backend** (FastAPI, `D:\leadpilot-backend`) — 6 orgs, 10 users, 19 leads, plus Telecaller tables (`audio_calls`, `memory_bubbles`, `lead_analysis`, `follow_ups`, `attendance`). Verified against its `security.py`, `config.py`, `gemini.py`.

This makes the Ad Manager the **3rd portal on one shared backend**, not a standalone app. Corrected decisions:

- **Auth = the backend's custom HS256 JWT, NOT Supabase Auth.** FastAPI is "the sole identity provider for LeadPilot" (all portals + Flutter app). Tokens are HS256-signed with a shared `JWT_SECRET_KEY`, carrying `sub` (user id), `org_id`, `role`. The Ad Manager **verifies that token** and reads the claims. No Supabase Auth, no JWKS, no login UI of its own (login goes through the backend's `/auth`).
- **Org model = the existing `organizations` table** (varchar id) — which already holds the spec §3 knowledge base (`services`, `pricing_min/max`, `competitors`, `brand_voice`, `languages`, `usps`, `strict_lead_scoping`, `alert_config`). Drop the duplicate `organisations`/`org_knowledge`/`profiles`/`org_members`.
- **User model = the existing `users` table** (`org_id`, `role`, `hashed_password`).
- **Leads = the existing `leads` table** (shared). Campaign-attribution columns (`source_campaign`, `source_ad_id`, `meta_lead_id`, `platform`) to be added **additively + coordinated with the backend team's Alembic models** (so autogenerate won't drop them).
- **Security = app-layer org scoping (no RLS)** — matches the backend (trusted server connects as postgres/service-role; every query scoped by the JWT's `org_id`). RLS dropped; our HS256 JWTs aren't Supabase-issued so `auth.uid()` RLS can't apply anyway.
- **Gemini = mirror the backend's `gemini.py`** — REST `generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent`, `x-goog-api-key` header, comma-separated `GEMINI_API_KEYS` rotated on 429/503, `thinkingConfig.thinkingLevel` from `GEMINI_THINKING_LEVEL`. `gemini-3.5-flash` and the `AQ.` key format are **confirmed valid** (in production use by the backend).
- **Kept, genuinely-new ad tables:** `meta_connections`, `google_connections`, `oauth_states`, `campaigns_cache`, `keywords_cache`, `social_metrics`, `social_connections`, `social_metrics_history`, `research_jobs` — `org_id` (text) scoped in code to `organizations.id`.

The migrations `0001`/`0002` (applied) are reconciled by `0003_integrate_shared_model.sql` (drop duplicates, restore `leads`, drop RLS). Plan 1 Tasks 6–7 (db.js) target the shared schema per the above.

## 2. Goals (Phase-1)

1. Migrate persistence **SQLite → Supabase Postgres** with **Row-Level Security**, real **Supabase Auth** (users → org membership → roles), and **Supabase Storage** for assets/reports.
2. Swap the AI/provider stack to a **free-only** footing: **Gemini** as the single required LLM (via the provided env), **remove Mistral** (only hard-paid dep), keep Groq/Tavily/OpenRouter optional, **DuckDuckGo** keyless search fallback.
3. **Meta:** keep direct Graph API as the primary path; expose the **full external MCP tool catalog (~135)** to the AI Analyst via a hybrid router; make it reliable and env-driven.
4. **Deep Research** sidecar re-platformed from Mistral → Gemini (LLM + embeddings), so it stays free.
5. **Verify graceful Facebook degradation** with dev-mode-only credentials (App ID/Secret, no production access).
6. Add a **real automated test suite** (currently zero) + run the security-review skill on the diff.

### Non-goals (explicit)

- Telecaller Portal, Founder Portal, the call-transcript→ad-targeting loop.
- The always-on ROI-monitor agent, the auto monthly report, the full unified dashboard, the social engagement module (these are later slices; the data model here must not block them).
- Frontend framework migration (stays single-file UI + a new login screen).
- Containerization / CI-CD / durable job queue / Redis (later phases per `ARCHITECTURE.md`).

## 3. Locked decisions

| Decision | Choice |
|---|---|
| Base repo | `Ad_Manager-main`, port `developer`'s tool breadth |
| Scope | Phase-1 foundation (see Goals) |
| Meta architecture | Graph API primary + full MCP catalog via hybrid router |
| Meta tool breadth | **All ~135** exposed to AI (deviation from Plan doc's "curate 25" — deliberate) |
| Deep Research | Re-platform Mistral → Gemini |
| Auth | ~~Full Supabase Auth + RLS~~ -> Backend HS256 JWT (shared identity provider); app-layer org scoping, no RLS (see section 1a) |
| DB access | supabase-js (service-role) + pg for migrations; lib/db.js becomes async, targets shared schema (see section 1a) |
| Gemini SDK | Migrate `@google/generative-ai` (deprecated) → `@google/genai` |
| Build location | In place in `Ad_Manager-main`, `git init` for reviewable history |
| Commits | Only when the user explicitly asks (per user global rules) |

## 4. Target architecture

```
Browser (public/index.html + NEW login screen)
   │  Supabase Auth (email + magic-link) → JWT in session
   ▼
Node + Express (3001)
   │  NEW: auth middleware → verify Supabase JWT → resolve user → org_id + role
   │  every /api request runs as that user (RLS enforced at Postgres)
   ├─ Supabase Postgres     ← replaces SQLite; RLS on org_id; per-request JWT client
   ├─ Supabase Storage       ← replaces local output/ + creative assets
   ├─ Meta Graph API v19     PRIMARY — metaGraph.js, per-org token (Tier 1, ~27 tools)
   ├─ Meta MCP server (ext.)  Tier 2 — full ~135 catalog, workspace-aware proxy, pooled
   ├─ Gemini (@google/genai)  the ONE required LLM; key rotation + thinking level from env
   ├─ Groq / DuckDuckGo       optional free fallbacks (Tavily optional if key valid)
   └─ Python sidecar (8000)   Deep Research; Mistral → Gemini (LLM + embeddings)
```

Backend stays a Node/Express monolith + Python sidecar (correct for this stage per `ARCHITECTURE.md`).

## 5. Data model + multi-tenancy

Port the 12 existing SQLite tables to Postgres via **Supabase CLI migrations** (versioned SQL under `supabase/migrations/`, forward-only for now). Add auth/tenancy tables:

- `profiles` — 1:1 with `auth.users` (display name, etc.).
- `organisations` — existing; add `owner_id` (→ `auth.users`), keep `id`, `name`, `website`, `industry`.
- `org_members` — `(org_id, user_id, role)`; `role` enum: `owner | ad_manager`.
- All tenant tables keep an `org_id` FK.

**RLS pattern (applied to every tenant table):** a row is visible/writable only when
`org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())`.
One reusable policy template; write policies additionally gate destructive ops by role where relevant.

**Token tables** (`meta_connections`, `google_connections`, `social_connections`): remain **encrypted at rest** (keep `crypto.js` AES-256-GCM) **and** RLS-protected. Tokens are never returned to the browser.

**Data access:** two Supabase clients —
- *per-request JWT client* (RLS applies) for all normal `/api` work;
- *service-role client* (bypasses RLS) used **only** for webhooks + background jobs that have no user context (e.g. Meta lead webhook, future ROI monitor).

`lib/db.js` keeps its function interface but the implementation becomes **async** (`@supabase/supabase-js` is promise-based). All callers get `await`; this is a broad but mechanical change to be done carefully with tests.

**Existing local data** (`leadpilot.db`) is dev-only prototype data; a one-off import script is optional, not required for pilot.

## 6. Auth model

- **Supabase Auth**: email + magic-link (password optional). Sessions carry the Supabase JWT.
- **Onboarding**: first sign-in creates a `profile`; user either creates an org (becomes `owner`) or is invited into one (`org_members`).
- **Express middleware**: verifies the JWT (Supabase JWKS), loads `user_id`, resolves memberships → active `org_id` + `role`, attaches a per-request Supabase client. Replaces today's shared per-org token gate in `authz.js` (which we keep for service-to-service checks).
- **Role gating**: `owner` can manage members + connections; `ad_manager` can run all ad workflows. Spend/write and destructive Meta ops require an authenticated user (and the existing human-confirm step).

## 7. AI + provider layer

- **SDK**: migrate `@google/generative-ai` → **`@google/genai`** (current 2026 SDK, supports thinking config).
- **Env mapping** (from the provided config):
  - `REASONING_PROVIDER=gemini` — selects primary provider.
  - `GEMINI_API_KEYS` (plural, comma-separated) — round-robin rotation; on 429/quota, advance to the next key before falling back.
  - `GEMINI_MODEL` — model id (e.g. provided `gemini-3.5-flash`); no longer hardcoded.
  - `GEMINI_THINKING_LEVEL` — mapped to the SDK thinking/`thinkingConfig` param.
- **Remove Mistral entirely** (Node + Python). Deep Research LLM + RAG embeddings → Gemini (`text-embedding-004` free tier or current equivalent).
- **Optional free fallbacks**: Groq (if `GROQ_API_KEY` valid), OpenRouter (free models, if key), Tavily (if key valid) → else **DuckDuckGo** (keyless). Absent/dead keys must never crash — the runner probes availability and skips.
- **Startup health-check** `/health`: performs one real Gemini ping and reports `{ gemini: bool, model: <resolved>, search: <tavily|ddg> }`. This immediately validates the unusual `AQ.Ab8…` key and the `gemini-3.5-flash` model id instead of failing mid-request.

## 8. Meta integration — all ~135 tools, seamless + reliable

**Two-tier hybrid router.** The AI Analyst can call the entire MCP catalog; each call routes to the most reliable executor:

- **Tier 1 — curated (~27), direct Graph API** (`metaGraph.js`): high-frequency + write-critical tools. Fast, no subprocess, per-org token. This already exists in `main` and aligns with the Plan doc's finalized 25.
- **Tier 2 — the full external MCP catalog (~135)**: every remaining tool exposed and callable through the **workspace-aware MCP proxy** (per-org token injected into the MCP server env). Port the extra tool declarations from `developer` and add whatever the MCP server exposes beyond them.
- **Routing rule**: if a tool has a Graph implementation → use it; else → MCP. On MCP failure, Graph tools remain up; MCP-only tools return a clear, honest error.

**Reliability ("seamless") work:**
- Remove the hardcoded `/Users/dheerajkurupati/…` path → fully env-driven (`META_MCP_COMMAND`/`META_MCP_SCRIPT` or module), cross-platform (Windows + Linux).
- **Install/vendor the MCP server** into the repo and document it in `SETUP.md`; add a `listTools` smoke check so the real catalog count is verified at deploy (we assume ~135; confirm on install).
- **Pooled/warm MCP client per org** (idle-evicted) instead of spawn-per-call, to keep latency low.
- **Tool exposure to Gemini**: expose all tools, but use **category-based filtering / progressive disclosure** so 135 declarations don't degrade tool-selection accuracy or blow the context window. All remain reachable.
- **Destructive tools** (`delete_campaign`, permanent removals) are available but require the existing human-confirmation gate before executing.

**Honesty boundary:** "seamless" means the plumbing is flawless and every tool is callable. Tools needing production Meta permissions still return Meta's real permission errors until App Review + Business Verification clear — that is Meta's gate, not our code.

## 9. Graceful Facebook degradation (verification goal)

With only `META_APP_ID`/`META_APP_SECRET` in dev mode (no production access), verify and document that:
- Connecting/writing returns clear "connect your Meta account" / Meta's real OAuth errors — never a crash or blank screen.
- All non-Meta features (AI chat, keyword research, ad-copy generation, Deep Research, lead pipeline) work fully without any Meta account.
- The UI stays usable; Meta panels show honest empty/error states.
- Deliverable: a short "how it reacts" report of the observed behavior.

## 10. Deep Research sidecar

- Replace Mistral with Gemini for section generation and Q&A.
- Replace Mistral embeddings with Gemini embeddings in the RAG store; re-embed on first run.
- Keep the Tavily-primary → DuckDuckGo-fallback search already in place (Tavily optional).
- Keep parallel section generation, WAL, and startup job reconciliation (already fixed in `main`).
- Move generated `output/` deliverables to Supabase Storage.

## 11. Configuration / env

New `.env` schema (superset), documenting the provided values:

```
# Reasoning
REASONING_PROVIDER=gemini
GEMINI_API_KEYS=<comma-separated>
GEMINI_MODEL=gemini-3.5-flash
GEMINI_THINKING_LEVEL=low

# Supabase (org: ekeszqwbqtyahnqgamqz / project ref: otbdjrexiscbxqlcnnvx)
SUPABASE_URL=https://otbdjrexiscbxqlcnnvx.supabase.co
SUPABASE_ANON_KEY=          # TO BE PROVIDED
SUPABASE_SERVICE_ROLE_KEY=  # TO BE PROVIDED (secret — .env only, never committed)
SUPABASE_DB_URL=            # TO BE PROVIDED (secret — for CLI migrations)

# Meta (dev mode — graceful-fail expected)
META_APP_ID=
META_APP_SECRET=
META_REDIRECT_URI=http://localhost:3001/auth/meta/callback

# Meta MCP (Tier 2) — env-driven, cross-platform
META_MCP_COMMAND=
META_MCP_SCRIPT=

# Optional free fallbacks (skipped if absent/invalid)
GROQ_API_KEY=
TAVILY_API_KEY=
OPENROUTER_API_KEY=

# Security
TOKEN_ENC_KEY=             # 32-byte hex; falls back to SESSION_SECRET derivation
SESSION_SECRET=
```

**Removed:** `MISTRAL_API_KEY`, all Mac-specific MCP paths.

## 12. Testing + verification

- **Vitest** suite (Node side), added to `package.json`:
  - RLS isolation: org A cannot read/write org B's rows (the core multi-tenant guarantee).
  - Auth middleware: valid/invalid/expired JWT, role gating.
  - Gemini provider: key rotation on 429, thinking-level pass-through, model from env.
  - Provider fallback: dead Groq/Tavily keys degrade cleanly to Gemini + DuckDuckGo.
  - DB layer async correctness.
  - Meta graceful failure: no-connection and bad-token paths return clean errors.
  - MCP router: Graph-first selection, MCP fallback, MCP-down degradation.
- **`security-review` skill** run on the finished diff (RLS, token handling, SSRF).
- **`/health`** manual check against the real Gemini key/model.

## 13. Risks + open items

| Item | Note |
|---|---|
| Gemini key format `AQ.Ab8…` + model `gemini-3.5-flash` | Unusual key format / possibly non-standard model id. `/health` validates on boot; may need a corrected key/model. |
| Supabase credentials | URL + anon + service-role + DB URL needed before build can connect. |
| MCP catalog count | "~135" assumed; confirmed at install via `listTools`. Which server (mikusnuz vs serkanhaslak) to standardize on — confirm. |
| 135 tools vs LLM accuracy | Mitigated by category filtering / progressive disclosure; monitor. |
| Meta production access | Managing *other* orgs' accounts needs App Review + Business Verification (Meta's clock). Own-account works in dev mode. |
| async `db.js` refactor | Broad caller changes; covered by tests. |

## 14. Rollout order (feeds the implementation plan)

1. `git init` the base; land env schema + `/health` skeleton.
2. Supabase project wiring + migrations (schema + RLS) + async `db.js` on `@supabase/supabase-js`.
3. Supabase Auth + membership/roles + Express JWT middleware + login screen.
4. AI layer: `@google/genai` swap, env-driven Gemini, key rotation, remove Mistral, fallbacks.
5. Meta hybrid router: env-driven MCP path, pooled client, port developer tools, expose full catalog, graceful-fail verification.
6. Deep Research re-platform to Gemini + Storage.
7. Test suite + security-review + `/health` validation.

Each step is independently shippable and testable.
