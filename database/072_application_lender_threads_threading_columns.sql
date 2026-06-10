-- ============================================================================
-- Migration 072 — application_lender_threads: per-(deal, lender) Gmail
-- threading columns
--
-- Adon's shop-out spec section 3.4 (2026-06-10). Adds the two columns
-- needed to pin Gmail replies to the same conversation as the original
-- submission:
--
--   last_message_id      — RFC822 Message-Id of the most recent message
--                          we sent on this (application, lender) thread.
--                          The reply endpoint uses this as the
--                          In-Reply-To header so Gmail places the reply
--                          in the same conversation client-side.
--   message_id_history   — Full chain of every Message-Id we've sent on
--                          this thread, oldest first. Concatenated
--                          space-separated as the References header on
--                          replies (RFC2822 conversation threading).
--
-- cc_emails is intentionally left as-is — migration 044 already created
-- it as JSONB. Adon's spec says "if cc_emails already exists, leave the
-- existing definition alone" and the runtime code casts between JSONB
-- array ↔ string[] cleanly. Not worth a column-type rewrite for one
-- field shape.
--
-- gmail_thread_id is also unchanged — migration 044 already declares it
-- (text, nullable while the row is in 'pending'). The shop-out-run path
-- populates it from the Gmail API response immediately after send and
-- the reply endpoint reads it back to thread subsequent replies.
--
-- Idempotent. Re-runnable.
-- ============================================================================

ALTER TABLE public.application_lender_threads
    ADD COLUMN IF NOT EXISTS last_message_id text;

ALTER TABLE public.application_lender_threads
    ADD COLUMN IF NOT EXISTS message_id_history text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.application_lender_threads.last_message_id IS
  'RFC822 Message-Id of the most recent outbound. Adon spec 2026-06-10. '
  'Reply endpoint uses this as In-Reply-To so Gmail threads the reply.';

COMMENT ON COLUMN public.application_lender_threads.message_id_history IS
  'Full chain of Message-Ids on this thread, oldest first. Concatenated '
  'space-separated as the References header on replies. Append-only '
  'in practice (runtime code never rewrites prior entries).';
