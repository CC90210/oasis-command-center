-- 183 - Projects + Tickets: delivery tracking, support tickets, provisioning runs,
-- and the Client Support Ticket form (2026-09-24).
--
-- WHY THIS FILE EXISTS. The SQL for these tables sat in three top-level files
-- (database/176_provisioning_runs.sql, 177_delivery_tracking.sql,
-- 178_support_tickets.sql) OUTSIDE database/turso/, so it was never applied to
-- the live database. /projects and /tickets swallowed the resulting "no such
-- table" errors and rendered empty states. Those three files are deleted in the
-- same commit; their content lives here, completed.
--
-- The tables do not exist live, so this CREATEs them in their final shape rather
-- than ALTERing a draft. IF NOT EXISTS keeps a re-run harmless.
--
-- OWNERSHIP MODEL. Every row belongs to the OASIS workspace: tenant_id is always
-- the OASIS tenant (ef8d389e-3f15-43f2-ae00-3660f69a1452, slug oasis-ai-cc).
-- A row MAY name a client two ways:
--   client_tenant_id           a hosted client with its own portal workspace.
--                              Portal users of that tenant see ONLY rows whose
--                              client_tenant_id is their tenant.
--   client_name / client_email a client with no portal (email is stored
--                              lowercased by the app so the index matches).
-- libSQL has no row-level security. The WHERE clause built by
-- lib/delivery/access.ts IS the authorization boundary, which is why tenant_id
-- leads every index below.
--
-- NO CHECK CONSTRAINTS ON THE ENUM COLUMNS (stage, status, severity, ...), on
-- purpose. The allowed values live once, in lib/delivery/rules.ts, where the
-- tests pin them. SQLite cannot alter a CHECK without rebuilding the table, so a
-- second copy here would turn every future stage into a table rebuild. The two
-- client-visibility columns fail CLOSED instead: is_internal defaults to 1 and
-- visibility defaults to 'internal', and clients are served by an allowlist
-- (is_internal = 0 / visibility = 'client'), so a missing or odd value hides
-- the row from the client rather than showing it.
--
-- Timestamps are ISO-8601 UTC strings written by the app
-- (new Date().toISOString()); the defaults use the same format so SLA
-- comparisons stay plain string comparisons.

