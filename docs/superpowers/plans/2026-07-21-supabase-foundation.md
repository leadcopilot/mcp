# Supabase Foundation Implementation Plan (Phase-1, Plan 1 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace SQLite/`better-sqlite3` with Supabase Postgres — versioned migrations, Row-Level Security for org isolation, an async `lib/db.js` on `@supabase/supabase-js`, plus the two Supabase clients (per-request JWT + service-role) and a real `/health` — so the multi-tenant data layer is production-shaped and testable.

**Architecture:** The Node/Express monolith keeps its shape. `lib/db.js` keeps its exported function *names* but each becomes async and talks to Supabase. Normal `/api` work uses a per-request client carrying the user's JWT (RLS applies); webhooks/background jobs use a service-role client (RLS bypassed, org scoping in code). Schema + RLS live in `supabase/migrations/` and are applied via the Supabase CLI (`npx supabase`).

**Tech Stack:** Node 24, Express 4, `@supabase/supabase-js` v2, Supabase CLI (via `npx supabase`), Vitest 2 for tests, existing `lib/crypto.js` (AES-256-GCM) retained for token-at-rest encryption.

## Global Constraints

- Node `>= 20` (dev machine is v24.16.0). ESM not introduced — repo is CommonJS (`require`); keep it.
- No AI attribution in commits/PRs. Author is Manthan Patil. Conventional Commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`). **No `Co-Authored-By` line.**
- Secrets (`SUPABASE_SERVICE_ROLE_KEY`, DB password, `GEMINI_API_KEYS`) live in `.env` only — never committed, never printed to logs.
- `organisations.id` stays a **TEXT** app-generated id (existing code passes string org ids). `auth.users.id` is uuid; `org_members.user_id` references it.
- Keep `lib/crypto.js` `encrypt()/decrypt()` for all token columns — do not store tokens in plaintext.
- RLS isolation rule (every tenant table): a row is accessible only when
  `org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())`.
- Project ref: `otbdjrexiscbxqlcnnvx`. `SUPABASE_URL=https://otbdjrexiscbxqlcnnvx.supabase.co`.

**Execution gate:** Tasks 4–8 require the real **DB password** (connection string) and **`sb_secret_…` service-role key** in `.env`. Tasks 1–3 need neither and can run immediately.

---

### Task 1: Initialise git + baseline commit

**Files:**
- Create: `.gitignore` (verify/extend)
- Modify: none

**Interfaces:**
- Produces: a clean git repo at `Ad_Manager-main/` with a baseline commit; runtime artifacts ignored.

- [ ] **Step 1: Confirm not already a repo**

Run: `git -C "D:/Ad_Manager-main/Ad_Manager-main" rev-parse --is-inside-work-tree 2>/dev/null || echo "not a repo"`
Expected: `not a repo`

- [ ] **Step 2: Init**

Run: `git -C "D:/Ad_Manager-main/Ad_Manager-main" init -b main`
Expected: `Initialized empty Git repository`

- [ ] **Step 3: Ensure `.gitignore` ignores runtime + secrets**

Ensure `.gitignore` contains (append any missing lines):

```
node_modules/
.env
*.db
*.db-shm
*.db-wal
logs/
output/
rag_store/
__pycache__/
supabase/.temp/
.vscode/
```

- [ ] **Step 4: Baseline commit**

```bash
git -C "D:/Ad_Manager-main/Ad_Manager-main" add -A
git -C "D:/Ad_Manager-main/Ad_Manager-main" commit -m "chore: baseline import of Ad Manager prototype"
```
Expected: commit succeeds; `git status` clean (no `.env`, no `*.db`, no `node_modules/`).

---

### Task 2: Dependencies, env schema, and Vitest

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Create: `vitest.config.js`
- Test: `tests/smoke.test.js`

**Interfaces:**
- Produces: `@supabase/supabase-js` and `@google/genai` installed; `vitest` runnable via `npm test`; `.env.example` documents every Phase-1 var.

- [ ] **Step 1: Add deps and scripts**

In `package.json`, add to `dependencies`: `"@supabase/supabase-js": "^2.45.0"`, `"@google/genai": "^0.3.0"`. Add to a new `devDependencies`: `"vitest": "^2.1.0"`. In `scripts` add: `"test": "vitest run"`, `"test:watch": "vitest"`. Leave `better-sqlite3` in place for now (removed in Task 6 once `db.js` no longer imports it).

