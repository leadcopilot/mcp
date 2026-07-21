# Deliverables — Meta tools + Supabase

What we have, what to build next, and the database move. Written to be actionable and honest.

---

## 0. Where we are (one line)

Meta runs on the **direct Graph API** (not an MCP). **25 tools are built** (every one useful for a lead-gen product). Data currently lives in **SQLite**; the deliverable is to move it to **Supabase (Postgres)**.

> **Important reconciliation — the "29 vs 77 tools" numbers.** The official Meta doc lists **29** tools (its hosted connector). The old blueprint mentioned **77** tools (a third-party fork, `serkanhaslak/meta-mcp`). Neither is a ceiling: the underlying Meta Marketing API has **hundreds** of operations, and because we call it **directly**, we can implement **any** of them — we are not limited to a fork's count. So the real question is not "which of the 77," it's **"which Meta capabilities does this product actually need next"** — answered in Deliverable 1.

---

## Deliverable 1 — Meta tool roadmap (what to build next)

### 1a. Already built (25)
Connect account, list/create/update campaigns · list/create/update ad sets · list/create ads · list/create creatives · ad preview · upload image · insights (campaign/ad-set/ad) · delivery estimate · targeting insights · interest search · custom audiences (list + create, seed from leads) · lookalike audiences · saved audiences · account info + list ad accounts · delivery check · account quality · ad library search · per-form leads.

### 1b. Build next — prioritized (each is ~15–45 min: a case in `metaGraph.js` + register the tool)

