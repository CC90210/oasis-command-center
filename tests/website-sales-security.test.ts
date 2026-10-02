import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const workflowRoute = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
const migration = readFileSync("database/146_website_sales_engine.sql", "utf8");

/**
 * Every `.from(table)` query chain in `file`, and whether that chain itself
 * carries `.eq("tenant_id", ...)`. A substring anywhere in the file stayed
 * green after one query lost its tenant filter (review, 2026-10-02), so each
 * chain is walked on its own.
 */
function queryChains(file: string): Array<{ table: string; line: number; tenantScoped: boolean }> {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const chains: Array<{ table: string; line: number; tenantScoped: boolean }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "from" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      let tenantScoped = false;
      let link: ts.Node = node;
      while (ts.isPropertyAccessExpression(link.parent) && ts.isCallExpression(link.parent.parent)) {
        const call = link.parent.parent;
        const first = call.arguments[0];
        if (link.parent.name.text === "eq" && first && ts.isStringLiteral(first) && first.text === "tenant_id") tenantScoped = true;
        link = call;
      }
      chains.push({
        table: node.arguments[0].text,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        tenantScoped,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return chains;
}

assert(workflowRoute.includes("resolveSessionContext"), "workflow route authenticates through session context");
assert(workflowRoute.includes('.eq("tenant_id", session.tenantId)') && workflowRoute.includes("p_tenant_id:session.tenantId"), "workflow reads and RPC writes are tenant-filtered");
assert(workflowRoute.includes("session.isTrueAdmin"), "founder-only mutations use the permanent admin gate");
assert(workflowRoute.includes("attribution_frozen_at") && workflowRoute.includes("existingRep"), "founder booking preserves frozen rep attribution");
assert(workflowRoute.includes("rep_stage_forbidden"), "reps cannot advance founder-owned stages");
// Commission reads (the Commissions page and its route share one loader since
// 2026-10-02): every query names the tenant. tests/commissions-portal.test.ts
// proves the same with another tenant's rows, and the rep and manager
// boundaries with real rows.
for (const [file, atLeast] of [
  ["lib/website-sales-commission-portal.ts", 4], // deals, profiles, leads, receipts
  ["lib/website-sales-commission-summary.ts", 2], // the ledger, and the Today pages' deal currencies
] as const) {
  const chains = queryChains(file);
  assert(chains.length >= atLeast, `${file}: found ${chains.length} queries, expected at least ${atLeast}`);
  const unscoped = chains.filter((chain) => !chain.tenantScoped).map((chain) => `${chain.table} (line ${chain.line})`);
  assert.deepEqual(unscoped, [], `${file}: a commission query without .eq("tenant_id", ...): ${unscoped.join(", ")}`);
}

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
assert(migration.includes("website_sales_interaction_request_uidx") && migration.includes("metadata->>'request_id'"), "rep lifecycle writes are idempotent by tenant and request ID");

console.log("website-sales-security ok");
