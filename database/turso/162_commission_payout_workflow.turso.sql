-- 162 - guarded founder commission approval and payout workflow.
--
-- Turso is the only data plane for the OASIS sales engine. These fields make
-- the founder's payout decision reconstructible from the commission row itself
-- instead of hiding the transfer reference or void reason in browser state.

ALTER TABLE "website_sales_commissions" ADD COLUMN "paid_by" TEXT;
ALTER TABLE "website_sales_commissions" ADD COLUMN "payout_reference" TEXT;
ALTER TABLE "website_sales_commissions" ADD COLUMN "voided_by" TEXT;
ALTER TABLE "website_sales_commissions" ADD COLUMN "voided_at" TEXT;
ALTER TABLE "website_sales_commissions" ADD COLUMN "void_reason" TEXT;

-- A retried PATCH resolves from its durable audit receipt before looking at the
-- now-changed status. The partial unique index keeps that receipt one-per-request
-- without changing the idempotency namespace used by pipeline stage actions.
CREATE UNIQUE INDEX IF NOT EXISTS "website_sales_commission_request_uidx"
  ON "tenant_audit_log" ("tenant_id", json_extract("metadata", '$.request_id'))
  WHERE "action_type" LIKE 'website_sales.commission.%'
    AND json_extract("metadata", '$.request_id') IS NOT NULL;

-- The RPC is the normal writer, while these triggers are the last line of
-- defence against a future route accidentally restoring direct status patches.
-- Refund reconciliation legitimately moves an unpaid accrual to offset.
CREATE TRIGGER IF NOT EXISTS "website_commission_status_transition_guard"
BEFORE UPDATE OF "status" ON "website_sales_commissions"
WHEN NEW."status" <> OLD."status"
 AND NOT (
   (OLD."status" = 'accrued' AND NEW."status" IN ('approved','voided','offset'))
   OR (OLD."status" = 'approved' AND NEW."status" IN ('paid','voided','offset'))
 )
BEGIN
  SELECT RAISE(ABORT, 'invalid_commission_status_transition');
END;

CREATE TRIGGER IF NOT EXISTS "website_commission_status_evidence_guard"
BEFORE UPDATE OF "status" ON "website_sales_commissions"
WHEN NEW."status" <> OLD."status"
 AND (
   (NEW."status" = 'approved' AND (NEW."approved_by" IS NULL OR NEW."approved_at" IS NULL))
   OR (NEW."status" = 'paid' AND (
     NEW."approved_by" IS NULL OR NEW."approved_at" IS NULL
     OR NEW."paid_by" IS NULL OR NEW."paid_at" IS NULL
     OR NEW."payout_reference" IS NULL OR length(trim(NEW."payout_reference")) < 3
   ))
   OR (NEW."status" = 'voided' AND (
     NEW."voided_by" IS NULL OR NEW."voided_at" IS NULL
     OR NEW."void_reason" IS NULL OR length(trim(NEW."void_reason")) < 8
   ))
 )
BEGIN
  SELECT RAISE(ABORT, 'commission_status_evidence_required');
END;

CREATE TRIGGER IF NOT EXISTS "website_commission_terminal_evidence_immutable"
BEFORE UPDATE OF "status", "approved_by", "approved_at", "paid_by", "paid_at",
  "payout_reference", "voided_by", "voided_at", "void_reason"
ON "website_sales_commissions"
WHEN OLD."status" IN ('paid','voided','offset')
 AND (
   NEW."status" IS NOT OLD."status"
   OR NEW."approved_by" IS NOT OLD."approved_by"
   OR NEW."approved_at" IS NOT OLD."approved_at"
   OR NEW."paid_by" IS NOT OLD."paid_by"
   OR NEW."paid_at" IS NOT OLD."paid_at"
   OR NEW."payout_reference" IS NOT OLD."payout_reference"
   OR NEW."voided_by" IS NOT OLD."voided_by"
   OR NEW."voided_at" IS NOT OLD."voided_at"
   OR NEW."void_reason" IS NOT OLD."void_reason"
 )
BEGIN
  SELECT RAISE(ABORT, 'terminal_commission_entry_immutable');
END;