| Priority | Capability (tool) | Why this product needs it |
|---|---|---|
| **MUST** | **Lead form read/create** (`get_lead_forms`, `create_lead_form`) | Real lead-gen ads need a lead form (`promoted_object`). Today the publish wizard downgrades to link-clicks because no form exists. This is the gap that makes lead-gen ads real. |
| **MUST** | **Sync leads → custom audience** (`add_audience_users` as its own action) | The core loop: push captured/qualified leads into a Meta audience for retargeting. (We can add users during create today; this makes it an ongoing sync.) |
| **SHOULD** | **update_ad** (edit/pause a single ad) | We can pause campaigns and ad sets; finish the set so an ad can be paused/edited too. |
| **SHOULD** | **Insights breakdowns** (age / gender / placement / region) on `get_insights` | "Which audience/placement is wasting budget" — a real ad-manager question. Just a `breakdowns` param. |
| **SHOULD** | **copy_campaign / duplicate** | A/B test a winning campaign (blueprint's "A/B test winning campaigns"). |
| **SHOULD** | **create_ad_rule** (automated rules) | Auto-pause when CPL > threshold (blueprint's "set automated rules"). High value for hands-off management. |
| **LATER (moat)** | **Conversions API** (send offline/call conversions back to Meta) | When the Telecaller loop exists, feed *qualified-call* outcomes back so Meta optimizes toward real conversions — the actual differentiator. |
| **LATER** | Async/large-report insights | Only needed for very large accounts. |
| **SKIP** | `delete_campaign`, catalog/pixel tools | Delete = safety risk (we use Pause). Catalog/pixel = e-commerce, not lead-gen. |

**Net:** the two **MUST** items (lead forms + lead→audience sync) are what turn "we can create ads" into "we run real lead-gen ads and close the loop." Everything else is incremental.

---

## Deliverable 2 — Move the database to Supabase (Postgres)

**Goal:** replace SQLite (`leadpilot.db`) with Supabase Postgres, so the product survives real multi-tenant load and matches the blueprint's "PostgreSQL with RLS" target. Meta tokens and the campaign cache move here too.

### 2a. What moves
The 11 Node tables in `lib/db.js`:
`organisations`, `meta_connections`, `google_connections`, `oauth_states`, `org_knowledge`, `leads`, `campaigns_cache`, `keywords_cache`, `social_connections`, `social_metrics_history`, `research_jobs`.

Optional (recommended) second phase:
- The sidecar's `jobs.db` → Supabase (durable job tracking).
- The RAG store (currently JSON files with Mistral embeddings) → Supabase **pgvector** for proper vector search instead of loading whole files in memory. Strong architectural win.

### 2b. How (smallest safe path)
1. Create a Supabase project → get the Postgres **connection string** + **service key**.
2. Port the schema to SQL migrations (Supabase migrations). One-to-one with the current tables; add proper types, indexes, and foreign keys.
3. Swap `lib/db.js` from `better-sqlite3` to the **`pg`** Postgres client (our queries are already raw SQL, so this is a mechanical rewrite, not a redesign). Use the Supabase connection string.
4. **Keep the existing AES-256-GCM token encryption** — store *ciphertext* in Supabase (defense in depth; don't rely on the DB alone). Optionally use **Supabase Vault** for the encryption key.
5. **Enable Row-Level Security** per org (the blueprint's RLS). Server uses the service role and still enforces org scoping in app code; RLS is the backstop. When user accounts land later, tie RLS to `auth.uid()`.
6. Migrate any existing local data (or start fresh — it's a pilot DB).

### 2c. Effort & sequencing
- Schema port + `lib/db.js` rewrite + token-encryption carry-over + test: **~2–4 days**.
- pgvector RAG move (optional): **+1–2 days**.
- Do this in **Phase 1** (first paying pilots) per `ARCHITECTURE.md` — not required for the pitch demo, which runs fine on SQLite.

### 2d. Why Supabase specifically
Hosted Postgres (no DB ops), built-in Auth (helps the future RBAC deliverable), Storage, Realtime, and **pgvector** for RAG — all in one, generous free tier, fast to adopt. It covers three future needs (Postgres, auth, vector search) in one platform.

---

## Deliverable 3 — Remaining Meta hardening (from BLOCKERS.md)

| Item | What | Effort |
|---|---|---|
| **Token refresh** | Meta long-lived tokens expire ~60 days; auto-refresh or prompt reconnect (blocker 5) | ~half day |
| **Rate-limit / retry** | Backoff on Graph calls before heavy multi-client load (blocker 6) | ~half day |
| **Lead webhook live** | Set `META_WEBHOOK_VERIFY_TOKEN`, expose via tunnel/domain, subscribe the Page | 30–60 min after app exists |

---

## Deliverable 4 — Architecture upgrades (detail in `ARCHITECTURE.md`)

Yes, the architecture work is a set of deliverables too. **None are needed for the pitch** (Phase 0 = keep the current stack — it runs and demos). They land once there are paying pilots. The Supabase migration (Deliverable 2) is the first of these.

| Deliverable | Phase | Why | Effort |
|---|---|---|---|
| **Supabase (Postgres) migration** — see Deliverable 2 | 1 | Removes the SQLite scale limit; matches the "Postgres + RLS" target | 2–4 d |
| **Automated tests + CI** | 1 | Lock in what works before the codebase grows | 2–4 d |
| **Durable job queue** (research + long tasks) | 2 | Jobs survive restarts / can resume | 2–3 d |
| **TypeScript migration** (incremental) | 2 | Type safety across a growing multi-portal codebase | ongoing |
| **Containerize + CI/CD + observability** (logs/metrics/alerts) | 2 | Repeatable deploys, visibility in production | 3–5 d |
| **Redis cache** | 2 | Insights caching + rate-limit smoothing | 1–2 d |
| **User accounts + RBAC + audit logs** | 3 | Real multi-user orgs; also needed for DPDP | 1 wk+ |

> **Frontend is owned by a separate team** and is not tracked in this doc (the current UI stays as-is; a component-based rebuild, if any, is their scope).

---

## Summary — all deliverables

| # | Deliverable | Priority | Owner | Effort |
|---|---|---|---|---|
| 1a | 25 Meta tools built | Done | — | done |
| 1b-MUST | Lead forms + lead→audience sync | High (moat) | Us | ~1 day |
| 1b-SHOULD | update_ad, insight breakdowns, copy_campaign, ad rules | Medium | Us | ~1–2 days |
| 1b-LATER | Conversions API (call-loop) | After Telecaller portal | Us | TBD |
| 2 | **Supabase (Postgres) migration** incl. tokens + cache | High (Phase 1) | Us | 2–4 days (+1–2 pgvector) |
| 3 | Token refresh + rate limits + webhook | Medium | Us | ~1.5 days |
| 4 | **Architecture upgrades** (tests/CI, queue, TypeScript, containers, cache, RBAC) | Phase 1–3 | Us | see above |

**Order:** #1b MUST + #2 Supabase + tests/CI (first pilots) → #3 hardening → #4 remaining architecture + #1b SHOULD/LATER as the product grows.

> **Not in this doc:** the **frontend** (owned by a separate team) and **client-side prerequisites** like the Meta app credentials (tracked in `SETUP.md` / `BLOCKERS.md`).
> **Phase 0 (the pitch) needs none of Deliverable 4** — the current architecture is correct for a demo/pilot; these are the "make it production-grade" items, sequenced in `ARCHITECTURE.md`.
