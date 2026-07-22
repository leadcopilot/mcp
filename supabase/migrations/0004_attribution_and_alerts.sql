-- §11: campaign→lead attribution columns on the SHARED leads table.
-- Additive + nullable only — safe (no data change). NOTE for backend team: add
-- these to the SQLAlchemy Lead model so Alembic autogenerate does NOT drop them.
alter table leads add column if not exists source_campaign text;
alter table leads add column if not exists source_ad_id    text;
alter table leads add column if not exists meta_lead_id     text;
alter table leads add column if not exists platform         text;

-- §9: persisted ROI-agent alerts (always-on monitor writes here; frontend polls).
create table if not exists ad_alerts (
  id             text primary key,
  org_id         text not null,
  type           text not null,
  severity       text not null,
  message        text not null,
  recommendation text,
  fingerprint    text not null,                       -- dedupe: org_id|type|window
  status         text not null default 'open',        -- open | acknowledged | resolved
  created_at     timestamptz default now()
);
create unique index if not exists uq_ad_alerts_fingerprint on ad_alerts(fingerprint);
create index if not exists idx_ad_alerts_org on ad_alerts(org_id, status);
