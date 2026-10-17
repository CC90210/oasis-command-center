/**
 * tests/pipeline-delete-lead-ui.test.ts - the owner's Delete lead surfaces and
 * the safety rules around them (CC, 2026-10-16: junk and test leads must be
 * removable). The server behaviour is proven on a real database by
 * tests/pipeline-delete-lead.test.ts; this pins who sees the controls, that a
 * delete always shows its dry run first and needs DELETE typed, and that the
 * blocker checks on live money and booking tables fail closed.
 *
 * Run: node --conditions=react-server --import tsx tests/pipeline-delete-lead-ui.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
// LF, whatever the checkout: the patterns below span lines, and a Windows
// checkout (core.autocrlf=true) hands back CRLF.
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).message).split("\n").slice(0, 5).join("\n        ")}`);
  }
}

console.log("pipeline delete lead (ui)");

check("the lead page draws Delete lead for an owner by base role only", () => {
  const page = read("app/pipeline/[id]/page.tsx");
  assert.match(page, /\{session\.ok && session\.isTrueAdmin \? \(\s*<DeleteLeadButton/, "the card is not gated on isTrueAdmin");
  assert.doesNotMatch(page, /isAdmin \? \(\s*<DeleteLeadButton/, "the admin_access grant would see Delete");
});

check("the pipeline's bulk Delete is an owner's control, for leads only", () => {
  const list = read("app/pipeline/page.tsx");
  assert.match(list, /canDelete=\{session\.ok && session\.isTrueAdmin\}/);
  const view = read("components/manifest/LeadPipelineView.tsx");
  assert.match(view, /onDelete=\{canDelete && entityName === "lead" \? runBulkDelete : undefined\}/);
  assert.match(view, /canDelete = false,/, "a caller that does not pass canDelete gains the control");
});

check("bulk Delete asks for the exact count before it sends", () => {
  const view = read("components/manifest/LeadPipelineView.tsx");
  assert.match(view, /onClick=\{\(\) => setConfirmDelete\(true\)\}/, "the first press deletes instead of asking");
  assert.match(view, /setConfirmDelete\(false\);\s*onDelete\(\);/, "the confirm does not run the delete");
  assert.match(view, /op: "delete", confirm: "delete"/);
});

check("Delete lead always shows the dry run, and needs DELETE typed", () => {
  const btn = read("app/pipeline/[id]/DeleteLeadButton.tsx");
  assert.match(btn, /onClick=\{review\}/, "the first button does not run the dry run");
  assert.match(btn, /call\(\{ dry_run: true \}\)/);
  assert.match(btn, /if \(typed\.trim\(\)\.toUpperCase\(\) !== "DELETE"\) return;/, "remove() runs without DELETE typed");
  assert.match(btn, /disabled=\{busy \|\| typed\.trim\(\)\.toUpperCase\(\) !== "DELETE"\}/, "the button is live before DELETE is typed");
  assert.match(btn, /call\(\{ confirm: "delete" \}\)/);
});

check("the route and bulk op refuse anyone but an owner, and need the confirm word", () => {
  const route = read("app/api/pipeline/[id]/delete/route.ts");
  assert.match(route, /if \(!session\.ok \|\| !session\.isTrueAdmin\)/);
  assert.match(route, /if \(!sameOrigin\(req\)\)/);
  assert.match(route, /!dryRun && body\.confirm !== "delete"/);
  const bulk = read("app/api/leads/bulk/route.ts");
  const deleteBlock = bulk.slice(bulk.indexOf('if (op === "delete") {'), bulk.indexOf('if (op === "delete") {') + 1500);
  assert.ok(deleteBlock.length > 100, "the bulk route has no delete guard block");
  assert.match(deleteBlock, /!sameOrigin\(req\)/, "bulk delete accepts a cross-origin request (Codex on #669)");
  assert.match(deleteBlock, /startsWith\("application\/json"\)/, "bulk delete accepts a text/plain body");
  assert.match(deleteBlock, /if \(!sess\.isTrueAdmin\)/);
  assert.match(deleteBlock, /if \(body\.confirm !== "delete"\)/);
  assert.match(deleteBlock, /rateLimit\(pipelineDeleteRateLimit\(sess\.userId\)\)/, "bulk delete is not rate-limited with the single delete");
  assert.match(route, /rateLimit\(pipelineDeleteRateLimit\(session\.userId\)\)/, "the single delete has its own bucket");
  assert.match(bulk, /const MAX_DELETE_IDS = 15;/);
});

check("a blocker on live money or booking data fails closed; only a missing TABLE is optional", () => {
  const lib = read("lib/pipeline/delete-lead.ts");
  assert.match(lib, /if \(missingTable\(result\.error\)\) return null;\s*throw new Unavailable/, "a missing column reads as zero rows");
  for (const table of ["website_deals", "website_onboarding", "website_sales_payment_receipts"]) {
    assert.match(lib, new RegExp(`"${table}", "(?:id", ")?lead_id", tenantId, leadId, true\\)`), `${table} is not a strict check`);
  }
  for (const live of ['db.from("call_appointments")', 'db.from("lead_documents")', 'db.from("approvals").select("id").eq("tenant_id", tenantId)\n      .in("status"']) {
    const at = lib.indexOf(live);
    assert.ok(at > 0, `missing ${live}`);
    assert.match(lib.slice(Math.max(0, at - 80), at), /required</, `${live} is read through optional()`);
  }
  assert.match(lib, /countLink\(db, table, column, tenantId, leadId, true\)\) blockers\.push\(message\)/, "customers/delivery/automation are not strict");
});

check("the parent delete is one guarded statement, and in-flight sends block (Codex on #669)", () => {
  const lib = read("lib/pipeline/delete-lead.ts");
  for (const table of ["website_deals", "website_onboarding", "website_sales_payment_receipts", "call_appointments", "customers"]) {
    assert.match(lib, new RegExp(`\\["${table}", "[^"]+", true\\]`), `${table} is not a live guard of the parent delete`);
  }
  assert.match(lib, /"DELETE FROM tenant_records WHERE tenant_id = \? AND id = \? AND entity_type = 'lead'" \+\s*used\.map\(/);
  assert.match(lib, /if \(!\(await guardedDeleteLead\(input\.tenantId, input\.leadId\)\)\)/, "the parent row is deleted without the guard");
  assert.match(lib, /countStatus\(db, "drip_runs", tenantId, leadId, \["sending"\]\)/, "a drip in flight does not block");
  // Dependents go only after the lead row did (no data loss when the guard refuses).
  const body = lib.slice(lib.indexOf("export async function deletePipelineLead("));
  assert.ok(body.indexOf("guardedDeleteLead(input.tenantId") < body.indexOf("await removeDependents(db, input.tenantId, input.leadId);\n    const plan"),
    "form data is removed before the guarded delete");
});

check("the generic manifest DELETE can no longer hard-delete an OASIS lead", () => {
  const manifest = read("app/api/manifest/[slug]/records/[entity]/route.ts");
  assert.match(manifest, /entity\.toLowerCase\(\) === "lead" && isOasisInternalTenant\(r\.tenant_id\)/);
  assert.match(manifest, /use_pipeline_delete/);
});

if (failures) {
  console.log(`pipeline-delete-lead-ui: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("pipeline-delete-lead-ui: all passed");
