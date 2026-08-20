-- 148 — client_automation_profiles: the identity a shared classifier speaks as.
--
-- THE MODEL THIS EXISTS FOR. OASIS sells a website plus one or two automations
-- to many local businesses. Every one of those client sites posts its contact
-- form to ONE central OASIS webhook, and ONE shared agent answers all of them.
-- The agent therefore needs, per inbound post, an answer to "who am I right
-- now?" — whose brand, whose services, whose hours, whose rules, and which
-- humans get copied. That answer is a row in this table, resolved from the
-- posting site. Without it the shared agent has no identity and cannot reply.
--
-- THE CREDENTIAL DIRECTION IS DELIBERATE. Clients never hand OASIS a mailbox
-- password. OASIS owns the sending identity (reply_from_identity) and simply
-- CCs the owner (cc_emails) on every reply, so the owner sees every interaction
-- without a credential ever changing hands. That is why there is no password,
-- app-password, or oauth column here and there must never be one: the only
-- secret this table holds is the per-site ingest key, and it is stored hashed.
--
-- RELATIONSHIP TO THE SALES ENGINE (146/147). A profile is provisioned from a
-- completed onboarding: website_onboarding.intake holds the answers, this row
-- holds the operational contract derived from them. onboarding_id records that
-- provenance; lead_id lets the CRM jump between the client record and its
-- automation config. Both are NULLABLE because a site sold before the sales
-- engine existed still needs a profile, and losing the deal row must not
-- silently disable a live client's automation (hence ON DELETE SET NULL, not
-- CASCADE — deleting a deal is a sales correction, not a service termination).

begin;