-- provisioning_runs: kept exactly as 176 defined it. lib/client-provisioning.ts
-- inserts without an id and compares created_at written by datetime('now'), so
-- its defaults are preserved verbatim. Backend only; no UI reads it yet.
CREATE TABLE IF NOT EXISTS provisioning_runs (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id      TEXT NOT NULL,
  tenant_slug    TEXT,
  stripe_invoice TEXT,
  status         TEXT DEFAULT 'pending',
  steps_json     TEXT DEFAULT '[]',
  error_message  TEXT,
  started_at     TEXT,
  completed_at   TEXT,
  created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prov_tenant ON provisioning_runs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_prov_status ON provisioning_runs(status);

-- delivery_projects: one client engagement (a website build, an automation).
-- stage: discovery | building | review | live | maintenance | paused
-- priority: low | medium | high | urgent
-- assigned_to / created_by: auth user ids (lowercased), validated against the
-- OASIS assignment roster by the API.
-- lead_id: optional link to the OASIS lead (tenant_records) the deal came from.
CREATE TABLE IF NOT EXISTS delivery_projects (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id         TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  client_tenant_id  TEXT,
  client_name       TEXT,
  client_email      TEXT,
  lead_id           TEXT,
  stage             TEXT NOT NULL DEFAULT 'discovery',
  priority          TEXT NOT NULL DEFAULT 'medium',
  assigned_to       TEXT,
  due_date          TEXT,
  started_at        TEXT,
  launched_at       TEXT,
  archived_at       TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- The board: every non-archived project in the workspace, by stage.
CREATE INDEX IF NOT EXISTS idx_dp_tenant_stage
  ON delivery_projects (tenant_id, stage, updated_at);
-- A client's portal: their projects only.
CREATE INDEX IF NOT EXISTS idx_dp_tenant_client
  ON delivery_projects (tenant_id, client_tenant_id, updated_at);
-- Support intake matches a submitter's email to their project.
CREATE INDEX IF NOT EXISTS idx_dp_tenant_client_email
  ON delivery_projects (tenant_id, client_email);
CREATE INDEX IF NOT EXISTS idx_dp_tenant_assigned
  ON delivery_projects (tenant_id, assigned_to);

-- delivery_tasks: internal work items on a project. Never shown to clients.
-- status: todo | in_progress | blocked | done | cancelled
CREATE TABLE IF NOT EXISTS delivery_tasks (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id    TEXT NOT NULL,
  tenant_id     TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'todo',
  assigned_to   TEXT,
  notes         TEXT,
  due_date      TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_dt_tenant_project
  ON delivery_tasks (tenant_id, project_id, sort_order);

-- delivery_updates: the project timeline. visibility 'client' is the ONLY value
-- a client ever sees; anything else (including the default) stays internal.
CREATE TABLE IF NOT EXISTS delivery_updates (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id      TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  author_user_id  TEXT,
  author_name     TEXT NOT NULL,
  body            TEXT NOT NULL,
  visibility      TEXT NOT NULL DEFAULT 'internal',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_du_tenant_project
  ON delivery_updates (tenant_id, project_id, created_at);

-- support_tickets.
-- ticket_seq / ticket_number: per-tenant sequence and its display form (T-0001),
--   allocated inside the INSERT itself (MAX + 1) and guarded by the unique
--   indexes below; lib/delivery/store.ts retries on a collision.
-- severity: critical | high | medium | low (drives the first-response SLA)
-- status: open | in_progress | waiting_on_client | resolved | closed
-- category: bug | change_request | question | billing | other
-- source: form | portal | internal
-- sla_target: first-response due time. first_response_at is stamped by the
--   first PUBLIC team reply. sla_breached_at is set by the SLA cron.
-- *_alert_at columns are claim markers written BEFORE a notification is sent
--   (at-most-once); the matching *_status column records what happened.
-- form_submission_id: the form_submissions row a form ticket came from. Unique
--   per tenant, which is what makes intake and the reconcile sweep idempotent.
-- client_match: how the client link was made (session, email_project,
--   email_tenant, manual, none, lookup_failed). A public form's email is
--   unverified, so founders can see which links were inferred.
CREATE TABLE IF NOT EXISTS support_tickets (
  id                        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  tenant_id                 TEXT NOT NULL,
  ticket_seq                INTEGER NOT NULL,
  ticket_number             TEXT NOT NULL,
  title                     TEXT NOT NULL,
  description               TEXT,
  category                  TEXT NOT NULL DEFAULT 'other',
  severity                  TEXT NOT NULL DEFAULT 'medium',
  status                    TEXT NOT NULL DEFAULT 'open',
  source                    TEXT NOT NULL DEFAULT 'internal',
  project_id                TEXT,
  client_tenant_id          TEXT,
  client_name               TEXT,
  client_email              TEXT,
  client_company            TEXT,
  client_match              TEXT,
  project_hint              TEXT,
  reporter_user_id          TEXT,
  assigned_to               TEXT,
  resolution                TEXT,
  attachments               TEXT NOT NULL DEFAULT '[]',
  form_submission_id        TEXT,
  sla_target                TEXT NOT NULL,
  first_response_at         TEXT,
  sla_breached_at           TEXT,
  sla_breach_alert_at       TEXT,
  sla_breach_alert_status   TEXT,
  founder_alert_at          TEXT,
  founder_alert_status      TEXT,
  client_ack_at             TEXT,
  client_ack_status         TEXT,
  resolved_at               TEXT,
  closed_at                 TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_st_tenant_seq
  ON support_tickets (tenant_id, ticket_seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_st_tenant_number
  ON support_tickets (tenant_id, ticket_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_st_tenant_form_submission
  ON support_tickets (tenant_id, form_submission_id)
  WHERE form_submission_id IS NOT NULL;
-- The queue, newest first within a status.
CREATE INDEX IF NOT EXISTS idx_st_tenant_status
  ON support_tickets (tenant_id, status, created_at);
-- A client's portal.
CREATE INDEX IF NOT EXISTS idx_st_tenant_client
  ON support_tickets (tenant_id, client_tenant_id, created_at);
-- Tickets on a project page, and the open-ticket count on each board card.
CREATE INDEX IF NOT EXISTS idx_st_tenant_project
  ON support_tickets (tenant_id, project_id, status);
CREATE INDEX IF NOT EXISTS idx_st_tenant_assigned
  ON support_tickets (tenant_id, assigned_to, status);
-- The SLA cron: unanswered tickets by due time.
CREATE INDEX IF NOT EXISTS idx_st_tenant_sla_unanswered
  ON support_tickets (tenant_id, sla_target)
  WHERE first_response_at IS NULL;

-- ticket_comments: the thread. author_type client | team | system.
-- is_internal defaults to 1 (fail closed): a comment is client-visible only
-- when it was written as a public reply. email_status records the outcome of
-- emailing a public team reply to the client.
CREATE TABLE IF NOT EXISTS ticket_comments (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  ticket_id       TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  author_type     TEXT NOT NULL DEFAULT 'team',
  author_user_id  TEXT,
  author_name     TEXT NOT NULL,
  body            TEXT NOT NULL,
  is_internal     INTEGER NOT NULL DEFAULT 1,
  email_status    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tc_tenant_ticket
  ON ticket_comments (tenant_id, ticket_id, created_at);

-- The Client Support Ticket form, seeded once for the OASIS workspace at
-- /f/oasis-ai-cc/support. Source of truth: lib/delivery/support-form.ts
-- (tests/delivery-support-form.test.ts asserts this JSON equals it).
-- Idempotent: inserts only when the tenant exists and has no form with this
-- slug, so an operator's later edits in the form builder are never overwritten.
INSERT INTO forms (tenant_id, slug, name, description, branding, steps, on_complete_stage, step_outcomes, enabled, redirect_url, created_by, created_at, updated_at)
SELECT
  'ef8d389e-3f15-43f2-ae00-3660f69a1452',
  'support',
  'Client Support Ticket',
  'Clients report an issue or request a change. Every submission becomes a support ticket (never a lead) with a ticket number, a first-response SLA and a confirmation email.',
  '{"primary_color":"#e8c547","accent_color":"#faf9f5","headline":"OASIS Support","subheadline":"Report a problem or ask for a change. Every request gets a ticket number and a reply from the team.","thanks_message":"Thanks, your ticket is in. A confirmation with your ticket number is on its way to your inbox."}',
  '[{"key":"request","title":"How can we help?","description":"Tell us what is going on. We reply by email and quote your ticket number.","cta_label":"Submit ticket","fields":[{"name":"name","label":"Your name","type":"text","required":true,"placeholder":"Full name","maxLength":120},{"name":"email","label":"Your email","type":"email","required":true,"placeholder":"you@yourbusiness.com","help":"We reply here, and it is how we match the request to your project."},{"name":"company","label":"Company","type":"text","placeholder":"Your business name","maxLength":160},{"name":"project","label":"Which project is this about?","type":"text","placeholder":"Your website or automation, if you know it","help":"Optional. We look your project up from your email either way.","maxLength":160},{"name":"category","label":"What kind of request is it?","type":"select","required":true,"options":[{"value":"bug","label":"Something is broken"},{"value":"change_request","label":"I want something changed"},{"value":"question","label":"I have a question"},{"value":"billing","label":"Billing"},{"value":"other","label":"Something else"}]},{"name":"priority","label":"How urgent is it?","type":"select","required":true,"options":[{"value":"low","label":"Low: whenever you can"},{"value":"medium","label":"Medium: this week"},{"value":"high","label":"High: it is hurting the business"},{"value":"critical","label":"Critical: something is down right now"}]},{"name":"description","label":"What is happening?","type":"textarea","required":true,"placeholder":"What you expected, what happened instead, and where (a page link helps).","maxLength":5000},{"name":"attachment","label":"Screenshot or file","type":"file_upload","accept":["application/pdf","image/png","image/jpeg","image/webp"],"help":"Optional. PDF, PNG, JPEG or WebP, up to 10 MB."}]}]',
  NULL,
  '{}',
  1,
  NULL,
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452')
  AND NOT EXISTS (
    SELECT 1 FROM forms
    WHERE tenant_id = 'ef8d389e-3f15-43f2-ae00-3660f69a1452' AND slug = 'support'
  );
