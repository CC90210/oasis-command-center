/**
 * rep-creates-own-lead.test.ts — a rep can add a lead they sourced, and it is
 * theirs.
 *
 * THE DEFECT (CC, 2026-09-08): "reps can add their own leads ... they need to
 * also be assigned to that specific rep that created it." They could not. FOUR
 * separate gates stood in the way, and opening any three of them still leaves a
 * broken feature — a visible button that 403s, or a lead that saves into a pool
 * the creator cannot see:
 *
 *   1. the "New lead" BUTTON rendered only for `canManage` (admin)
 *   2. /pipeline/new REDIRECTED anyone who was not an admin
 *   3. POST /api/manifest/<slug>/records/lead answered 403 to non-admins
 *   4. nothing stamped an owner, so a created lead landed unassigned
 *
 * And 4 has a second half that is easy to miss: `researched` IS the shared
 * prospect pool and REP_PIPELINE_STAGE_KEYS deliberately excludes it, so a lead
 * stamped with an owner but left in `researched` belongs to the rep and is
 * invisible on their pipeline. Owner and stage have to move together.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OASIS_SALES_LEAD_OPERATOR_ROLES,
  REP_PIPELINE_STAGE_KEYS,
} from "../lib/oasis-sales-pipeline-policy";
import { mayWorkWebsiteSalesLifecycle } from "../lib/website-sales-workflow";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("rep-creates-own-lead:");

run("every sales role CC named may create a lead", () => {
  // "openers, closers, and sales managers" — plus the other roles that work
  // this pipeline. A role missing here cannot add a lead at all.
  for (const role of ["opener", "closer", "manager", "builder", "marketing", "agent"]) {
    assert.ok(
      mayWorkWebsiteSalesLifecycle(role),
      `${role} cannot create a lead, but works this pipeline`,
    );
    assert.ok(OASIS_SALES_LEAD_OPERATOR_ROLES.has(role), `${role} missing from the operator roles`);
  }
  // ...and a role that does NOT work leads still cannot.
  assert.equal(mayWorkWebsiteSalesLifecycle("read_only"), false, "read_only gained lead creation");
});

run("all four gates are open, not three", () => {
  // 1. THE BUTTON. Gated on canCreateLead, not canManage — reusing canManage is
  //    what hid it from every rep.
  const view = readFileSync("components/manifest/LeadPipelineView.tsx", "utf8");
  assert.match(view, /canCreateLead\?: boolean/, "no separate create permission exists");
  assert.match(
    view,
    /\(canCreateLead \?\? canManage\)\) && <Link\s*\n?\s*href=\{newHref\}/,
    "the New lead button is not gated on canCreateLead",
  );

  // 2. THE PAGE.
  const newPage = readFileSync("app/pipeline/new/page.tsx", "utf8");
  assert.match(newPage, /mayWorkWebsiteSalesLifecycle\(session\.teamRole\)/, "page still admin-only");
  assert.ok(
    !/if \(!session\.ok \|\| !session\.isAdmin\) redirect/.test(newPage),
    "the admin-only redirect is still in place",
  );

  // 3. THE API.
  const api = readFileSync("app/api/manifest/[slug]/records/[entity]/route.ts", "utf8");
  assert.match(api, /const repMayCreateOwnLead =/, "the API has no rep-create path");
  assert.match(
    api,
    /if \(!r\.is_admin && !repMayCreateOwnLead\)/,
    "the API still rejects every non-admin create",
  );

  // 4. THE STAMP.
  assert.match(api, /data\.assigned_to = user\.id\.toLowerCase\(\)/, "the creator is not made owner");
  assert.match(api, /data\.stage = "assigned"/, "the lead stays in the shared pool");
});

run("the widened API stays narrow: OASIS leads only", () => {
  const api = readFileSync("app/api/manifest/[slug]/records/[entity]/route.ts", "utf8");
  // This is the GENERIC record endpoint. Widening it without scoping would let
  // any member create any record type in any workspace.
  assert.match(
    api,
    /repMayCreateOwnLead = isOasisSalesLead && mayWorkWebsiteSalesLifecycle/,
    "rep creation is not scoped to OASIS leads",
  );
});

run("the stamp is SERVER-side, so ownership cannot be forged", () => {
  const api = readFileSync("app/api/manifest/[slug]/records/[entity]/route.ts", "utf8");
  // assigned_to is a protected lifecycle field and the create guard rejects a
  // client that sends one, so a rep cannot assign a lead they found to someone
  // else. The server is the only thing that may set it.
  assert.match(api, /rejectedOasisGenericPatchKeys\(body\.data\)/, "the protected-field guard is gone");
  assert.match(
    api,
    /const data = \{ \.\.\.body\.data \};/,
    "the stamp mutates the request body instead of a server-owned copy",
  );
});

run("assigned is a rep-visible stage and researched is not", () => {
  // The reason owner and stage must move together. If this ever inverts, a
  // rep-created lead becomes invisible to its own creator again.
  assert.ok(
    (REP_PIPELINE_STAGE_KEYS as readonly string[]).includes("assigned"),
    "assigned is not on a rep's pipeline",
  );
  assert.ok(
    !(REP_PIPELINE_STAGE_KEYS as readonly string[]).includes("researched"),
    "researched became rep-visible; the stage promotion on create may now be unnecessary",
  );
});

run("admin-only powers stay admin-only", () => {
  const view = readFileSync("components/manifest/LeadPipelineView.tsx", "utf8");
  // CC: "for certain functionalities, like assigning a lead to a specific rep,
  // they won't have access." Bulk select/assign and new-from-application are
  // still canManage.
  const selectAndAutofill = view.match(/\(variant !== "oasis" \|\| canManage\)/g) || [];
  assert.ok(
    selectAndAutofill.length >= 2,
    "the admin-only controls were widened along with the create button",
  );
});
