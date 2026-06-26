-- 104_document_extraction_jobs.sql
-- Async queue for document EXTRACTION (read a dropped/created application →
-- field JSON). The dashboard no longer calls the Anthropic vision API inline;
-- it files the doc + inserts a job here. A VPS daemon (extraction_consumer.py,
-- PM2) runs the Claude Code CLI on CC's SUBSCRIPTION (OAuth, not the metered
-- API) to extract the fields + signature box, then POSTs the result back (HMAC)
-- to /api/internal/apply-extraction, which applies them + regenerates the PDF.
-- The Anthropic API is a break-glass fallback only (subscription cap).
--
-- Trust model (matches the signing substrate, 103): only the SERVICE-ROLE
-- server client touches this table — both the dashboard routes and the VPS
-- daemon use the service role. RLS is FORCED with NO permissive policies, so
-- anon/auth Supabase roles can never read or write it.

create table if not exists public.document_extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  lead_id uuid,                          -- null for new_from_document (lead created on apply)
  application_id uuid,                   -- filled by the apply callback
  lead_document_id uuid,                 -- the filed original doc (lead_documents.id)
  storage_path text not null,            -- lead-documents bucket path the daemon downloads
  mime_type text not null,               -- application/pdf | image/*
  source text not null,                  -- autofill | new_from_document
  assigned_to uuid,                      -- carry the lead owner so a new-deal apply assigns correctly
  uploaded_by text,                      -- operator email/id for audit
  status text not null default 'queued', -- queued|processing|extracted|applied|failed
  attempts int not null default 0,       -- bumped each daemon pickup; capped so a poison row can't loop
  used_fallback boolean not null default false, -- true if the API fallback ran (subscription was capped)
  result_json jsonb,                     -- {applied_keys, application_id, signature_preview, signature_box, ...}
  error text,                            -- last failure reason (operator-facing on permanent failure)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Daemon poll: oldest queued first. Partial index keeps it tiny (most rows are terminal).
create index if not exists dej_status_idx
  on public.document_extraction_jobs (status, created_at)
  where status in ('queued', 'processing');
create index if not exists dej_tenant_lead_idx
  on public.document_extraction_jobs (tenant_id, lead_id);

alter table public.document_extraction_jobs enable row level security;
alter table public.document_extraction_jobs force row level security;
