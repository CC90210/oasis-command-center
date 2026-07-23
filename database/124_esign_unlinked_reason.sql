-- 124_esign_unlinked_reason.sql — flag esign_envelopes explicitly when an
-- envelope has neither a lead_id nor an application_id at completion, instead
-- of leaving both silently null.
--
-- Bug this fixes (B2, 2026-07-23): a completed envelope with lead_id=NULL AND
-- application_id=NULL is legitimate in some flows (e.g. a standalone
-- agreement not tied to a SunBiz lead/application) but was indistinguishable
-- from a linking bug that silently dropped the association — nothing
-- recorded WHY the link is missing. unlinked_reason makes that state
-- explicit and auditable (app/api/sign/[token]/route.ts sets it on
-- completion when both FKs are null).
--
-- Additive + idempotent. RLS/force-RLS is inherited from 112_esign.sql
-- (unchanged — this only adds a column, no new grants).
--
-- NOTE: this migration is schema-only. It does NOT backfill existing rows —
-- see database/backfill_b2717cbf.sql for the documented, CC-reviewed,
-- idempotent backfill for the one known affected envelope
-- (b2717cbf-1030-440c-ac33-879d580fa7df).

alter table public.esign_envelopes
  add column if not exists unlinked_reason text;

comment on column public.esign_envelopes.unlinked_reason is
  'Set (non-null) by app/api/sign/[token]/route.ts whenever lead_id AND application_id are both null at completion time — records WHY the envelope has no SunBiz link (e.g. "standalone_document_no_lead_or_application") instead of leaving the gap silent/ambiguous. NULL means no reason was recorded — it is NOT proof the envelope is linked or incomplete: this migration deliberately does not backfill existing rows (see database/backfill_b2717cbf.sql), so a completed, genuinely-unlinked envelope from before this fix shipped can still read NULL here.';
