-- Row-Level Security: org isolation via org_members membership.
-- The service-role client (backend/webhooks/jobs) bypasses RLS by design.

-- Membership helper: org_ids the current user belongs to
create or replace function auth_org_ids()
returns setof text language sql stable security definer set search_path = public as $$
  select org_id from org_members where user_id = auth.uid()
$$;

alter table profiles               enable row level security;
alter table organisations          enable row level security;
alter table org_members            enable row level security;
alter table meta_connections       enable row level security;
alter table google_connections     enable row level security;
alter table org_knowledge          enable row level security;
alter table leads                  enable row level security;
alter table campaigns_cache        enable row level security;
alter table keywords_cache         enable row level security;
alter table social_metrics         enable row level security;
alter table social_connections     enable row level security;
alter table social_metrics_history enable row level security;
alter table research_jobs          enable row level security;

-- profiles: user sees/edits own
create policy profiles_self on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- organisations: members read; owner writes
create policy org_read on organisations
  for select using (id in (select auth_org_ids()));
create policy org_write on organisations
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- org_members: members read their org rows; owner manages
create policy members_read on org_members
  for select using (org_id in (select auth_org_ids()));
create policy members_manage on org_members
  for all using (org_id in (select id from organisations where owner_id = auth.uid()))
  with check (org_id in (select id from organisations where owner_id = auth.uid()));

-- Generic org-scoped tables: identical policy shape
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

-- NOTE: oauth_states intentionally keeps RLS OFF — it is written before any user
-- session exists and is only ever accessed via the service-role client.
