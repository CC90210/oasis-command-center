-- 103_application_signing.sql
-- Operator-initiated closed-loop e-signature: envelope lifecycle + immutable
-- legal audit + short-lived OTP for signer-identity binding.
--
-- Trust model (matches the public-form substrate): only the SERVICE-ROLE server
-- client touches these tables. RLS is FORCED with NO permissive policies, so the
-- anon/auth Supabase roles can never read or write them. The signing token's
-- HMAC + 3-way tenant binding is the auth boundary on the public path.

-- ---------------------------------------------------------------------------
-- application_signing_requests: one row per "send for signature" envelope.
-- ---------------------------------------------------------------------------
create table if not exists public.application_signing_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  lead_id uuid not null,
  application_id uuid,                        -- application entity backing the PDF (nullable)
  status text not null default 'sent',        -- sent|viewed|otp_sent|otp_verified|signed|expired|voided
  token_sha256 text not null,                -- SHA-256 of the signing token (raw token never stored)
  created_by uuid not null,                  -- operator auth_user_id
  sent_to_email text,
  sent_to_phone text,
  expires_at timestamptz not null,
  -- signature outcome (filled on completion)
  signed_at timestamptz,
  signed_ip text,
  signed_user_agent text,
  signer_name text,
  signed_document_id uuid,                   -- lead_documents.id of the signed PDF
  signed_document_sha256 text,               -- tamper-evidence hash of the signed PDF bytes
  consent_disclosure_version text,           -- ESIGN disclosure version the signer accepted
  otp_verified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists asr_tenant_lead_idx on public.application_signing_requests (tenant_id, lead_id);
create unique index if not exists asr_token_idx on public.application_signing_requests (token_sha256);
alter table public.application_signing_requests enable row level security;
alter table public.application_signing_requests force row level security;

-- ---------------------------------------------------------------------------
-- application_signing_events: append-only legal audit trail.
-- ---------------------------------------------------------------------------
create table if not exists public.application_signing_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.application_signing_requests(id) on delete cascade,
  tenant_id uuid not null,
  event text not null,                       -- created|sent|opened|otp_sent|otp_verified|signed|voided|failed
  at timestamptz not null default now(),
  ip text,
  user_agent text,
  meta jsonb not null default '{}'::jsonb
);
create index if not exists ase_request_idx on public.application_signing_events (request_id, at);
alter table public.application_signing_events enable row level security;
alter table public.application_signing_events force row level security;

-- ---------------------------------------------------------------------------
-- signing_otp_codes: short-lived, single-use OTP for signer-identity binding.
-- ---------------------------------------------------------------------------
create table if not exists public.signing_otp_codes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.application_signing_requests(id) on delete cascade,
  code_sha256 text not null,                 -- SHA-256 of the 6-digit code
  channel text not null,                     -- email|sms
  destination text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists otp_request_idx on public.signing_otp_codes (request_id, created_at);
alter table public.signing_otp_codes enable row level security;
alter table public.signing_otp_codes force row level security;
