-- 237 - Free AI Audit: engagements, discovery profiles, audit and proposal
-- versions, and the service catalogue (2026-10-25).
--
-- CC's brief (2026-10-25): one connected system from a lead to an onboarded
-- client, built around the Free AI Audit. Two human gates (CC authorizes the
-- client's information for processing; CC approves the exact audit, PDF and
-- proposal before anything reaches the client). Every finding carries one of
-- four labels. No figure or price is invented: prices come only from a
-- catalogue item CC confirmed, or a price CC typed himself.
--
-- ai_audit_engagements   one row per audit cycle of a lead. `stage` is the
--                        brief's 13 CRM stages plus declined / cancelled
--                        (lib/ai-audit/rules.ts AI_AUDIT_STAGES). `health` and
--                        `payment_status` are the stalled / failed flags: the
--                        stage stays where it stopped. row_version is the
--                        compare-and-swap counter every write checks. At most
--                        one OPEN engagement per lead (closed_at IS NULL).
-- ai_audit_events        the audit trail. Append-only: rows are never updated
--                        (a trigger refuses it). Deleting is left to workspace
--                        offboarding and the data purge.
-- ai_audit_steps         the automation's work items: lease, idempotency key,
--                        attempts and backoff (lib/ai-audit/steps.ts).
-- ai_audit_settings      one row per workspace: tax rule, deposit default,
--                        engine default, turnaround wording.
-- ai_audit_profile_*     the discovery profile, versioned. Each field has a
--                        label, where it came from, and CC's corrections. A
--                        frozen version's values cannot change (triggers);
--                        only its evidence quote may be cleared.
-- ai_audit_versions      the audit document (ai_audit_doc/v1 JSON) and its
--                        hash. Its content cannot change once it leaves draft;
--                        a delivered version can only become superseded.
-- ai_service_catalogue_items  proposed / confirmed / retired. One confirmed
--                        version per SKU. A confirmed price never changes: a
--                        new price is a new item version.
-- ai_audit_proposal_versions  the priced proposal, frozen like the audit.
--
-- CONVENTIONS (bravo__190 / bravo__230): text ids and ISO-8601 UTC times
-- written by the app; tenant_id on every row and first in every index; the
-- WHERE clauses in lib/ai-audit/store.ts are the isolation boundary. Evolving
-- vocabularies are checked in lib/ai-audit/rules.ts, not by CHECK constraints
-- (SQLite cannot widen a CHECK in place). Additive only: nothing existing is
-- touched.

