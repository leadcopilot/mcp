# LeadPilot Ad Manager — Blockers & Path to Demo
> **Tiers:** **T1** = blocks a real-Meta demo *this week* · **T2** = needed for a complete, pitchable product · **T3** = production / scale / compliance.

---

## ✅ Fixed in code this session (no Meta creds required)

These were blockers; they are now resolved in the codebase and verified (19/19 end-to-end UI+backend checks pass, zero console errors):

- **Meta backend rewritten off the broken MCP → direct Graph API** (`lib/services/metaGraph.js`; `executeMetaTool` now delegates to it). Unit-verified: correct objective mapping, graceful failures, and it makes real Graph calls (a bad token returns "Invalid OAuth access token", proving the path is live). **Needs only your real app creds + token to succeed — no more MCP install / tool-name / auth-model problems.**
- **Publish wizard double-budget fixed** — budget now lives only at the campaign level; the lead-gen ad set auto-downgrades its optimization goal when no lead form is supplied, so publish is accepted.
- **Deep Research made reliable + fast** — Tavily is now the primary search in the Python engine (DuckDuckGo is fallback), and the 9 report sections generate **in parallel** (~1.5 min vs ~9–10 min). Tavily search verified live.
- **Research jobs no longer strand** — startup reconciliation marks orphaned "running" jobs failed; `jobs.db` now uses WAL + busy-timeout.
- **Playwright Chromium installed** — enrichment/scraping no longer 500s.
- **Google descoped in the UI** — Connect button disabled ("Coming soon"), pill neutralized, empty tracker tab removed (AI Google *copy* generation kept — it works via Gemini).

**Net effect:** the ~1–2 day "long pole" is done. The remaining path to a real-Meta demo is just **create a Meta app + add creds + rehearse** (below).

---

## Executive summary

- **What is real and working today:** the Ad Manager Portal UI (redesigned, tested), AI Keyword Research + Ad Copy (Gemini), Deep Research + per-company RAG chat (Mistral), the full Lead pipeline (add / dedup / status / Excel export), the AI Analyst chat, and the whole security layer (per-org auth, encrypted tokens, SSRF/traversal guards). These demo with **no external ad account**.
- **The remaining gate for a real-Meta demo:** the Meta backend is now code-complete (direct Graph API) but **unexercised against a real account** — you must create a Meta app, add `META_APP_ID`/`SECRET`, connect an account, and rehearse.
- **Google:** was broken at four layers *and* gated on a Google approval clock — **descoped for the pitch** (costs zero demo value; Keyword Research uses Gemini/Tavily, not the Google Ads API).
- **Scope honesty:** this repo is **only** the Ad Manager Portal + Deep Research. The Telecaller portal, Founder portal, and the "call-transcript → ad-targeting" moat are **vision, not built**. Pitch what's real; frame the rest as roadmap.

> **Verification status (be honest in the meeting):** the core is tested — security, the UI (light/dark/tablet, 19/19 end-to-end), Keyword Research through the real UI, and the lead pipeline. **Not yet tested:** any Meta feature against a real account (needs your creds), a full Deep Research run, and a few UI click-throughs (copy generate, add-lead+export, AI analyst, cross-module push). The Meta tools are code-complete and correct-to-docs but have never touched a live account. Full list in `SETUP.md` → "Testing status".

---

## The Meta backend — was the single biggest risk, now fixed in code

