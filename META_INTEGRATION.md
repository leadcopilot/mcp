# Meta Integration — Response to `meta_ads_mcp_docs 2.docx`

This document answers one question: **does our build follow the approach in that doc, and what's actually implemented vs. blocked?** Written to be read by anyone (technical or not).

---

## 0. In plain English (start here)

**What the doc is:** a ready-made "chat with your ads" tool from Meta (`mcp.ads.meta.com`). Meta runs it. It's built for **one person controlling their own account**, and it's still in **test phase**.

**What we did instead:** we connect to Meta's ad system the **direct, standard way** and keep each client's login ourselves, so our system can act for **many clients** at once.

**Easy way to picture it:** the Meta tool is like a **ride-share** — quick, but someone else drives and you're stuck if their app is down. Our way is like **owning the car** — a bit more upkeep, but we control it and we're never stranded. The Meta doc itself says: for a real product that spends money, use the direct way (which is what we did).

**How many of Meta's 29 tools did we build?** **25 of 29 — every tool useful for this product.** That covers connecting an account, reading campaigns/ad-sets/ads and their performance, building and launching ads, uploading images, building audiences and lookalikes from your captured leads, checking why an ad isn't spending, and competitor ad research. The **4 we left out are deliberate:** deleting campaigns (left out for safety) and the 3 product-catalog/pixel tools (those are for e-commerce shops, not a lead-generation product). So nothing useful is missing — the 4 gaps are intentional, not a shortfall.

**What's stopping a live Meta demo right now?** One thing on the critical path: **you create a Meta app and give us two secret keys.** Without that, nobody can connect a Meta account. Everything else is either finished or is a smaller piece of work (see Blockers below). Your **own** ad account works immediately once those keys are in — no Meta approval needed; approval is only needed to run *other people's* accounts.

The rest of this document is the detailed version of the above.

---

## 1. The short version

The doc describes Meta's **official hosted MCP connector** (`mcp.ads.meta.com`) — a natural-language tool where one person signs in with their own Meta account and Meta runs everything on their servers. It is marked **open beta** in the doc.

**We did not build on that connector. We built a direct integration with Meta's own Graph/Marketing API instead.** This was a deliberate choice, and the same doc recommends it: its "For SaaS builders" section says do **not** rely on the beta connector as the only integration for a real product, and to use the direct Marketing API for anything that spends money.

Why the direct API is the right fit for us:

- Our product is **multi-tenant** — many client organisations, each with their own Meta account, under one system. The hosted connector is built for a single person / single Business Manager per session, so it does not fit that model cleanly.
- The hosted connector is **open beta**, has **no uptime guarantee**, and is **not security-certified** (all stated in the doc). That is not a safe sole foundation for a product we intend to launch.
- The direct API gives us full control over per-organisation tokens, error handling, and audit — which is what a real SaaS needs.

So: **not "as per that doc," and better for our use case** — a position the doc itself supports.

---

## 2. History (so everyone is on the same page)

