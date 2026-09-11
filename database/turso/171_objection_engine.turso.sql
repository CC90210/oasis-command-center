-- 171_objection_engine.turso.sql
--
-- The Oasis objection engine. Four tables behind the war room's objection
-- console: the library, the two-or-three ways to answer each entry, the log of
-- what reps actually heard, and the per-lead tailored wording.
--
-- TENANT PINNING IS THE AUTHORIZATION BOUNDARY. libSQL has no row-level
-- security, so tenant_id is on every table and in every index, and the
-- application pins it on every read and write. Nothing here is protected by
-- the database; it is protected by lib/web-leads/objections/* and the routes.
--
-- Booleans are integer 0/1 because libSQL returns them that way.

CREATE TABLE IF NOT EXISTS objection_catalog (
  id           text primary key,
  tenant_id    text not null,
  slug         text not null,
  says         text not null,
  meaning      text not null,
  prevent      text not null,
  family       text not null,
  source       text,
  status       text not null default 'draft',
  origin       text not null default 'ingested',
  dimension    text,
  created_by   text not null,
  approved_by  text,
  approved_at  text,
  created_at   text not null,
  updated_at   text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS objection_catalog_slug_uq
  ON objection_catalog (tenant_id, slug);
CREATE INDEX IF NOT EXISTS objection_catalog_live_idx
  ON objection_catalog (tenant_id, status, family);

CREATE TABLE IF NOT EXISTS objection_response (
  id            text primary key,
  tenant_id     text not null,
  objection_id  text not null,
  label         text not null,
  body          text not null,
  posture       text not null,
  is_default    integer not null default 0,
  status        text not null default 'draft',
  approved_by   text,
  approved_at   text,
  created_at    text not null,
  updated_at    text not null
);

CREATE INDEX IF NOT EXISTS objection_response_parent_idx
  ON objection_response (tenant_id, objection_id, status);

-- Exactly one approved default per objection. Partial unique index, queried
-- directly through libSQL rather than PostgREST, so the partial-index upsert
-- defect recorded in project doctrine does not apply here. Writers use an
-- explicit clear-then-set, never an upsert with a conflict target.
CREATE UNIQUE INDEX IF NOT EXISTS objection_response_one_default_uq
  ON objection_response (tenant_id, objection_id)
  WHERE is_default = 1 AND status = 'approved';

CREATE TABLE IF NOT EXISTS objection_event (
  id                text primary key,
  tenant_id         text not null,
  business_id       text not null,
  lead_record_id    text,
  rep_user_id       text not null,
  objection_id      text not null,
  response_id       text,
  used_variant      integer not null default 0,
  call_outcome_id   text,
  resolution        text,
  resolved_at       text,
  occurred_at       text not null,
  request_id        text not null,
  created_at        text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS objection_event_request_uq
  ON objection_event (tenant_id, request_id);
CREATE INDEX IF NOT EXISTS objection_event_business_idx
  ON objection_event (tenant_id, business_id, occurred_at);
CREATE INDEX IF NOT EXISTS objection_event_rollup_idx
  ON objection_event (tenant_id, objection_id, resolution);

CREATE TABLE IF NOT EXISTS objection_lead_variant (
  id            text primary key,
  tenant_id     text not null,
  business_id   text not null,
  objection_id  text not null,
  response_id   text not null,
  body          text not null,
  model_tier    text not null,
  audit_hash    text not null,
  status        text not null default 'generated',
  created_at    text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS objection_lead_variant_uq
  ON objection_lead_variant (tenant_id, business_id, response_id);
CREATE INDEX IF NOT EXISTS objection_lead_variant_lookup_idx
  ON objection_lead_variant (tenant_id, business_id, status);
