-- 112_esign.sql — in-house e-signature system (DocuSign-lite).
--
-- Two uses: (A) send a contract to one or more signers by email for
-- signature, (B) sign an unsigned application/other PDF already on file.
-- The signed PDF is the ORIGINAL source PDF with a signature/certificate
-- page appended per completed signer (lib/esign/pdf.ts appendSignaturePages)
-- — this is ESIGN/UETA-sound and works regardless of source PDF content, no
-- drag-drop field-placement editor needed for MVP.
--
-- Trust model (matches 103_application_signing.sql, the reserved/unwired
-- predecessor this supersedes): only the SERVICE-ROLE server client touches
-- these tables. RLS is FORCED with NO permissive policies, so the anon/
-- authenticated Supabase roles can never read or write them directly —
-- every read/write goes through lib/esign/db.ts (service-role) from either
-- session-authed dashboard routes (app/api/esign/**) or the public
-- token-gated signing routes (app/api/sign/[token]), which authenticate via
-- the signer's own sha256(token) lookup, never a Supabase session.
--
-- Idempotent: create table if not exists / create index if not exists.
-- Safe to re-apply.

-- ---------------------------------------------------------------------------
-- esign_envelopes: one row per "send for signature" / "sign this PDF" request.
-- ---------------------------------------------------------------------------
create table if not exists public.esign_envelopes (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null,
  created_by                  uuid not null,                 -- operator auth_user_id
  title                       text not null,
  status                      text not null default 'draft', -- draft|sent|viewed|partially_signed|completed|voided|declined|expired
  source_storage_key          text not null,                 -- lead-documents bucket path to the source PDF
  source_document_id          uuid,                           -- lead_documents.id when the source is an existing lead doc (nullable)
  source_pdf_sha256           text not null,                  -- tamper-evidence hash of the source PDF bytes
  signed_storage_key          text,                            -- lead-documents bucket path to the completed signed PDF (set on completion)
  signed_document_id          uuid,                            -- lead_documents.id of the registered signed PDF (nullable until filed)
  signed_pdf_sha256           text,                            -- tamper-evidence hash of the signed PDF bytes
  lead_id                     uuid,                            -- optional link to a SunBiz lead
  application_id              uuid,                            -- optional link to a SunBiz application
  consent_disclosure_version  text not null default 'v1',      -- ESIGN disclosure version signers accept
  message                     text,                             -- optional note to signers
  expires_at                  timestamptz,
  completed_at                timestamptz,
  void_reason                 text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index if not exists esign_envelopes_tenant_idx on public.esign_envelopes (tenant_id, created_at desc);
create index if not exists esign_envelopes_lead_idx on public.esign_envelopes (tenant_id, lead_id);
create index if not exists esign_envelopes_application_idx on public.esign_envelopes (tenant_id, application_id);
alter table public.esign_envelopes enable row level security;
alter table public.esign_envelopes force row level security;
revoke all on public.esign_envelopes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- esign_signers: one row per signer on an envelope.
-- ---------------------------------------------------------------------------
create table if not exists public.esign_signers (
  id                  uuid primary key default gen_random_uuid(),
  envelope_id         uuid not null references public.esign_envelopes(id) on delete cascade,
  tenant_id           uuid not null,
  email               text not null,
  name                text not null,
  sign_order          int not null default 1,
  status              text not null default 'pending',       -- pending|viewed|signed|declined
  token_sha256        text not null,                          -- SHA-256 of the signing token (raw token never stored)
  expires_at          timestamptz not null,
  viewed_at           timestamptz,
  signed_at           timestamptz,
  signed_ip           text,
  signed_user_agent   text,
  consented           boolean not null default false,
  decline_reason      text,
  created_at          timestamptz not null default now()
);
create index if not exists esign_signers_envelope_idx on public.esign_signers (envelope_id);
create index if not exists esign_signers_tenant_idx on public.esign_signers (tenant_id);
create unique index if not exists esign_signers_token_idx on public.esign_signers (token_sha256);
alter table public.esign_signers enable row level security;
alter table public.esign_signers force row level security;
revoke all on public.esign_signers from anon, authenticated;

-- ---------------------------------------------------------------------------
-- esign_fields: field placements for a future drag-drop editor. MVP leaves
-- this mostly unused (the signature/cert page is auto-appended, not placed),
-- but the shape is here so a later field-placement UI is additive-only.
-- ---------------------------------------------------------------------------
create table if not exists public.esign_fields (
  id             uuid primary key default gen_random_uuid(),
  envelope_id    uuid not null references public.esign_envelopes(id) on delete cascade,
  signer_id      uuid not null references public.esign_signers(id) on delete cascade,
  tenant_id      uuid not null,
  type           text not null,                               -- signature|initials|date|text|checkbox
  page           int not null default 1,
  x              numeric not null default 0,
  y              numeric not null default 0,
  w              numeric not null default 0,
  h              numeric not null default 0,
  required       boolean not null default true,
  value          text,
  placeholder    text,
  created_at     timestamptz not null default now()
);
create index if not exists esign_fields_envelope_idx on public.esign_fields (envelope_id);
create index if not exists esign_fields_signer_idx on public.esign_fields (signer_id);
alter table public.esign_fields enable row level security;
alter table public.esign_fields force row level security;
revoke all on public.esign_fields from anon, authenticated;

-- ---------------------------------------------------------------------------
-- esign_events: append-only legal audit trail (view/sign/decline/void/…).
-- No UPDATE/DELETE policy is ever granted, and application code never issues
-- one — see lib/esign/db.ts logEvent(), which only INSERTs.
-- ---------------------------------------------------------------------------
create table if not exists public.esign_events (
  id            uuid primary key default gen_random_uuid(),
  envelope_id   uuid not null references public.esign_envelopes(id) on delete cascade,
  signer_id     uuid,                                          -- nullable — envelope-level events (created/sent/voided) have no signer
  tenant_id     uuid not null,
  event         text not null,                                 -- created|sent|viewed|signed|declined|completed|voided|reminded|failed
  actor         text,                                           -- "operator:<user_id>" | "signer:<signer_id>" | "system"
  at            timestamptz not null default now(),
  ip            text,
  user_agent    text,
  meta          jsonb not null default '{}'::jsonb
);
create index if not exists esign_events_envelope_idx on public.esign_events (envelope_id, at);
create index if not exists esign_events_tenant_idx on public.esign_events (tenant_id, at desc);
alter table public.esign_events enable row level security;
alter table public.esign_events force row level security;
revoke all on public.esign_events from anon, authenticated;