- [ ] **Step 2: Install**

Run: `cd "D:/Ad_Manager-main/Ad_Manager-main" && npm install`
Expected: installs without error; `node_modules/@supabase/supabase-js` and `node_modules/@google/genai` exist.

- [ ] **Step 3: Extend `.env.example`**

Append the Supabase + Gemini block; remove the `MISTRAL_API_KEY` line and Mac MCP paths:

```
# ─── Supabase (project ref: otbdjrexiscbxqlcnnvx) ───
SUPABASE_URL=https://otbdjrexiscbxqlcnnvx.supabase.co
SUPABASE_ANON_KEY=sb_publishable_xxx
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxx
SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.otbdjrexiscbxqlcnnvx.supabase.co:5432/postgres

# ─── Reasoning (Gemini) ───
REASONING_PROVIDER=gemini
GEMINI_API_KEYS=key1,key2
GEMINI_MODEL=gemini-3.5-flash
GEMINI_THINKING_LEVEL=low
```

- [ ] **Step 4: Vitest config**

Create `vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    testTimeout: 20000,
  },
});
```

- [ ] **Step 5: Smoke test**

Create `tests/smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
  it('loads @supabase/supabase-js', async () => {
    const mod = await import('@supabase/supabase-js');
    expect(typeof mod.createClient).toBe('function');
  });
});
```

- [ ] **Step 6: Run**

Run: `cd "D:/Ad_Manager-main/Ad_Manager-main" && npm test`
Expected: 2 passing tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .env.example vitest.config.js tests/smoke.test.js
git commit -m "chore: add supabase + genai deps and vitest harness"
```

---

### Task 3: Supabase client module

**Files:**
- Create: `lib/supabase.js`
- Test: `tests/supabase.test.js`

**Interfaces:**
- Produces:
  - `getServiceClient(): SupabaseClient` — memoized service-role client (RLS bypass). Throws if `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` unset.
  - `getUserClient(accessToken: string): SupabaseClient` — a client that sends the user JWT as the `Authorization` header so RLS applies. Throws if `SUPABASE_URL`/`SUPABASE_ANON_KEY` unset.
  - `isConfigured(): boolean` — true when URL + service-role key are present.

- [ ] **Step 1: Write the failing test**

Create `tests/supabase.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';

function fresh() {
  delete require.cache[require.resolve('../lib/supabase.js')];
  return require('../lib/supabase.js');
}

describe('lib/supabase', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://otbdjrexiscbxqlcnnvx.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'sb_publishable_test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  });

  it('reports configured when url + service key present', () => {
    expect(fresh().isConfigured()).toBe(true);
  });

  it('builds a user client carrying the JWT', () => {
    const { getUserClient } = fresh();
    const client = getUserClient('jwt-abc');
    expect(client).toBeTruthy();
    expect(typeof client.from).toBe('function');
  });

  it('throws when service role key missing', () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => fresh().getServiceClient()).toThrow(/SERVICE_ROLE/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- supabase`
Expected: FAIL — cannot find `../lib/supabase.js`.

- [ ] **Step 3: Implement**

Create `lib/supabase.js`:

```js
/**
 * Supabase clients.
 * - getServiceClient(): server-trusted, bypasses RLS. Webhooks + background jobs ONLY.
 * - getUserClient(jwt): carries the end-user's JWT so Postgres RLS applies. All /api work.
 */
const { createClient } = require('@supabase/supabase-js');

const URL = () => process.env.SUPABASE_URL;

let serviceClient;
function getServiceClient() {
  if (serviceClient) return serviceClient;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL() || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  serviceClient = createClient(URL(), key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return serviceClient;
}

function getUserClient(accessToken) {
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!URL() || !anon) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set');
  return createClient(URL(), anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} },
  });
}

