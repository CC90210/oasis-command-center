-- 164 - one quoted website sale may be collected across multiple receipts.
--
-- The stable payment_plan_id is deliberately separate from a Stripe Checkout
-- Session. A deposit and its balance are two provider objects, but one sale,
-- one fulfillment decision, and one commission calculation. Existing one-shot
-- receipts are backfilled as one-receipt plans so historical payout and refund
-- behavior stays unchanged.

ALTER TABLE "website_sales_payment_receipts" ADD COLUMN "payment_plan_id" TEXT;
ALTER TABLE "website_sales_payment_receipts" ADD COLUMN "payment_token" TEXT;
ALTER TABLE "website_sales_payment_receipts" ADD COLUMN "installment_kind" TEXT
  CHECK ("installment_kind" IS NULL OR "installment_kind" IN ('deposit','balance','full'));

UPDATE "website_sales_payment_receipts"
   SET "payment_plan_id" = "id",
       "installment_kind" = 'full'
 WHERE "payment_plan_id" IS NULL;

CREATE INDEX IF NOT EXISTS "website_sales_receipts_plan_idx"
  ON "website_sales_payment_receipts"
     ("tenant_id", "lead_id", "payment_plan_id", "status", "verified_at");

ALTER TABLE "website_deals" ADD COLUMN "payment_plan_id" TEXT;

UPDATE "website_deals"
   SET "payment_plan_id" = "verified_payment_id"
 WHERE "payment_plan_id" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "website_deals_payment_plan_idx"
  ON "website_deals" ("tenant_id", "payment_plan_id")
  WHERE "payment_plan_id" IS NOT NULL;

ALTER TABLE "website_sales_commissions" ADD COLUMN "payment_plan_id" TEXT;

UPDATE "website_sales_commissions"
   SET "payment_plan_id" = (
     SELECT d."payment_plan_id"
       FROM "website_deals" d
      WHERE d."tenant_id" = "website_sales_commissions"."tenant_id"
        AND d."id" = "website_sales_commissions"."deal_id"
      LIMIT 1
   )
 WHERE "payment_plan_id" IS NULL;

CREATE INDEX IF NOT EXISTS "website_commissions_payment_plan_idx"
  ON "website_sales_commissions"
     ("tenant_id", "payment_plan_id", "entry_type", "party_role");
