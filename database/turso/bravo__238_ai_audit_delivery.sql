-- 238 - Free AI Audit: the client's private link, Stripe checkouts and
-- verified payment receipts (2026-10-25).
--
-- ai_audit_share_links       the private page a client opens from the email.
--                            Only the token's sha256 is stored; the token is
--                            minted by the approved delivery and never kept.
--                            One live (unrevoked) link per engagement, one per
--                            approval. view_count and first_viewed_at come
--                            from the page's own visibility signal, never from
--                            a GET (mail scanners open links).
-- ai_audit_checkouts         one Stripe Checkout Session per proposal version
--                            and installment while it is creating or open, so
--                            a double click cannot make two payment requests.
--                            Opening a checkout is not a payment.
-- ai_audit_payment_receipts  a payment that Stripe itself confirmed
--                            (lib/website-sales-payment.ts
--                            verifyStripeWebsitePayment re-reads the session).
--                            One receipt per Stripe session. Kept apart from
--                            website_sales_payment_receipts on purpose: the
--                            website commission ledger, its reconciler and
--                            close_website_deal never see an audit payment.
--
-- Additive only. Same conventions as bravo__237.

CREATE TABLE IF NOT EXISTS ai_audit_share_links (
  id                  text not null primary key,
  tenant_id           text not null,
  engagement_id       text not null,
  audit_version_id    text not null,
  proposal_version_id text not null,
  approval_id         text not null,
  token_sha256        text not null,
  created_at          text not null,
  expires_at          text not null,
  revoked_at          text,
  revoked_reason      text,
  first_viewed_at     text,
  last_viewed_at      text,
  view_count          integer not null default 0
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_share_links_token_idx
  ON ai_audit_share_links (token_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_share_links_approval_idx
  ON ai_audit_share_links (tenant_id, approval_id);
CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_share_links_one_live_idx
  ON ai_audit_share_links (tenant_id, engagement_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS ai_audit_checkouts (
  id                  text not null primary key,
  tenant_id           text not null,
  engagement_id       text not null,
  proposal_version_id text not null,
  payment_token       text not null,
  installment_kind    text not null,
  amount_cents        integer not null check (amount_cents > 0),
  currency            text not null,
  stripe_session_id   text,
  checkout_url        text,
  status              text not null default 'creating',
  created_at          text not null,
  updated_at          text not null,
  expires_at          text,
  paid_at             text,
  last_checked_at     text,
  check_attempts      integer not null default 0,
  last_error          text
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_checkouts_token_idx
  ON ai_audit_checkouts (payment_token);
CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_checkouts_session_idx
  ON ai_audit_checkouts (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_checkouts_one_open_idx
  ON ai_audit_checkouts (tenant_id, proposal_version_id, installment_kind)
  WHERE status IN ('creating', 'open');
CREATE INDEX IF NOT EXISTS ai_audit_checkouts_engagement_idx
  ON ai_audit_checkouts (tenant_id, engagement_id, status);

CREATE TABLE IF NOT EXISTS ai_audit_payment_receipts (
  id                        text not null primary key,
  tenant_id                 text not null,
  engagement_id             text not null,
  lead_id                   text not null,
  proposal_version_id       text not null,
  checkout_id               text not null,
  provider                  text not null,
  provider_reference        text not null,
  status                    text not null,
  amount_cents              integer not null check (amount_cents > 0),
  currency                  text not null,
  installment_kind          text not null,
  provider_status           text,
  verification_source       text not null,
  verified_at               text not null,
  summary                   text not null default '{}',
  last_reconciled_at        text,
  reconciliation_attempts   integer not null default 0,
  last_reconciliation_error text,
  created_at                text not null,
  updated_at                text not null
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_audit_receipts_reference_idx
  ON ai_audit_payment_receipts (tenant_id, provider, provider_reference);
CREATE INDEX IF NOT EXISTS ai_audit_receipts_engagement_idx
  ON ai_audit_payment_receipts (tenant_id, engagement_id, verified_at);