function isConfigured() {
  return !!(URL() && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

module.exports = { getServiceClient, getUserClient, isConfigured };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- supabase`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/supabase.js tests/supabase.test.js
git commit -m "feat: add supabase service-role and per-request JWT clients"
```

---

### Task 4: Schema migration (Postgres)  *(needs DB password + `npx supabase` link)*

**Files:**
- Create: `supabase/config.toml` (via `npx supabase init`)
- Create: `supabase/migrations/0001_init.sql`

**Interfaces:**
- Produces: all tables in Postgres — the 12 ported tables plus `profiles`, `org_members`, and the `org_role` enum. Column semantics preserved from `lib/db.js`.

- [ ] **Step 1: Init + link the CLI**

```bash
cd "D:/Ad_Manager-main/Ad_Manager-main"
npx supabase init            # creates supabase/ (choose "no" to VS Code settings prompt)
npx supabase link --project-ref otbdjrexiscbxqlcnnvx   # prompts for DB password
```
Expected: `supabase/config.toml` created; link reports success. (If `login` is required first, run `npx supabase login` in an interactive terminal, or set `SUPABASE_ACCESS_TOKEN`.)

- [ ] **Step 2: Write the schema migration**

Create `supabase/migrations/0001_init.sql`. Port every table from `lib/db.js` faithfully (SQLite→Postgres: `TEXT`→`text`, `INTEGER` boolean→`boolean`, `REAL`→`double precision`, `datetime('now')`→`now()`, `id TEXT PRIMARY KEY`→`text primary key`). Add auth tables:

```sql
-- Auth / tenancy
create type org_role as enum ('owner', 'ad_manager');

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at  timestamptz default now()
);

create table organisations (
  id          text primary key,
  name        text not null,
  website     text,
  industry    text,
  owner_id    uuid references auth.users(id),
  api_token   text,
  created_at  timestamptz default now()
);

create table org_members (
  org_id      text references organisations(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,
  role        org_role not null default 'ad_manager',
  created_at  timestamptz default now(),
  primary key (org_id, user_id)
);

-- Connections (tokens stored encrypted at app layer)
create table meta_connections (
  org_id text primary key references organisations(id) on delete cascade,
  access_token text not null, ad_account_id text, page_id text, scope text,
  connected_at timestamptz default now(), expires_at timestamptz
);
create table google_connections (
  org_id text primary key references organisations(id) on delete cascade,
  access_token text, refresh_token text not null, customer_id text,
  connected_at timestamptz default now(), expires_at timestamptz
);
create table oauth_states (
  state text primary key, org_id text not null, provider text not null,
  created_at timestamptz default now()
);
create table org_knowledge (
  org_id text primary key references organisations(id) on delete cascade,
  data jsonb, enriched_at timestamptz default now()
);
create table leads (
  id text primary key, org_id text not null references organisations(id) on delete cascade,
  name text, phone text, email text, source text default 'manual',
  source_campaign text, source_ad_id text, platform text default 'meta',
  status text default 'New', assigned_to text, company text, linkedin_url text,
  notes text, is_duplicate boolean default false, duplicate_of text,
  captured_at timestamptz default now(), updated_at timestamptz default now()
);
create table campaigns_cache (
  id text primary key, org_id text not null, platform text not null, name text,
  status text, objective text, budget text, spend double precision,
  impressions bigint, clicks bigint, ctr double precision, cpc double precision,
  conversions bigint, roas double precision, reach bigint, frequency double precision,
  cpl double precision, diagnostic jsonb, fetched_at timestamptz default now()
);
create table keywords_cache (
  id text primary key, org_id text not null, keyword text not null,
  volume bigint, difficulty int, cpc_low double precision, cpc_high double precision,
  intent text, trend text, created_at timestamptz default now()
);
create table social_metrics (
  id text primary key, org_id text not null, platform text not null,
  followers bigint, posts_30d bigint, avg_reach bigint, engagement double precision,
  fetched_at timestamptz default now()
);
create table social_connections (
  id text primary key, org_id text not null, platform text not null,
  access_token text, refresh_token text, page_id text, page_name text,
  channel_id text, profile_id text, username text, scope text,
  expires_at timestamptz, connected_at timestamptz default now(),
  unique(org_id, platform)
);
create table social_metrics_history (
  id text primary key, org_id text not null, platform text not null,
  followers bigint default 0, posts_30d bigint default 0, avg_reach bigint default 0,
  engagement double precision default 0, impressions bigint default 0,
  views bigint default 0, recorded_at timestamptz default now()
);
create table research_jobs (
  id text primary key, org_id text not null references organisations(id) on delete cascade,
  job_type text not null, memory_key text not null, label text,
  created_at timestamptz default now()
);

-- Indexes on org_id for every tenant table
create index on leads(org_id);
create index on campaigns_cache(org_id);
create index on keywords_cache(org_id);
create index on social_metrics(org_id);
create index on social_connections(org_id);
create index on social_metrics_history(org_id);
create index on research_jobs(org_id);
create index on org_members(user_id);
```

- [ ] **Step 3: Apply**

Run: `npx supabase db push`
Expected: migration `0001_init` applied; `npx supabase migration list` shows it as applied remotely.

- [ ] **Step 4: Verify tables exist**

Run: `npx supabase db push --dry-run` (should report no pending changes) or check the Dashboard → Table Editor.
Expected: 15 tables present.

- [ ] **Step 5: Commit**

```bash
git add supabase/config.toml supabase/migrations/0001_init.sql
git commit -m "feat: postgres schema migration (ported tables + auth/tenancy)"
```

---

### Task 5: Row-Level Security policies  *(needs Task 4)*

**Files:**
- Create: `supabase/migrations/0002_rls.sql`
- Test: `tests/rls.test.js`

**Interfaces:**
- Produces: RLS enabled on every tenant table; org isolation enforced by `auth.uid()` membership.

- [ ] **Step 1: Write the RLS migration**

Create `supabase/migrations/0002_rls.sql`:

```sql
-- Membership helper: org_ids the current user belongs to
create or replace function auth_org_ids()
returns setof text language sql stable security definer set search_path = public as $$
  select org_id from org_members where user_id = auth.uid()
$$;

-- Enable RLS
alter table profiles            enable row level security;
alter table organisations       enable row level security;
alter table org_members         enable row level security;
alter table meta_connections    enable row level security;
alter table google_connections  enable row level security;
alter table org_knowledge       enable row level security;
alter table leads               enable row level security;
alter table campaigns_cache     enable row level security;
alter table keywords_cache      enable row level security;
alter table social_metrics      enable row level security;
alter table social_connections  enable row level security;
alter table social_metrics_history enable row level security;
alter table research_jobs       enable row level security;

-- profiles: user sees/edits own
create policy profiles_self on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- organisations: members can read; owner can write
create policy org_read on organisations
  for select using (id in (select auth_org_ids()));
create policy org_write on organisations
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- org_members: members can read their org's rows; owner manages
create policy members_read on org_members
  for select using (org_id in (select auth_org_ids()));
create policy members_manage on org_members
  for all using (org_id in (select org_id from organisations where owner_id = auth.uid()))
  with check (org_id in (select org_id from organisations where owner_id = auth.uid()));

-- Generic org-scoped tables: same policy shape for each
create policy meta_conn_rls on meta_connections for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));
create policy google_conn_rls on google_connections for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));
create policy org_knowledge_rls on org_knowledge for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));
create policy leads_rls on leads for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));
create policy campaigns_cache_rls on campaigns_cache for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));
create policy keywords_cache_rls on keywords_cache for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));
create policy social_metrics_rls on social_metrics for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));
create policy social_connections_rls on social_connections for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));
create policy social_history_rls on social_metrics_history for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));
create policy research_jobs_rls on research_jobs for all
  using (org_id in (select auth_org_ids())) with check (org_id in (select auth_org_ids()));

-- oauth_states: no RLS-safe user context (written pre-login); keep RLS OFF,
-- accessed only via service-role client. Document this explicitly.
```

- [ ] **Step 2: Apply**

Run: `npx supabase db push`
Expected: `0002_rls` applied.

- [ ] **Step 3: Write the isolation test**

Create `tests/rls.test.js`. It signs up two users via the anon client, gives each their own org + membership (through the service client), then asserts user A's JWT client cannot read user B's lead. Skips itself when Supabase env is absent so CI without secrets stays green:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const run = URL && ANON && SERVICE ? describe : describe.skip;

run('RLS org isolation', () => {
  const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const ts = Date.now();
  const orgA = `test_org_a_${ts}`;
  const orgB = `test_org_b_${ts}`;
  let tokenA;

  beforeAll(async () => {
    // two users
    const a = await svc.auth.admin.createUser({ email: `a_${ts}@t.dev`, password: 'pw-aaaaaa', email_confirm: true });
    const b = await svc.auth.admin.createUser({ email: `b_${ts}@t.dev`, password: 'pw-bbbbbb', email_confirm: true });
    await svc.from('organisations').insert([{ id: orgA, name: 'A', owner_id: a.data.user.id }, { id: orgB, name: 'B', owner_id: b.data.user.id }]);
    await svc.from('org_members').insert([{ org_id: orgA, user_id: a.data.user.id, role: 'owner' }, { org_id: orgB, user_id: b.data.user.id, role: 'owner' }]);
    await svc.from('leads').insert({ id: `lead_b_${ts}`, org_id: orgB, name: 'B secret lead', phone: '999' });
    const signin = await createClient(URL, ANON).auth.signInWithPassword({ email: `a_${ts}@t.dev`, password: 'pw-aaaaaa' });
    tokenA = signin.data.session.access_token;
  });

  it('user A cannot read org B leads', async () => {
    const asA = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${tokenA}` } } });
    const { data } = await asA.from('leads').select('*').eq('org_id', orgB);
    expect(data).toEqual([]); // RLS filters B's row out entirely
  });
});
```

- [ ] **Step 4: Run**

Run: `npm test -- rls`
Expected: PASS when Supabase env is set (else skipped). The assertion proves A cannot see B's lead.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0002_rls.sql tests/rls.test.js
git commit -m "feat: row-level security policies + org isolation test"
```

---

### Task 6: Rewrite `lib/db.js` to async Supabase  *(needs Task 4)*

**Files:**
- Modify: `lib/db.js` (full rewrite of the implementation, same exports)
- Modify: `package.json` (remove `better-sqlite3`)
- Test: `tests/db.test.js`

**Interfaces:**
- Consumes: `getServiceClient` from `lib/supabase.js`; `encrypt/decrypt/randomToken` from `lib/crypto.js`.
- Produces: every existing export, now **async** (returns Promises). Names/params unchanged so callers only add `await`. Full list to convert (all must remain exported):
  `createOrg, getOrg, listOrgs, updateOrg, saveMetaConnection, getMetaConnection, saveGoogleConnection, getGoogleConnection, saveOAuthState, consumeOAuthState, saveKnowledge, getKnowledge, saveLead, getLeads, updateLeadStatus, getLeadStats, saveCampaigns, getCachedCampaigns, saveKeywords, getKeywords, saveSocialConnection, getSocialConnection, getSocialConnections, deleteSocialConnection, getOrgIdByFacebookPage, saveSocialMetricsHistory, getSocialMetricsHistory, saveResearchJob, getResearchJob, getResearchJobsForOrg`.
  Plus `getDb()` becomes `initDb()` — a no-op async readiness check that verifies `isConfigured()` (server boot calls it).

- [ ] **Step 1: Write the db-layer test (service-role path)**

Create `tests/db.test.js` — exercises the real conversion pattern against Supabase using the service client (skips without env). Uses a throwaway org:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const URL = process.env.SUPABASE_URL, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const run = URL && SERVICE ? describe : describe.skip;

run('lib/db async layer', () => {
  let db; const orgId = `test_db_${Date.now()}`;
  beforeAll(async () => { db = require('../lib/db.js'); await db.createOrg(orgId, 'DB Test Org'); });
  afterAll(async () => { const { getServiceClient } = require('../lib/supabase.js'); await getServiceClient().from('organisations').delete().eq('id', orgId); });

  it('creates and reads an org', async () => {
    const org = await db.getOrg(orgId);
    expect(org.name).toBe('DB Test Org');
    expect(org.api_token).toBeTruthy();
  });

  it('round-trips an encrypted meta token', async () => {
    await db.saveMetaConnection(orgId, 'secret-token-123', 'act_1', 'ads_read', null);
    const conn = await db.getMetaConnection(orgId);
    expect(conn.access_token).toBe('secret-token-123'); // decrypted on read
  });

  it('saves a lead and flags duplicates', async () => {
    await db.saveLead({ org_id: orgId, name: 'X', phone: '111', email: 'x@t.dev' });
    const dup = await db.saveLead({ org_id: orgId, name: 'X2', phone: '111' });
    expect(dup.is_duplicate).toBe(true);
    const stats = await db.getLeadStats(orgId);
    expect(stats.total).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- db`
Expected: FAIL (current `db.js` is sync/better-sqlite3; `await db.getOrg` returns non-Promise / wrong shape).

- [ ] **Step 3: Rewrite `lib/db.js`**

Replace the `better-sqlite3` implementation. Keep `require('./crypto')`. Use `getServiceClient()` from `./supabase`. Conversion patterns — apply the matching pattern to each function in the export list above:

*Pattern A — simple insert/upsert:*
```js
const { getServiceClient } = require('./supabase');
const { encrypt, decrypt, randomToken } = require('./crypto');
const sb = () => getServiceClient();

async function createOrg(id, name) {
  await sb().from('organisations').upsert({ id, name, api_token: randomToken() }, { onConflict: 'id', ignoreDuplicates: true });
  return getOrg(id);
}
async function getOrg(id) {
  const { data } = await sb().from('organisations').select('*').eq('id', id).maybeSingle();
  return data;
}
async function listOrgs() {
  const { data } = await sb().from('organisations').select('*').order('name');
  return data || [];
}
async function updateOrg(id, fields) {
  await sb().from('organisations').update(fields).eq('id', id);
}
```

*Pattern B — token columns (encrypt on write, decrypt on read):*
```js
async function saveMetaConnection(orgId, token, adAccountId, scope, expiresAt) {
  await sb().from('meta_connections').upsert({
    org_id: orgId, access_token: encrypt(token), ad_account_id: adAccountId,
    scope, expires_at: expiresAt, connected_at: new Date().toISOString(),
  }, { onConflict: 'org_id' });
}
async function getMetaConnection(orgId) {
  const { data } = await sb().from('meta_connections').select('*').eq('org_id', orgId).maybeSingle();
  if (data) data.access_token = decrypt(data.access_token);
  return data;
}
```
Apply the same encrypt/decrypt to `saveGoogleConnection`/`getGoogleConnection` (both `access_token` and `refresh_token`) and to `saveSocialConnection`/`getSocialConnection*` (via a `decryptSocialRow` helper), exactly as the original did.

*Pattern C — oauth state with TTL (uses service client; table has RLS off):*
```js
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
async function saveOAuthState(state, orgId, provider) {
  await sb().from('oauth_states').insert({ state, org_id: orgId, provider });
}
async function consumeOAuthState(state) {
  const { data } = await sb().from('oauth_states').select('*').eq('state', state).maybeSingle();
  if (data) await sb().from('oauth_states').delete().eq('state', state);
  if (!data) return null;
  const age = Date.now() - new Date(data.created_at).getTime();
  if (Number.isFinite(age) && age > OAUTH_STATE_TTL_MS) return null;
  return data;
}
```

*Pattern D — knowledge as jsonb (no JSON.stringify needed; column is jsonb):*
```js
async function saveKnowledge(orgId, data) {
  await sb().from('org_knowledge').upsert({ org_id: orgId, data, enriched_at: new Date().toISOString() }, { onConflict: 'org_id' });
}
async function getKnowledge(orgId) {
  const { data } = await sb().from('org_knowledge').select('data').eq('org_id', orgId).maybeSingle();
  return data ? data.data : null;
}
```

*Pattern E — leads with dedup (replicate original semantics):*
```js
async function saveLead(lead) {
  const id = lead.id || `lead_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const { data: existing } = await sb().from('leads').select('id')
    .eq('org_id', lead.org_id)
    .or(`phone.eq.${lead.phone || ''},email.eq.${lead.email || ''}`)
    .limit(1);
  const dupe = existing && existing[0];
  const row = {
    id, org_id: lead.org_id, name: lead.name, phone: lead.phone, email: lead.email,
    source: lead.source || 'meta', source_campaign: lead.source_campaign, source_ad_id: lead.source_ad_id,
    platform: lead.platform || 'meta', status: 'New', company: lead.company, linkedin_url: lead.linkedin_url,
    is_duplicate: !!dupe, duplicate_of: dupe ? dupe.id : null,
  };
  await sb().from('leads').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
  return { ...lead, id, is_duplicate: !!dupe, duplicate_of: dupe ? dupe.id : null };
}
async function getLeads(orgId, status = null, limit = 100) {
  let q = sb().from('leads').select('*').eq('org_id', orgId).order('captured_at', { ascending: false }).limit(limit);
  if (status && status !== 'All') q = q.eq('status', status);
  const { data } = await q;
  return data || [];
}
async function updateLeadStatus(orgId, leadId, status) {
  await sb().from('leads').update({ status, updated_at: new Date().toISOString() }).eq('id', leadId).eq('org_id', orgId);
}
async function getLeadStats(orgId) {
  const { data } = await sb().from('leads').select('status,is_duplicate').eq('org_id', orgId);
  const rows = data || [];
  const count = (s) => rows.filter(r => r.status === s).length;
  return {
    total: rows.length, new_count: count('New'), contacted: count('Contacted'),
    followup: count('Follow-up'), converted: count('Converted'), dead: count('Dead'),
    duplicates: rows.filter(r => r.is_duplicate).length,
  };
}
```

*Pattern F — cache upserts (campaigns/keywords) and history/metrics inserts:* map each `INSERT ... ON CONFLICT` to `.upsert(rows, { onConflict: 'id' })` and each plain `INSERT` to `.insert(row)`; map ordered reads (`ORDER BY spend DESC` etc.) to `.order('spend', { ascending: false })`. Convert `saveCampaigns`, `getCachedCampaigns`, `saveKeywords`, `getKeywords`, `saveSocialMetricsHistory`, `getSocialMetricsHistory`, `saveResearchJob`, `getResearchJob`, `getResearchJobsForOrg`, `getOrgIdByFacebookPage`, `deleteSocialConnection` this way, preserving each original's column set and filters.

*Readiness:*
```js
const { isConfigured } = require('./supabase');
async function initDb() {
  if (!isConfigured()) throw new Error('Supabase not configured — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  const { error } = await sb().from('organisations').select('id').limit(1);
  if (error) throw new Error(`Supabase connectivity check failed: ${error.message}`);
}
```
Export `initDb` plus every function from the interface list (drop `getDb`).

- [ ] **Step 4: Remove `better-sqlite3`**

In `package.json` delete the `"better-sqlite3"` dependency line. Run `cd "D:/Ad_Manager-main/Ad_Manager-main" && npm install`.
Expected: install succeeds; `lib/db.js` no longer imports it (`grep -n better-sqlite3 lib/db.js` → no matches).

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- db`
Expected: 3 passing (or skipped without env).

- [ ] **Step 6: Commit**

```bash
git add lib/db.js package.json package-lock.json tests/db.test.js
git commit -m "feat: rewrite db layer async on supabase (drop better-sqlite3)"
```

---

### Task 7: Await the db layer in all callers  *(needs Task 6)*

**Files:**
- Modify: `server.js:12,70`
- Modify: `routes/api.js` (all `db.*` calls)
- Modify: `routes/auth.js`, `routes/research.js`, `routes/social.js`
- Modify: `lib/auth/meta.js`, `lib/auth/google.js`, `lib/ai/runner.js`

**Interfaces:**
- Consumes: the async exports from Task 6.
- Produces: a server that boots and serves without unhandled-promise or `[object Promise]` bugs.

- [ ] **Step 1: Swap boot call**

In `server.js`: change `const { getDb } = require('./lib/db');` → `const { initDb } = require('./lib/db');`. Replace the bare `getDb();` (line ~70) with an async boot:

```js
initDb()
  .then(() => app.listen(PORT, () => { /* existing banner */ }))
  .catch((err) => { console.error('DB init failed:', err.message); process.exit(1); });
```

- [ ] **Step 2: Add `await` to every db call site**

For each handler in the modified files, ensure the enclosing function is `async` and every `db.*`/imported-db-function call is `await`ed. Enumerate with:

Run: `cd "D:/Ad_Manager-main/Ad_Manager-main" && grep -rnE "(getOrg|createOrg|listOrgs|updateOrg|saveMeta|getMeta|saveGoogle|getGoogle|saveOAuthState|consumeOAuthState|saveKnowledge|getKnowledge|saveLead|getLeads|updateLeadStatus|getLeadStats|saveCampaigns|getCachedCampaigns|saveKeywords|getKeywords|saveSocial|getSocial|deleteSocial|getOrgIdByFacebookPage|saveResearchJob|getResearchJob|getResearchJobsForOrg)\(" routes lib server.js | grep -v "function "`

Add `await` to each hit whose result is used synchronously (assignments, `if (...)`, `.map`, JSON responses). Make the handler `async` where it isn't.

- [ ] **Step 3: Boot smoke test**

Run: `cd "D:/Ad_Manager-main/Ad_Manager-main" && node -e "require('dotenv').config(); require('./lib/db').initDb().then(()=>console.log('DB OK')).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `DB OK` (with real `.env`).

- [ ] **Step 4: Manual endpoint check**

Run the server (`npm start`), then: `curl -s http://localhost:3001/health` and one org round-trip through the UI or `curl`. Confirm no `[object Promise]` in responses and no unhandled-rejection warnings in the log.

- [ ] **Step 5: Commit**

```bash
git add server.js routes lib
git commit -m "refactor: await async db layer across all callers"
```

---

### Task 8: Supabase-aware `/health`

**Files:**
- Create: `lib/health.js`
- Modify: `server.js` (the `/health` handler)
- Test: `tests/health.test.js`

**Interfaces:**
- Consumes: `isConfigured`, `getServiceClient` from `lib/supabase.js`.
- Produces: `checkHealth(): Promise<{ status, time, env: { supabase, gemini, groq, meta, google, search, playwright } }>` where `supabase` is a live connectivity boolean. (The real Gemini ping lands in Plan 3; here `gemini` stays a presence check on `GEMINI_API_KEYS || GEMINI_API_KEY`.)

- [ ] **Step 1: Write the failing test**

Create `tests/health.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { checkHealth } from '../lib/health.js';

describe('checkHealth', () => {
  it('returns a status object with an env map', async () => {
    const h = await checkHealth();
    expect(h.status).toBe('ok');
    expect(h.env).toHaveProperty('supabase');
    expect(h.env).toHaveProperty('gemini');
    expect(['tavily', 'duckduckgo']).toContain(h.env.search);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- health`
Expected: FAIL — cannot find `../lib/health.js`.

- [ ] **Step 3: Implement `lib/health.js`**

```js
const { isConfigured, getServiceClient } = require('./supabase');

async function supabaseOk() {
  if (!isConfigured()) return false;
  try {
    const { error } = await getServiceClient().from('organisations').select('id').limit(1);
    return !error;
  } catch { return false; }
}

async function checkHealth() {
  let playwright = false;
  try {
    const { chromium } = require('playwright');
    const fs = require('fs');
    const p = chromium.executablePath();
    playwright = !!(p && fs.existsSync(p));
  } catch {}

  return {
    status: 'ok',
    time: new Date().toISOString(),
    env: {
      supabase: await supabaseOk(),
      gemini: !!(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY),
      groq: !!process.env.GROQ_API_KEY,
      meta: !!(process.env.META_APP_ID && process.env.META_APP_SECRET),
      google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_DEVELOPER_TOKEN),
      search: process.env.TAVILY_API_KEY ? 'tavily' : 'duckduckgo',
      playwright,
    },
  };
}

module.exports = { checkHealth };
```

- [ ] **Step 4: Wire into `server.js`**

Replace the inline `/health` handler body with:

```js
const { checkHealth } = require('./lib/health');
app.get('/health', async (_req, res) => res.json(await checkHealth()));
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -- health`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/health.js server.js tests/health.test.js
git commit -m "feat: supabase-aware health check endpoint"
```

---

## Self-Review

**Spec coverage (Plan 1's slice of §5, §11, §12, §14 steps 1-2):**
- git init + env schema + /health skeleton → Tasks 1, 2, 8 ✓
- Supabase migrations (schema + RLS) → Tasks 4, 5 ✓
- async `db.js` on `@supabase/supabase-js` → Tasks 6, 7 ✓
- two clients (JWT + service-role) → Task 3 ✓
- token encryption retained → Task 6 Pattern B (keeps `crypto.js`) ✓
- RLS isolation test → Task 5 Step 3 ✓
- Vitest suite → Tasks 2, 3, 5, 6, 8 ✓
- Auth/login itself → **deferred to Plan 2** (documented non-goal here; `org_members`/`profiles`/RLS scaffolding built now so Plan 2 only adds sign-in + middleware) ✓

**Placeholder scan:** no TBD/TODO; every new file has complete code; the db.js port names every function and shows a worked example per pattern (A–F) rather than a vague "similar to". Acceptable — no function is left unspecified.

**Type consistency:** `initDb` (not `getDb`) used consistently in Tasks 6 & 7; `getServiceClient`/`getUserClient`/`isConfigured` names match across Tasks 3, 6, 8; `checkHealth` signature matches Task 8 test and server wiring.

**Known deviation from a naive reading:** `oauth_states` intentionally keeps RLS **off** (written before a user session exists) and is only ever touched by the service-role client — called out in Task 5 Step 1.