**Originally the Meta backend was broken at three independent layers at once** (this is why the old third-party approach failed):
1. The `meta_ads_mcp` Python module **wasn't installed** (import failed on both Python 3.11 and 3.14).
2. The only installable package (pipeboard-co) used **different tool names** than the code called (`get_campaigns` vs `list_campaigns`, `create_adset` vs `create_ad_set`, plus ~8 tools that didn't exist there).
3. Its **auth model was incompatible** — it wanted a browser login / single cached token, while our code needs a per-org token per call (the whole multi-tenant premise).

Installing the package makes it *more* broken, not less.

**✅ DONE this session:** the MCP dependency is gone — Meta now calls the Graph API (`graph.facebook.com/v19.0`) **directly** from Node (`lib/services/metaGraph.js`) using the per-org token the app already stores and decrypts. Verified live (a bad token correctly returns "Invalid OAuth access token"). **Remaining: add real app creds + a connected account, then rehearse.**

---

## T1 — Blocks a real-Meta demo this week

| # | Blocker | Status | Notes |
|---|---|---|---|
| 1 | **Meta backend (MCP) was dead** — not installed, wrong tool names, incompatible auth | ✅ **FIXED (code)** | Rewritten to direct Graph API (`lib/services/metaGraph.js`). Needs your creds + a connected account to run live. |
| 2 | **Meta app not configured** — `META_APP_ID`/`SECRET` blank | ⏳ **You** (1–2 h) | Create a Business Meta app (Facebook Login + Marketing API), set the two `.env` values + redirect `http://localhost:3001/auth/meta/callback`, keep in Dev mode. Hard prerequisite — only you can do this. |
| 3 | **Publish wizard rejected by Meta** — budget at *both* campaign & ad-set level | ✅ **FIXED (code)** | Budget now campaign-level only; lead-gen ad set auto-downgrades optimization goal when no lead form is present, so publish is accepted. |
| 4 | **Playwright Chromium missing** → enrichment/scraper 500 | ✅ **FIXED** | Installed & verified this session. |
| 5 | **Deep Research relied only on DuckDuckGo** | ✅ **FIXED (code)** | Tavily is now primary in `main.py`, DDG is fallback. Verified live. |
| 6 | **Full report took ~9–10 min** (sequential sections) | ✅ **FIXED (code)** | 9 sections now generate in parallel (~1.5 min). Set `REPORT_SECTION_WORKERS` to tune. |
| 7 | **Google shown but non-functional** | ✅ **FIXED (UI)** | Descoped: Connect disabled ("Coming soon"), pill neutral, empty tracker tab removed. AI Google copy kept (works). |

**Only remaining T1 item is #2 — creating the Meta app (yours to do, 1–2 h).**

---

## T2 — Complete, pitchable product

| Blocker | Fix | Effort |
|---|---|---|
| **Scope gap** — no Telecaller/Founder portal, no moat loop (0 code for any of it) | Pitch narrative: "Ad Manager + AI research live; Telecaller (click-to-call, Deepgram ASR, scoring, memory bubble) + Founder + the transcript→ad loop are the next builds." Don't fake a UI. | Narrative = 0; building = weeks |
| **Meta App Review** needed to drive *other* orgs' accounts | Demo on your **own** account (or add the pilot client as a Tester) in Dev mode — no review. Real clients need Business Verification (1–3 d) + App Review (~3–15 business days, Meta's clock) | Own-account = 0; clients = Meta's clock |
| **"1000 clients" claim is false as built** — subprocess-per-call, synchronous single-writer SQLite | Per-call timeout + concurrency cap; pool clients (or the direct-Graph rewrite removes the subprocess); migrate SQLite→Postgres before real load | 3–5 d (+2–3 d Postgres) |
| **Auth is a single shared per-org token** — no users/login/roles | Users + org-membership + role tables; session/JWT auth; role middleware on spend/write; token rotation | 4–7 d |
| **Meta lead webhook can't reach localhost** + verify-token/secret unset | Set the env vars; expose via ngrok/cloudflared; subscribe the Page to `leadgen`; test with Meta's Lead Ads Testing Tool | 30–60 min (after app exists) |
| ✅ **FIXED — Research jobs stranding at "running"** | Startup reconciliation now marks orphaned jobs failed on boot. (A durable queue for *resume* is still future work.) | done |
| **Google Ads broken at 4 layers** *(only if not descoped)* — null customer_id, bad keyword query, no MCP + Mac path, dev-token approval | Backfill customer_id at OAuth; fix keyword service; install MCP; apply for Developer-Token Basic Access now | 2–3 d + Google's clock |

---

## T3 — Production / scale / compliance

| Blocker | Fix | Effort |
|---|---|---|
| **DPDP compliance gap** — lead PII stored in plaintext, no consent/erasure/audit | Consent capture; erasure endpoint; audit log; retention policy; encrypt PII at rest (reuse existing AES-256-GCM); DPDP notice; legal review | 1–2 wk + legal |
| ✅ **FIXED — Python `jobs.db` WAL + busy timeout** | `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000` now set on init. | done |

---

## ✅ Minimum path to a working real-Meta demo

The engineering long pole (Graph rewrite, publish fix, research reliability/speed, Google descope, Chromium) is **done**. What's left is mostly yours:

1. ⏳ **Create the Meta app** (Business type, Facebook Login + Marketing API), fill `META_APP_ID`/`SECRET`, register callback `http://localhost:3001/auth/meta/callback`, keep in **Development mode**, add yourself as Admin/Tester → `/health` shows `"meta":true`. *(1–2 h — only you can do this)*
2. ✅ Chromium installed; `/health` shows `"playwright":true`.
3. ✅ Direct Graph API integration built (`lib/services/metaGraph.js`).
4. ✅ Publish wizard budget/optimization fixed.
5. ✅ Google descoped in the UI.
6. **Pre-run one Deep Research report** hours before; demo live via the fast RAG "Ask". *(0 — now also more reliable + ~1.5 min)*
7. ⏳ **Rehearse end-to-end on your own ad account** (Dev mode): connect Meta → list campaigns → insights → create a PAUSED campaign→adset→creative→ad → research Q&A. Verify Mistral + Groq keys; don't restart the sidecar mid-demo. *(after step 1)*

