# Architecture — current design & evolution plan

An honest picture of how the Ad Manager Portal is built today, what's good, what's limited, and the order in which to upgrade it. Written so both engineers and non-engineers can follow it.

---

## 1. One-line verdict

It is a **solid, appropriately-simple prototype** — correct for a pre-launch pitch and a first pilot, **not** a scaled production stack yet. **Do not rewrite it entirely.** Keep the parts that hold real value and evolve the infrastructure as paying pilots arrive.

---

## 2. What it is today

Two processes:

| Process | Tech | Port | Job |
|---|---|---|---|
| Ad Manager server | Node.js + Express | 3001 | Serves the UI and all `/api`, `/auth`, `/social` endpoints |
| Research sidecar | Python + FastAPI | 8000 | Deep-research jobs + per-company RAG chat |

```
Browser (single-file UI, public/index.html)
   |
   v
Node + Express (3001) ── SQLite (leadpilot.db, better-sqlite3)
   |  |  |  |
   |  |  |  └─ Python research sidecar (8000) ── SQLite (jobs.db) + RAG store (files)
   |  |  |                                        Mistral + Tavily→DuckDuckGo + trafilatura
   |  |  └─ Meta Graph API v19 (direct, per-org token)
   |  └─ Gemini / Groq / OpenRouter (AI analyst, keywords, copy)
   └─ Playwright (website scraping), Tavily (competitor search)
```

Key technology choices as built:
- **Data:** SQLite through `better-sqlite3` (synchronous, single-writer).
- **Frontend:** one hand-written HTML file, vanilla JavaScript, no build step, no framework.
- **Language:** JavaScript (no TypeScript) on the Node side; Python on the sidecar.
- **Multi-tenant:** every request is scoped by an organisation id plus a per-organisation secret token.
- **Meta:** direct Graph API calls (not an MCP subprocess — see `META_INTEGRATION.md`).
- **Jobs:** research runs as in-process background tasks.
- No containers, no CI/CD, no message queue, no cache layer, no automated test suite committed.

---

## 3. What is genuinely good (keep)

- **Right-sized for the stage.** A monolith + one sidecar + a simple UI is a legitimate MVP shape. It iterates fast and is not over-engineered.
- **The research engine is correctly isolated** in its own process, so heavy Python work stays off the Node event loop.
- **Direct Graph API for Meta** is the correct choice for a multi-tenant product (reasoning in `META_INTEGRATION.md`).
- **Security baseline** is real: per-org auth on every data/action route, OAuth tokens encrypted at rest, SSRF and path-traversal guards.
- **AI provider fallback** (Gemini → Groq → OpenRouter) is sensible resilience.
- **The domain logic, the Graph adapter, the AI runner, and the research/RAG engine are the real IP** and should carry forward unchanged.

---

## 4. Known limits (ranked by impact)

1. **SQLite + synchronous driver** — single-writer, blocks the event loop per query. Fine on one box for a pilot; will not carry heavy multi-tenant load. The product blueprint's own target is **PostgreSQL with row-level security**.
2. **No committed automated tests.** Verification so far has been ad-hoc.
3. **No schema migrations** — tables are created ad-hoc; no versioned migration tool.
4. **No TypeScript** — no type safety across a growing, multi-portal codebase (the blueprint calls for a TypeScript monorepo).
5. **Single-file vanilla-JS UI (~2,000 lines)** — works and looks good, but no components/state/build. Becomes hard to maintain across three portals.
6. **In-process research jobs** — no durable queue; a restart mid-job is only patched by startup reconciliation, not true resume.
7. **No containerization, CI/CD, caching, or observability.**
8. **Auth is a shared per-org token, not user accounts/roles (RBAC).**
9. **Meta token refresh and rate-limit handling** are not implemented yet (blockers 5 and 6 in `BLOCKERS.md`).

---

## 5. Keep / Evolve / Replace

| Layer | Verdict |
|---|---|
| Domain logic, Meta Graph adapter, AI runner, research/RAG engine | **Keep** |
| Security layer (auth gate, token encryption, SSRF guards) | **Keep** |
| SQLite → **PostgreSQL + versioned migrations** | **Replace** — when pilots sign |
| In-process jobs → **durable queue** (BullMQ / Celery) | Replace at scale |
| Plain JS → **TypeScript** | Evolve gradually |
| Single-file UI → **component framework** (React/Svelte) + build | Evolve — once the 3 portals grow |
| Automated **tests + CI + Docker** | Add incrementally |
| Shared token → **user accounts + RBAC** | Evolve before real multi-user orgs |

Nothing in the "Keep" row should be thrown away. A full rewrite would discard working code and IP for no near-term gain.

---

## 6. Phased evolution plan

**Phase 0 — now (pitch / first pilot):** change nothing structural. The current stack runs, is secure enough, and demos. Finish the remaining feature/test work, not the plumbing.

**Phase 1 — first paying pilots:**
1. **PostgreSQL + migrations** (replace SQLite; add row-level security for tenants).
2. **Automated tests + CI** (lock in what works before it grows).
3. **Meta token refresh + rate-limit handling** (`BLOCKERS.md` 5 and 6).

**Phase 2 — scaling past a handful of clients:**
4. **Durable job queue** for research and any long tasks.
5. **TypeScript** migration (incremental, module by module).
6. **Containerize + deploy pipeline + basic observability** (logs/metrics/alerts).
7. **Redis cache** for insights and rate-limit smoothing.

**Phase 3 — the full three-portal product:**
8. **Component-based frontend** with a shared design system across Ad Manager, Telecaller, and Founder portals.
9. **User accounts + RBAC** and per-tenant audit logs (also needed for DPDP compliance).

Each step is independently shippable — this is an evolution, not a from-scratch rebuild.

---

## 7. Bottom line

- **Not** "god-mode / most-optimized."
- **Not** garbage either.
- A **pragmatic prototype that is correct for pre-launch**, with a clear, ordered path to a production-grade 2026 stack.
- The mistake would be *either* pitching it as bulletproof scale *or* rewriting it all before there are customers. Do neither. Ship the pitch, then evolve on the schedule above.