1. The original code tried to use a **third-party copy** of a Meta MCP server run as a background process. It was broken three ways at once: not installed, its tool names did not match our code, and its login method could not use our per-organisation tokens.
2. We **removed that dependency** and replaced it with **direct Meta Graph API calls** (`lib/services/metaGraph.js`). This keeps the multi-tenant, per-organisation-token design and removes the broken moving parts.
3. The new code is complete and was verified to make real calls to Meta (a deliberately wrong token returns Meta's real "Invalid OAuth access token" error, which proves the path is live). **It has not yet been run against a real, connected ad account — that needs the app credentials below.**

---

## 3. Tool coverage — the doc lists 29 tools; here is our status

Status meaning: **Implemented** = built and calling the Graph API · **Partial** = related capability exists, not the full tool · **Not built** = not yet implemented.

### Campaign management (doc lists 10)
| Doc tool | Our status | Note |
|---|---|---|
| get_ad_accounts | Implemented | List the account(s) the user can use |
| get_campaigns | Implemented | Powers the Tracker + campaign list |
| create_campaign | Implemented | Created PAUSED; objective mapped to Meta's current naming |
| update_campaign | Implemented | Budget / status / name (used for Pause) |
| delete_campaign | Not built (on purpose) | We don't delete campaigns — safety choice |
| get_ad_sets | Implemented | List ad sets + budget/targeting; find budget-wasters |
| create_ad_set | Implemented | Used by the Creator wizard |
| update_ad_set | Implemented | Change budget/targeting/schedule, pause/resume |
| get_ads | Implemented | List ads + creative; compare performers |
| create_ad | Implemented | Used by the Creator wizard |

### Performance insights (doc lists 3)
| Doc tool | Our status | Note |
|---|---|---|
| get_insights | Implemented | Spend, clicks, CTR, CPC, conversions, reach, frequency (campaign/ad-set/ad level) |
| get_delivery_estimate | Implemented | Audience/reach estimate in the wizard |
| get_targeting_insights | Implemented | Audience-size/reach estimate for a targeting spec |

### Audience management (doc lists 4)
| Doc tool | Our status | Note |
|---|---|---|
| get_custom_audiences | Implemented | Listed in the wizard |
| create_custom_audience | Implemented | Can seed from captured leads — emails/phones are SHA-256 hashed before upload |
| create_lookalike_audience | Implemented | Build a lookalike from a source audience (the "find more like my best leads" loop) |
| get_saved_audiences | Implemented | Reuse saved targeting templates |

### Creative management (doc lists 4)
| Doc tool | Our status | Note |
|---|---|---|
| get_ad_creatives | Implemented | List creatives to compare approaches |
| create_ad_creative | Implemented | Uses the account's Facebook Page |
| get_ad_preview | Implemented | — |
| upload_ad_image | Implemented | Upload an image (by URL or bytes) and get a hash for creatives |

### Catalog & pixel (doc lists 3)
| Doc tool | Our status | Note |
|---|---|---|
| get_catalogs | Not built (not applicable) | Product catalogs are for e-commerce shops — not this lead-gen product |
| get_catalog_products | Not built (not applicable) | Same as above |
| get_pixels | Not built (not applicable) | Same as above |

### Ad library & diagnostics (doc lists 3)
| Doc tool | Our status | Note |
|---|---|---|
| search_ad_library | Implemented | Needs Meta's separate identity verification to return data |
| delivery_check | Implemented | Diagnose why a campaign/ad set/ad isn't spending |
| get_account_quality | Implemented | Account status / policy flags / restrictions |

**Summary: 25 of the 29 tools are implemented — every tool useful for this product.** The 4 not built are intentional: `delete_campaign` (left out for safety) and the 3 catalog/pixel tools (for e-commerce shops, not a lead-gen product). All 25 are code-complete and make real Meta calls; they return live data once a real account is connected. The lead-gen-specific ones — turning captured leads into a **custom audience** and a **lookalike** — are now in place, which is the "leads improve the ads" loop.

---

## 4. Security recommendations in the doc — what we already do

The doc's "For SaaS builders" section lists requirements. Our status:

| Doc requirement | Our status |
|---|---|
| Encrypt access tokens at rest (AES-256) | Done — tokens encrypted with AES-256-GCM |
| Scope every call to the right tenant | Done — per-organisation token + per-organisation ad account |
| Write guardrails / human approval for changes | Done — campaigns created PAUSED; the app asks for confirmation before any spend action |
| Never expose raw tokens | Done — tokens are never returned to the browser |
| Log write operations with tenant/user | Partial — actions are logged server-side; a formal per-tenant audit log is future work |

---

## 5. Blockers — what must happen for Meta to work live

| # | Blocker | Who | Effort |
|---|---|---|---|
| 1 | **Create a Meta app** and set `META_APP_ID` + `META_APP_SECRET`. Without this, no one can connect a Meta account — nothing Meta-related runs. | You (needs a Meta account) | 1–2 hours |
| 2 | **Connect a real ad account and rehearse** the full flow (connect → campaigns → insights → create a PAUSED campaign). The code is done but has never touched a real account. | You + us | Half a day of testing |
| 3 | **A Facebook Page is required to build a creative.** We auto-use the account's first Page; if the account has none, creative creation fails with a clear message. | You (have a Page ready) | — |
| 4 | **Lead-generation ad sets need a lead form** (Meta requirement). Until one is wired, the wizard falls back to a link-clicks objective so publishing still works. | Us | ~half a day |
| 5 | **Token refresh not implemented.** Meta tokens expire in ~60 days; we store the expiry but do not auto-refresh yet. After expiry the user must reconnect. | Us | ~half a day |
| 6 | **No rate-limit / retry handling.** The hosted connector does this automatically; our direct integration does not yet. Needed before heavy multi-client load, not for a demo. | Us | ~half a day |
| 7 | **Ad Library search** needs Meta's separate identity verification before it returns data. | You | Meta's timeline |
| 8 | **Managing *other* organisations' ad accounts** needs Meta App Review + Business Verification. Your **own** account (or a client added as a Tester) works immediately in Development mode with no review. | You / Meta | Meta's timeline (days–weeks) |

Blockers 1, 2, 3, 7, 8 depend on Meta or on you. Blockers 4, 5, 6 are code we can finish.

---

## 6. Why we chose the direct API — and what would happen if we used Meta's connector

### The choice in one line each
- **Meta's hosted connector** (`mcp.ads.meta.com`, from the doc): a ready-made "chat with your ads" tool. Meta runs it. Built for **one person, one account**.
- **Direct API** (what we built): we talk to Meta's own ad system ourselves, storing each client's login securely and acting for the right client on each request.

### Simple way to picture it
The connector is like using a **ride-share app** — quick, someone else drives, but you don't control the car and you follow their rules. The direct API is like **owning the car** — more responsibility (fuel, maintenance), but you decide where it goes and you're not stranded if the ride-share app is down.

### Side by side (for our product: many clients, one system, about to launch)
| What matters | Meta's hosted connector | Direct API (ours) | Better for us |
|---|---|---|---|
| Many clients under one system | Built for one person / one Business Manager per session | Native — each client's login stored and used per request | **Direct API** |
| Reliability for launch | Open beta, no uptime guarantee, not security-certified (doc's own words) | Stable, versioned, long-supported interface | **Direct API** |
| Control & audit (we spend client money) | Black box in the middle — we see its answer, not the exact call | We see and log the exact request/response per client | **Direct API** |
| Token renewal, traffic limits | Handled automatically by Meta | We must build it (not done yet) | **Connector** |
| Time to first demo | ~5 min for one account | Already built | Tie (ours is done) |
| Cost | Free (beta) | Free | Tie |

### What would actually happen if we chose the connector
1. A one-account demo would work and be quick to set up.
2. For the real product it would fight us: the connector logs in **per person in a browser**, one Business Manager at a time — it is not made for our server to drive many clients automatically. We'd be building fragile workarounds or hitting its one-session limit.
3. We'd be depending on a **beta service with no guarantee**. If Meta changes it or it goes down, our product breaks and we have **no fallback and no control**.
4. **Weaker audit trail** — harder to prove exactly what we sent when spending a client's budget, which also matters for data-protection (DPDP) compliance.
5. Betas change tool names and behaviour; our integration could break with no way to pin a stable version.
6. To be safe for production we'd **end up building the direct API anyway** (the doc says to keep it as the fallback) — so we'd have done the work twice.

### When the connector would have been the better pick (fair view)
If this were an **internal tool for one ad manager** on **one account**, who just wants to type instructions and never maintain code — the connector wins (fast, zero maintenance, beta is fine). That is simply not our product. Our product is multi-client and about to be sold, so the direct API is the right call.

### Bottom line
We traded "Meta handles a few things for us" for **control, reliability, multi-client support, and a real audit trail** — the things a launched product needs. The one real cost of that trade (auto token-renewal and traffic-limit handling) is a small, known amount of work, listed as blockers 5 and 6.

---

## 7. Recommendation

Stay on the direct Graph API — it is the correct choice for a multi-tenant product and is what the doc recommends for anything transactional. Before real client load, finish the two things the hosted connector would have handled for us: **token refresh (blocker 5)** and **rate-limit handling (blocker 6)**. Add **lookalike audiences** and **image upload** when the roadmap calls for them.

For the first demo, only blocker 1 is on the critical path: create the Meta app, add the two credentials, connect your own account, and rehearse.
