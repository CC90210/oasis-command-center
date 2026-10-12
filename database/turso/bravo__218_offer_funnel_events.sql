-- bravo__218_offer_funnel_events.sql - funnel tracking for the public offer
-- pages and their forms (V5a, HANDOVER section 5, 2026-10-12).
--
-- WHAT THIS IS. Before this table, no page-view, video-play, step or abandon
-- event existed anywhere for an offer page or a public form: the submit route
-- read only ?rep and ?source, and the Share menu's utm_* params were dropped
-- on the floor. Adon's instruction is "every visitor tracked and accounted
-- for, including those routed to the free community" -- this table is the one
-- place that happens, for every workspace, before and after a lead exists.
--
-- ONE ROW PER EVENT. Events (whitelisted in code, lib/offers/tracking-store.ts
-- -- never a CHECK constraint, same house rule as consent_events):
--   page_view, video_play, video_progress (25/50/75/100 in detail.percent),
--   path_selected (detail.path), step_viewed, step_submitted,
--   community_click, checkout_click, booking_made.
--
-- PRIVACY (Quebec Law 25). BEFORE any consent, this table stores AGGREGATE
-- COUNTS ONLY, keyed by a random per-visit id the BROWSER generates into
-- sessionStorage (lib/offers/tracking-client.ts) -- never a cookie, never an
-- IP address, never a fingerprint, never a User-Agent string. visit_id is
-- opaque and unguessable (crypto.randomUUID()); it identifies a browser tab's
-- session, not a person. lead_id starts NULL on every row and is filled in
-- ONLY at form submit (app/api/forms/submit/route.ts calls
-- lib/offers/tracking-store.ts:linkVisitToLead), the moment the visitor has
-- given their own details -- never before. A visit that never submits stays
-- anonymous forever.
--
-- RETENTION: 13 months. lib/offers/tracking-store.ts:purgeFunnelEventsOlderThan
-- is the purge helper (tests/offer-funnel-events.test.ts proves it deletes
-- exactly the rows past the cutoff and nothing else). No cron wiring yet --
-- this migration ships the table and the helper; wiring a scheduled purge is
-- a later slice.
--
-- House rules (bravo__190_ledger_core.sql, bravo__214_consent_events.sql):
--   - tenant_id TEXT NOT NULL, every index LEADS with tenant_id. libSQL has
--     no row-level security -- the WHERE built in lib/offers/tracking-store.ts
--     is the isolation boundary.
--   - NO CHECK constraints on the event vocabulary. It lives once in
--     lib/offers/tracking-store.ts and is pinned by
--     tests/offer-funnel-events.test.ts.
--   - ids are TEXT written by the app (randomUUID). Timestamps are ISO-8601
--     UTC strings written by the app (Date.toISOString()).
--   - No comment after a semicolon on the same line (the applier splits on
--     ';' plus newline).
--
-- NOT insert-only, unlike consent_events: lead_id is the one column the app
-- updates after the row is written (the visit-to-lead link at submit). No
-- other column is ever changed, and this table carries no legal-evidence
-- weight the way a consent decision does, so there is no no-update trigger
-- here -- and no no-delete trigger either, because the 13-month purge above
-- must be able to delete rows.
--
-- Apply first, verify the table name is free with
--   node scripts/turso_sql.mjs --db bravo-empire --json
--     "SELECT name FROM sqlite_master WHERE name LIKE 'offer_funnel%'"
-- THEN deploy the code that reads/writes it.

CREATE TABLE IF NOT EXISTS offer_funnel_events (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  form_id    TEXT NOT NULL,
  visit_id   TEXT NOT NULL,
  event      TEXT NOT NULL,
  step_index INTEGER,
  detail     TEXT,
  lead_id    TEXT,
  created_at TEXT NOT NULL
);

-- The Offers card funnel strip (lib/offer-pages/store.ts:countFunnelEventMetrics):
-- "how many distinct visits did page_view / video_play / community_click, on
-- this form, in the last 7 days". tenant_id leads so a cross-tenant query is
-- structurally impossible, not merely unlikely.
CREATE INDEX IF NOT EXISTS ix_offer_funnel_events_form
  ON offer_funnel_events (tenant_id, form_id, event, created_at);

-- The visit-to-lead link at submit (linkVisitToLead) and the /go/community
-- redirect's "does this visit already have a lead" read (findLeadForVisit):
-- both look up by (tenant_id, visit_id).
CREATE INDEX IF NOT EXISTS ix_offer_funnel_events_visit
  ON offer_funnel_events (tenant_id, visit_id, created_at);

-- The 13-month purge scans by age within a tenant at a time (never a
-- cross-tenant table scan, matching the house rule above).
CREATE INDEX IF NOT EXISTS ix_offer_funnel_events_purge
  ON offer_funnel_events (tenant_id, created_at);
