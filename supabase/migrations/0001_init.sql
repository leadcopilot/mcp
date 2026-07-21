-- LeadPilot Ad Manager — Phase 1 schema (ported from SQLite + auth/tenancy)
-- Idempotent-ish: safe to run once on a fresh project.

-- ── Auth / tenancy ──────────────────────────────────────────────
do $$ begin
  create type org_role as enum ('owner', 'ad_manager');
exception when duplicate_object then null; end $$;

create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at  timestamptz default now()
);

create table if not exists organisations (
  id          text primary key,
  name        text not null,
  website     text,
  industry    text,
  owner_id    uuid references auth.users(id),
  api_token   text,
  created_at  timestamptz default now()
);

create table if not exists org_members (
  org_id      text references organisations(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,
  role        org_role not null default 'ad_manager',
  created_at  timestamptz default now(),
  primary key (org_id, user_id)
);

-- ── Connections (tokens encrypted at the app layer) ─────────────
create table if not exists meta_connections (
  org_id text primary key references organisations(id) on delete cascade,
  access_token text not null, ad_account_id text, page_id text, scope text,
  connected_at timestamptz default now(), expires_at timestamptz
);
create table if not exists google_connections (
  org_id text primary key references organisations(id) on delete cascade,
  access_token text, refresh_token text not null, customer_id text,
  connected_at timestamptz default now(), expires_at timestamptz
);
create table if not exists oauth_states (
  state text primary key, org_id text not null, provider text not null,
  created_at timestamptz default now()
);
create table if not exists org_knowledge (
  org_id text primary key references organisations(id) on delete cascade,
  data jsonb, enriched_at timestamptz default now()
);
create table if not exists leads (
  id text primary key, org_id text not null references organisations(id) on delete cascade,
  name text, phone text, email text, source text default 'manual',
  source_campaign text, source_ad_id text, platform text default 'meta',
  status text default 'New', assigned_to text, company text, linkedin_url text,
  notes text, is_duplicate boolean default false, duplicate_of text,
  captured_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists campaigns_cache (
  id text primary key, org_id text not null, platform text not null, name text,
  status text, objective text, budget text, spend double precision,
  impressions bigint, clicks bigint, ctr double precision, cpc double precision,
  conversions bigint, roas double precision, reach bigint, frequency double precision,
  cpl double precision, diagnostic jsonb, fetched_at timestamptz default now()
);
create table if not exists keywords_cache (
  id text primary key, org_id text not null, keyword text not null,
  volume bigint, difficulty int, cpc_low double precision, cpc_high double precision,
  intent text, trend text, created_at timestamptz default now()
);
create table if not exists social_metrics (
  id text primary key, org_id text not null, platform text not null,
  followers bigint, posts_30d bigint, avg_reach bigint, engagement double precision,
  fetched_at timestamptz default now()
);
create table if not exists social_connections (
  id text primary key, org_id text not null, platform text not null,
  access_token text, refresh_token text, page_id text, page_name text,
  channel_id text, profile_id text, username text, scope text,
  expires_at timestamptz, connected_at timestamptz default now(),
  unique(org_id, platform)
);
create table if not exists social_metrics_history (
  id text primary key, org_id text not null, platform text not null,
  followers bigint default 0, posts_30d bigint default 0, avg_reach bigint default 0,
  engagement double precision default 0, impressions bigint default 0,
  views bigint default 0, recorded_at timestamptz default now()
);
create table if not exists research_jobs (
  id text primary key, org_id text not null references organisations(id) on delete cascade,
  job_type text not null, memory_key text not null, label text,
  created_at timestamptz default now()
);

-- ── Indexes on org_id for every tenant table ────────────────────
create index if not exists idx_leads_org on leads(org_id);
create index if not exists idx_campaigns_org on campaigns_cache(org_id);
create index if not exists idx_keywords_org on keywords_cache(org_id);
create index if not exists idx_social_metrics_org on social_metrics(org_id);
create index if not exists idx_social_conn_org on social_connections(org_id);
create index if not exists idx_social_hist_org on social_metrics_history(org_id);
create index if not exists idx_research_jobs_org on research_jobs(org_id);
create index if not exists idx_org_members_user on org_members(user_id);
