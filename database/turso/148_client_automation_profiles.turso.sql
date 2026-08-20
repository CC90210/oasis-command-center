-- 148 — client_automation_profiles, libSQL port of database/148.
--
-- THIS IS THE FILE THAT ACTUALLY RUNS. Production is
-- EMPIRE_DATA_BACKEND=turso_cloud; the Postgres companion is the reference
-- dialect, this one is the deployed schema. Same warning 147 carries.
--
-- THE MODEL THIS EXISTS FOR. OASIS sells a website plus one or two automations
-- to many local businesses. Every client site posts its contact form to ONE
-- central OASIS webhook, and ONE shared agent answers all of them. Per inbound
-- post the agent must answer "who am I right now?" — whose brand, whose
-- services, whose hours, whose rules, which humans get copied. That answer is a
-- row here, resolved from the posting site.
--
-- THE CREDENTIAL DIRECTION IS DELIBERATE. Clients never hand OASIS a mailbox
-- password. OASIS owns the sending identity (reply_from_identity) and CCs the
-- owner (cc_emails) on every reply, so the owner sees every interaction without
-- a credential changing hands. There is no password / app-password / oauth
-- column here and there must never be one. The only secret this table holds is
-- the per-site ingest key, stored as a SHA-256 hash.
--
-- Dialect notes (house conventions, see 142-147):
--   * uuid -> TEXT; the app supplies ids (crypto.randomUUID). No
--     gen_random_uuid() in SQLite.
--   * timestamptz -> TEXT ISO-8601 UTC, DEFAULT strftime('...Z','now').
--   * jsonb -> TEXT holding JSON. lib/turso-postgrest.ts stringifies objects on
--     write and JSON.parses strings starting with { or [ on read, so callers
--     see real arrays/objects on both backends.
--   * jsonb_typeof(x)='array'  -> json_valid(x) AND json_type(x)='array'
--     jsonb_array_length(x)    -> json_array_length(x)
--     position('.' in x) > 0   -> instr(x,'.') > 0
--     btrim(x)                 -> trim(x)
--     x ~ '^[0-9a-f]{64}$'     -> length + lower + GLOB character-class test
--   * NO RLS statements — Turso has none; tenant scoping is manual in the
--     adapter, every statement carries tenant_id.
--
-- No explicit BEGIN/COMMIT: the migration runner executes a file as one
-- transactional batch, and a nested BEGIN errors out.

CREATE TABLE IF NOT EXISTS "client_automation_profiles" (
  "id"                    TEXT NOT NULL PRIMARY KEY,
  "tenant_id"             TEXT NOT NULL,

  -- Provenance + CRM linkage, both nullable: a site sold before the sales
  -- engine existed still needs a profile, and losing the deal row must not
  -- silently kill a live client's automation. SET NULL, never CASCADE —
  -- deleting a deal is a sales correction, not a service termination.
  --
  -- Single-column FKs, not 147's composite (tenant_id, x) pattern: a composite
  -- ON DELETE SET NULL nulls every referencing column including tenant_id,
  -- which is NOT NULL, so the first detach would raise instead of detaching.
  -- Same-tenant integrity is enforced by the provisioning code, which reads the
  -- onboarding row tenant-scoped before writing the profile — the same manual
  -- scoping every other statement here already relies on.
  "onboarding_id"         TEXT REFERENCES "website_onboarding" ("id") ON DELETE SET NULL,
  "lead_id"               TEXT REFERENCES "tenant_records" ("id") ON DELETE SET NULL,

  -- ---- Identity the agent speaks as ---------------------------------------
  "client_name"           TEXT NOT NULL CHECK (length(trim("client_name")) > 0),
  -- THE WEBHOOK MATCH KEY. Bare, normalized host: lowercase, no scheme, no
  -- path, no port, no trailing dot. These CHECKs are not decoration — a row
  -- written as "https://acme.com/" would never match the Host the webhook
  -- actually sees, and the symptom would read as "the agent ignored my client"
  -- rather than as a data error.
  "website_domain"        TEXT NOT NULL
                            CHECK ("website_domain" = lower("website_domain"))
                            CHECK ("website_domain" NOT LIKE '%://%')
                            CHECK ("website_domain" NOT LIKE '%/%')
                            CHECK ("website_domain" NOT LIKE '% %')
                            CHECK ("website_domain" NOT LIKE '%.')
                            CHECK (instr("website_domain", '.') > 0),
  "industry"              TEXT,
  -- Free text, matching how icp_track already travels on leads
  -- (lib/leads-import-service.ts caps it at 80 chars). No CHECK: the track
  -- vocabulary is a sales artifact that changes faster than a migration.
  "icp_track"             TEXT,
  -- One sentence: what this business does. Goes into the agent's system prompt.
  "mission_summary"       TEXT,
  -- How replies should sound, in the client's own words. Free text on purpose:
  -- a tone enum cannot carry "never call them 'guys', we serve contractors".
  "brand_voice"           TEXT,
  "reply_tone"            TEXT NOT NULL DEFAULT 'professional'
                            CHECK ("reply_tone" IN ('formal','professional','friendly','casual')),
  -- The 3-5 services they most want leads for. JSON array of strings; the
  -- classifier uses it to decide whether an inbound is in scope.
  "services"              TEXT NOT NULL DEFAULT '[]'
                            CHECK (json_valid("services") AND json_type("services") = 'array'),
  -- Hard "never say this" rules — pricing, guarantees, timelines. JSON array of
  -- strings, injected as prohibitions into the reply prompt. Empty is legal and
  -- means the client stated none.
  "prohibited_claims"     TEXT NOT NULL DEFAULT '[]'
                            CHECK (json_valid("prohibited_claims") AND json_type("prohibited_claims") = 'array'),

  -- ---- Where the agent's reply goes ---------------------------------------
  -- The OASIS-owned sending identity this client's replies go out as. NOT a
  -- credential — a key into the send layer's identity registry.
  "reply_from_identity"   TEXT NOT NULL CHECK (length(trim("reply_from_identity")) > 0),
  -- The owner addresses copied on EVERY automated reply. This is the whole
  -- transparency promise of the model, hence the active-status CHECK below.
  "cc_emails"             TEXT NOT NULL DEFAULT '[]'
                            CHECK (json_valid("cc_emails") AND json_type("cc_emails") = 'array'),
  -- Who gets pinged for urgent/escalated submissions. May legitimately be empty
  -- (falls back to cc_emails at notify time).
  "notification_emails"   TEXT NOT NULL DEFAULT '[]'
                            CHECK (json_valid("notification_emails") AND json_type("notification_emails") = 'array'),
  "primary_phone"         TEXT,

  -- ---- Operating envelope --------------------------------------------------
  -- {"mon":[["09:00","17:00"]], ..., "sat":[], "sun":[]} — an array of ranges
  -- per day so a split shift (lunch close) is expressible. Meaningless without
  -- a timezone, which is why timezone is NOT NULL with an IANA default.
  "business_hours"        TEXT NOT NULL DEFAULT '{}'
                            CHECK (json_valid("business_hours") AND json_type("business_hours") = 'object'),
  "timezone"              TEXT NOT NULL DEFAULT 'America/Toronto'
                            CHECK (length(trim("timezone")) > 0),
  "service_area"          TEXT,
  -- How fast the client wants a customer answered, in minutes. Drives the
  -- reply-latency target and the escalation ping; not a hard scheduler input.
  "response_sla_minutes"  INTEGER CHECK ("response_sla_minutes" > 0),

  -- ---- Per-site webhook credential -----------------------------------------
  -- SHA-256 hex of the raw ingest key. The raw key is returned exactly once at
  -- issuance (for the build team to paste into the client's site) and is never
  -- persisted or logged. UNIQUE GLOBALLY, not per tenant: the inbound webhook
  -- authenticates by key first and resolves the profile from that, so the key
  -- must identify exactly one row across the whole database. The domain is then
  -- asserted against the resolved row rather than trusted as the lookup key.
  "ingest_key_hash"       TEXT NOT NULL UNIQUE
                            CHECK (length("ingest_key_hash") = 64
                                   AND "ingest_key_hash" = lower("ingest_key_hash")
                                   AND "ingest_key_hash" NOT GLOB '*[^0-9a-f]*'),
  "ingest_key_issued_at"  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "ingest_key_rotated_at" TEXT,
  "ingest_key_last_used_at" TEXT,

  -- ---- Consent evidence (step 5 of onboarding) -----------------------------
  -- OASIS sends mail on the client's behalf from an OASIS-owned address. That
  -- authority is granted, in writing, by a named human, and the grant has to
  -- survive being challenged — so the name, the timestamp, and the exact
  -- disclosure text the approver saw are all stored. A consent record that
  -- cannot reproduce the wording is not evidence.
  "approver_name"         TEXT,
  "approver_email"        TEXT,
  "send_consent_at"       TEXT,
  "send_consent_name"     TEXT,
  "send_consent_evidence" TEXT NOT NULL DEFAULT '{}'
                            CHECK (json_valid("send_consent_evidence") AND json_type("send_consent_evidence") = 'object'),

  -- ---- Lifecycle -----------------------------------------------------------
  -- pending = provisioned, not yet answering. active = the shared agent replies
  -- as this brand. paused = keep the config, stop replying.
  "status"                TEXT NOT NULL DEFAULT 'pending'
                            CHECK ("status" IN ('pending','active','paused')),
  "activated_at"          TEXT,
  "paused_at"             TEXT,
  "paused_reason"         TEXT,
  "created_by"            TEXT,
  "created_at"            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at"            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- One profile per site per tenant. This is the operator-facing uniqueness;
  -- the webhook's uniqueness is ingest_key_hash above.
  UNIQUE ("tenant_id", "website_domain"),

  -- AN ACTIVE PROFILE THAT CCs NOBODY IS THE FAILURE THIS TABLE EXISTS TO
  -- PREVENT: the agent would be answering the client's customers, as the
  -- client, with the client unable to see any of it. Legal at 'pending' (the
  -- profile is provisioned before onboarding completes), never at 'active'.
  CONSTRAINT "client_automation_profiles_active_needs_cc"
    CHECK ("status" <> 'active' OR json_array_length("cc_emails") > 0),
  -- Likewise: no live automated sending without recorded consent to send.
  CONSTRAINT "client_automation_profiles_active_needs_consent"
    CHECK ("status" <> 'active' OR "send_consent_at" IS NOT NULL),

  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
);

-- Operator list view: profiles for a tenant, newest activity first.
CREATE INDEX IF NOT EXISTS "client_automation_profiles_tenant_status_idx"
  ON "client_automation_profiles" ("tenant_id", "status", "updated_at" DESC);

-- THE HOT PATH. The inbound webhook arrives with a Host and a key; this backs
-- the domain half of that resolution across all tenants. The composite
-- (tenant_id, website_domain) unique above cannot serve it — tenant_id leads.
CREATE INDEX IF NOT EXISTS "client_automation_profiles_domain_idx"
  ON "client_automation_profiles" ("website_domain")
  WHERE "status" IN ('active','pending');

-- CRM traversal: client record -> its automation config.
CREATE INDEX IF NOT EXISTS "client_automation_profiles_lead_idx"
  ON "client_automation_profiles" ("tenant_id", "lead_id")
  WHERE "lead_id" IS NOT NULL;