create table if not exists public.client_automation_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- Provenance + CRM linkage. See the header for why both are nullable.
  --
  -- SINGLE-COLUMN FKs, NOT 146's COMPOSITE (tenant_id, x) PATTERN, and the
  -- reason is ON DELETE SET NULL: a composite SET NULL nulls EVERY referencing
  -- column, tenant_id included, and tenant_id is NOT NULL — so the first
  -- deleted onboarding row would raise instead of detaching. Same-tenant
  -- integrity is enforced by the provisioning code, which reads the onboarding
  -- row tenant-scoped before it ever writes the profile. That is already the
  -- rule under Turso, where FKs to tenants are advisory and every statement
  -- carries tenant_id explicitly.
  onboarding_id uuid references public.website_onboarding(id) on delete set null,
  lead_id uuid references public.tenant_records(id) on delete set null,

  -- ---- Identity the agent speaks as -------------------------------------
  client_name text not null check (length(btrim(client_name)) > 0),
  -- THE WEBHOOK MATCH KEY. Stored bare and normalized: lowercase host only —
  -- no scheme, no path, no port, no trailing dot. The CHECKs below are not
  -- decoration: a row written as "https://acme.com/" would never match the
  -- Host the webhook actually sees, and the failure would look like "the
  -- agent ignored my client" rather than like a data error.
  website_domain text not null
    check (website_domain = lower(website_domain))
    check (website_domain not like '%://%')
    check (website_domain not like '%/%')
    check (website_domain not like '% %')
    check (website_domain not like '%.')
    check (position('.' in website_domain) > 0),
  industry text,
  -- Free text, matching how icp_track already travels on leads
  -- (lib/leads-import-service.ts caps it at 80 chars). No CHECK: the track
  -- vocabulary is a sales artifact that changes faster than a migration.
  icp_track text,
  -- One sentence: what this business does. Goes into the agent's system prompt.
  mission_summary text,
  -- How replies should sound, in the client's own words. Free text on purpose:
  -- a tone enum cannot carry "never call them 'guys', we serve contractors".
  brand_voice text,
  reply_tone text not null default 'professional'
    check (reply_tone in ('formal','professional','friendly','casual')),
  -- The 3-5 services they most want leads for. JSON array of strings; the
  -- classifier uses it to decide whether an inbound is in-scope.
  services jsonb not null default '[]'::jsonb
    check (jsonb_typeof(services) = 'array'),
  -- Hard "never say this" rules — pricing, guarantees, timelines. JSON array of
  -- strings, injected as prohibitions into the reply prompt. An empty array is
  -- legal and means the client stated none.
  prohibited_claims jsonb not null default '[]'::jsonb
    check (jsonb_typeof(prohibited_claims) = 'array'),

  -- ---- Where the agent's reply goes -------------------------------------
  -- The OASIS-owned sending identity this client's replies go out as. NOT a
  -- credential — a key into the send layer's identity registry.
  reply_from_identity text not null check (length(btrim(reply_from_identity)) > 0),
  -- The owner addresses copied on EVERY automated reply. This is the whole
  -- transparency promise of the model, which is why an active profile may not
  -- have an empty list (see the status CHECK below).
  cc_emails jsonb not null default '[]'::jsonb
    check (jsonb_typeof(cc_emails) = 'array'),
  -- Who gets pinged for urgent/escalated submissions. May legitimately be empty
  -- (falls back to cc_emails at notify time).
  notification_emails jsonb not null default '[]'::jsonb
    check (jsonb_typeof(notification_emails) = 'array'),
  primary_phone text,

  -- ---- Operating envelope -----------------------------------------------
  -- {"mon":[["09:00","17:00"]], ..., "sat":[], "sun":[]} — array of ranges per
  -- day so a split shift (lunch close) is expressible. Meaningless without
  -- timezone, which is why timezone is NOT NULL with an IANA default.
  business_hours jsonb not null default '{}'::jsonb
    check (jsonb_typeof(business_hours) = 'object'),
  timezone text not null default 'America/Toronto'
    check (length(btrim(timezone)) > 0),
  service_area text,
  -- How fast the client wants a customer answered, in minutes. Drives the
  -- reply-latency target and the escalation ping; not a hard scheduler input.
  response_sla_minutes integer check (response_sla_minutes > 0),

  -- ---- Per-site webhook credential --------------------------------------
  -- SHA-256 hex of the raw ingest key. The raw key is returned exactly once at
  -- issuance (for the build team to paste into the client's site) and never
  -- persisted or logged. UNIQUE GLOBALLY, not per tenant: the inbound webhook
  -- authenticates by key first and resolves the profile from that, so the key
  -- must identify exactly one row across the whole database. Domain is then
  -- asserted against the resolved row rather than trusted as the lookup key.
  ingest_key_hash text not null unique check (ingest_key_hash ~ '^[0-9a-f]{64}$'),
  ingest_key_issued_at timestamptz not null default now(),
  ingest_key_rotated_at timestamptz,
  ingest_key_last_used_at timestamptz,

  -- ---- Consent evidence (step 5 of onboarding) --------------------------
  -- OASIS sends mail on the client's behalf from an OASIS-owned address. That
  -- authority is granted, in writing, by a named human, and the grant has to
  -- survive being challenged — so the name, the timestamp, and the exact
  -- disclosure text the approver saw are all stored. A consent record that
  -- cannot reproduce the wording is not evidence.
  approver_name text,
  approver_email text,
  send_consent_at timestamptz,
  send_consent_name text,
  send_consent_evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(send_consent_evidence) = 'object'),

  -- ---- Lifecycle ---------------------------------------------------------
  -- pending = provisioned, not yet answering. active = the shared agent will
  -- reply as this brand. paused = keep the config, stop replying.
  status text not null default 'pending' check (status in ('pending','active','paused')),
  activated_at timestamptz,
  paused_at timestamptz,
  paused_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One profile per site per tenant. This is the operator-facing uniqueness;
  -- the webhook's uniqueness is ingest_key_hash above.
  unique (tenant_id, website_domain),
  -- AN ACTIVE PROFILE THAT CCs NOBODY IS THE FAILURE THIS TABLE EXISTS TO
  -- PREVENT: the agent would be answering the client's customers, as the
  -- client, with the client unable to see any of it. Legal at 'pending' (the
  -- profile is provisioned before onboarding completes), never at 'active'.
  constraint client_automation_profiles_active_needs_cc
    check (status <> 'active' or jsonb_array_length(cc_emails) > 0),
  -- Likewise: no live automated sending without recorded consent to send.
  constraint client_automation_profiles_active_needs_consent
    check (status <> 'active' or send_consent_at is not null)
);

-- Operator list view: profiles for a tenant, newest activity first.
create index if not exists client_automation_profiles_tenant_status_idx
  on public.client_automation_profiles (tenant_id, status, updated_at desc);

-- THE HOT PATH. The inbound webhook arrives with a Host and a key; this backs
-- the domain half of that resolution across all tenants. The composite
-- (tenant_id, website_domain) unique above cannot serve it — tenant_id leads.
create index if not exists client_automation_profiles_domain_idx
  on public.client_automation_profiles (website_domain)
  where status in ('active','pending');

-- CRM traversal: client record → its automation config.
create index if not exists client_automation_profiles_lead_idx
  on public.client_automation_profiles (tenant_id, lead_id)
  where lead_id is not null;

alter table public.client_automation_profiles enable row level security;
alter table public.client_automation_profiles force row level security;
create policy client_automation_profiles_service_role
  on public.client_automation_profiles for all to service_role using (true) with check (true);

commit;
