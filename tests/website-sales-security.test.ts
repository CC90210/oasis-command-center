import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflowRoute = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
const commissionRoute = readFileSync("app/api/website-sales/commissions/route.ts", "utf8");
const migration = readFileSync("../../Business-Empire-Agent/database/107_website_sales_engine.sql", "utf8");

assert(workflowRoute.includes("resolveSessionContext"), "workflow route authenticates through session context");
assert(workflowRoute.includes('.eq("tenant_id", session.tenantId)') && workflowRoute.includes("p_tenant_id:session.tenantId"), "workflow reads and RPC writes are tenant-filtered");
assert(workflowRoute.includes("session.isTrueAdmin"), "founder-only mutations use the permanent admin gate");
assert(workflowRoute.includes("attribution_frozen_at") && workflowRoute.includes("existingRep"), "founder booking preserves frozen rep attribution");
assert(workflowRoute.includes("rep_stage_forbidden"), "reps cannot advance founder-owned stages");
assert(commissionRoute.includes(".eq(\"tenant_id\", session.tenantId)"), "commission reads are tenant-filtered");
assert(commissionRoute.includes("rep_user_id",), "non-admin commission reads scope to the current rep");

for (const table of ["website_deals", "website_sales_commissions", "website_onboarding"]) {
  assert(migration.includes(`alter table public.${table} enable row level security`), `${table} enables RLS`);
  assert(migration.includes(`alter table public.${table} force row level security`), `${table} forces RLS`);
}
assert(migration.includes("unique (tenant_id, payment_reference, entry_type)"), "commission accrual is idempotent per payment and entry type");
assert(migration.includes("status in ('accrued','approved','paid','offset','voided')"), "commission statuses are constrained");
assert(migration.includes("auth.role() is distinct from 'service_role'"), "close RPC rejects direct anon/authenticated execution");
assert(migration.includes("v_deal.rep_user_id,p_payment_reference"), "commission uses the deal's frozen rep attribution");
assert(!migration.match(/on conflict \(tenant_id,lead_id\).*rep_user_id=excluded\.rep_user_id/), "re-closing cannot rewrite the rep frozen at founder booking");
assert(migration.includes("website_sales_commissions.deal_id = excluded.deal_id") && migration.includes("payment_reference_already_used_by_another_deal"), "a reused payment reference cannot attach another deal's commission");
assert(migration.includes("founder_not_authorized_for_tenant") && migration.includes("rep_not_agent_for_tenant") && migration.includes("rep_does_not_match_frozen_attribution"), "close validates tenant membership, founder authority, and frozen rep attribution inside the RPC");
assert(migration.includes("deal_already_closed_mismatch"), "re-close cannot rewrite won economics or create a second accrual");
assert(migration.includes("foreign key (tenant_id, deal_id) references public.website_deals(tenant_id, id)"), "financial and onboarding child rows enforce same-tenant deal parentage");

console.log("website-sales-security ok");