CREATE TABLE IF NOT EXISTS ai_audit_engagements (
  id                          text not null primary key,
  tenant_id                   text not null,
  lead_id                     text not null,
  cycle_no                    integer not null default 1,
  stage                       text not null,
  health                      text not null default 'ok',
  health_reason               text,
  payment_status              text not null default 'none',
  business_name               text,
  business_type               text,
  contact_name                text,
  contact_email               text,
  appointment_id              text,
  meet_room_id                text,
  engine                      text,
  current_profile_version_id  text,
  current_audit_version_id    text,
  current_proposal_version_id text,
  authorization_approval_id   text,
  delivery_approval_id        text,
  share_link_id               text,
  customer_id                 text,
  delivery_project_id         text,
  onboarding_status           text not null default 'not_started',
  is_fixture                  integer not null default 0 check (is_fixture in (0, 1)),
  row_version                 integer not null default 1,
  created_by                  text,
  created_at                  text not null,
  updated_at                  text not null,
  closed_at                   text,
  closed_reason               text
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_engagements_cycle_idx
  ON ai_audit_engagements (tenant_id, lead_id, cycle_no);
CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_engagements_one_open_idx
  ON ai_audit_engagements (tenant_id, lead_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_audit_engagements_stage_idx
  ON ai_audit_engagements (tenant_id, stage, updated_at);

CREATE TRIGGER IF NOT EXISTS ai_audit_engagements_tenant_immutable
BEFORE UPDATE OF tenant_id, lead_id ON ai_audit_engagements
WHEN NEW.tenant_id IS NOT OLD.tenant_id OR NEW.lead_id IS NOT OLD.lead_id
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_engagement_identity_immutable');
END;

CREATE TABLE IF NOT EXISTS ai_audit_events (
  id            text not null primary key,
  tenant_id     text not null,
  engagement_id text not null,
  event         text not null,
  from_stage    text,
  to_stage      text,
  actor_type    text not null,
  actor_id      text,
  ref_type      text,
  ref_id        text,
  meta          text not null default '{}',
  created_at    text not null
);

CREATE INDEX IF NOT EXISTS ai_audit_events_engagement_idx
  ON ai_audit_events (tenant_id, engagement_id, created_at);

CREATE TRIGGER IF NOT EXISTS ai_audit_events_append_only
BEFORE UPDATE ON ai_audit_events
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_events_append_only');
END;

CREATE TABLE IF NOT EXISTS ai_audit_steps (
  id               text not null primary key,
  tenant_id        text not null,
  engagement_id    text not null,
  step_key         text not null,
  run_no           integer not null default 1,
  runs_on          text not null default 'cloud',
  status           text not null default 'queued',
  input_hash       text,
  idempotency_key  text not null,
  lease_id         text,
  lease_expires_at text,
  attempts         integer not null default 0,
  max_attempts     integer not null default 3,
  next_attempt_at  text,
  tool_job_id      text,
  result_ref       text,
  error_code       text,
  error_message    text,
  created_at       text not null,
  updated_at       text not null,
  finished_at      text
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_steps_idempotency_idx
  ON ai_audit_steps (tenant_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_steps_in_flight_idx
  ON ai_audit_steps (tenant_id, engagement_id, step_key)
  WHERE status IN ('queued', 'running', 'waiting_runner');
CREATE INDEX IF NOT EXISTS ai_audit_steps_due_idx
  ON ai_audit_steps (tenant_id, status, next_attempt_at);

CREATE TABLE IF NOT EXISTS ai_audit_settings (
  tenant_id   text not null primary key,
  settings    text not null default '{}',
  row_version integer not null default 1,
  updated_by  text,
  updated_at  text not null
);

CREATE TABLE IF NOT EXISTS ai_audit_profile_versions (
  id                text not null primary key,
  tenant_id         text not null,
  engagement_id     text not null,
  version_no        integer not null,
  status            text not null default 'draft',
  source            text not null default 'manual',
  summary           text not null default '{}',
  profile_sha256    text,
  transcript_sha256 text,
  created_by        text,
  created_at        text not null,
  updated_at        text not null,
  frozen_at         text
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_profile_versions_no_idx
  ON ai_audit_profile_versions (tenant_id, engagement_id, version_no);

CREATE TRIGGER IF NOT EXISTS ai_audit_profile_versions_frozen
BEFORE UPDATE OF summary, transcript_sha256, engagement_id, version_no ON ai_audit_profile_versions
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_profile_version_frozen');
END;

CREATE TABLE IF NOT EXISTS ai_audit_profile_fields (
  id                 text not null primary key,
  tenant_id          text not null,
  profile_version_id text not null,
  field_key          text not null,
  value_json         text not null,
  label              text not null,
  source_type        text not null,
  source_ref         text not null default '{}',
  evidence_quote     text,
  confidence         real,
  owner_corrected    integer not null default 0 check (owner_corrected in (0, 1)),
  corrected_from     text,
  verified_note      text,
  updated_by         text,
  updated_at         text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_profile_fields_key_idx
  ON ai_audit_profile_fields (tenant_id, profile_version_id, field_key);

CREATE TRIGGER IF NOT EXISTS ai_audit_profile_fields_frozen_insert
BEFORE INSERT ON ai_audit_profile_fields
WHEN (SELECT status FROM ai_audit_profile_versions WHERE id = NEW.profile_version_id) IS NOT 'draft'
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_profile_version_frozen');
END;

CREATE TRIGGER IF NOT EXISTS ai_audit_profile_fields_frozen_update
BEFORE UPDATE ON ai_audit_profile_fields
WHEN (SELECT status FROM ai_audit_profile_versions WHERE id = OLD.profile_version_id) IS NOT 'draft'
  AND (NEW.value_json IS NOT OLD.value_json
    OR NEW.label IS NOT OLD.label
    OR NEW.field_key IS NOT OLD.field_key
    OR NEW.source_type IS NOT OLD.source_type
    OR NEW.source_ref IS NOT OLD.source_ref
    OR NEW.profile_version_id IS NOT OLD.profile_version_id
    OR NEW.verified_note IS NOT OLD.verified_note)
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_profile_version_frozen');
END;

CREATE TABLE IF NOT EXISTS ai_audit_versions (
  id                 text not null primary key,
  tenant_id          text not null,
  engagement_id      text not null,
  version_no         integer not null,
  status             text not null default 'draft',
  content            text not null,
  content_sha256     text not null,
  profile_version_id text,
  supersedes_id      text,
  approval_id        text,
  pdf_path           text,
  pdf_sha256         text,
  pdf_bytes          integer,
  pdf_pages          integer,
  pdf_rendered_at    text,
  created_by         text,
  created_at         text not null,
  updated_at         text not null,
  submitted_at       text,
  approved_at        text,
  delivered_at       text
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_versions_no_idx
  ON ai_audit_versions (tenant_id, engagement_id, version_no);

CREATE TRIGGER IF NOT EXISTS ai_audit_versions_content_frozen
BEFORE UPDATE OF content, content_sha256, engagement_id, version_no, profile_version_id ON ai_audit_versions
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_version_frozen');
END;

CREATE TRIGGER IF NOT EXISTS ai_audit_versions_delivered_final
BEFORE UPDATE OF status ON ai_audit_versions
WHEN OLD.status = 'delivered' AND NEW.status NOT IN ('delivered', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_version_delivered');
END;

CREATE TABLE IF NOT EXISTS ai_service_catalogue_items (
  id                      text not null primary key,
  tenant_id               text not null,
  sku                     text not null,
  item_version            integer not null,
  status                  text not null default 'proposed',
  name                    text not null,
  description             text not null default '',
  category                text not null,
  unit                    text not null,
  unit_label              text,
  price_cents             integer,
  currency                text not null,
  deliverables            text not null default '[]',
  onboarding_requirements text not null default '[]',
  source_ref              text not null default '{}',
  is_fixture              integer not null default 0 check (is_fixture in (0, 1)),
  created_by              text,
  created_at              text not null,
  updated_at              text not null,
  confirmed_by            text,
  confirmed_at            text,
  retired_by              text,
  retired_at              text
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_service_catalogue_version_idx
  ON ai_service_catalogue_items (tenant_id, sku, item_version);
CREATE UNIQUE INDEX IF NOT EXISTS ai_service_catalogue_one_confirmed_idx
  ON ai_service_catalogue_items (tenant_id, sku) WHERE status = 'confirmed';

CREATE TRIGGER IF NOT EXISTS ai_service_catalogue_confirmed_price_final
BEFORE UPDATE ON ai_service_catalogue_items
WHEN OLD.status <> 'proposed'
  AND (NEW.price_cents IS NOT OLD.price_cents
    OR NEW.currency IS NOT OLD.currency
    OR NEW.unit IS NOT OLD.unit
    OR NEW.name IS NOT OLD.name
    OR NEW.sku IS NOT OLD.sku
    OR NEW.item_version IS NOT OLD.item_version)
BEGIN
  SELECT RAISE(ABORT, 'ai_service_catalogue_item_final');
END;

CREATE TABLE IF NOT EXISTS ai_audit_proposal_versions (
  id               text not null primary key,
  tenant_id        text not null,
  engagement_id    text not null,
  version_no       integer not null,
  status           text not null default 'draft',
  currency         text not null,
  content          text not null,
  content_sha256   text not null,
  subtotal_cents   integer,
  tax_cents        integer,
  total_cents      integer,
  due_now_cents    integer,
  valid_until      text,
  audit_version_id text,
  supersedes_id    text,
  created_by       text,
  created_at       text not null,
  updated_at       text not null,
  submitted_at     text,
  approved_at      text,
  delivered_at     text
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_proposal_versions_no_idx
  ON ai_audit_proposal_versions (tenant_id, engagement_id, version_no);

CREATE TRIGGER IF NOT EXISTS ai_audit_proposal_versions_frozen
BEFORE UPDATE OF content, content_sha256, currency, subtotal_cents, tax_cents, total_cents, due_now_cents, valid_until, engagement_id, version_no ON ai_audit_proposal_versions
WHEN OLD.status <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_proposal_version_frozen');
END;

CREATE TRIGGER IF NOT EXISTS ai_audit_proposal_versions_delivered_final
BEFORE UPDATE OF status ON ai_audit_proposal_versions
WHEN OLD.status = 'delivered' AND NEW.status NOT IN ('delivered', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'ai_audit_proposal_version_delivered');
END;
