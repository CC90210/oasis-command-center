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
 * UPDATED 2026-09-10 (CC: "It only allows me to add a lead to the research
 * section ... where the lead does not exist"). Gate 4 had a second half that
 * nobody had pinned: the stamp set an owner and a stage but never
 * `sales_motion`, and /pipeline filters on `sales_motion = cold_outbound` — so a
 * lead could be owned by its creator and still be on no board. And an ADMIN's
 * lead got no stamp at all. The stamp now lives in lib/oasis-lead-create.ts,
 * shared by both create doors, and this file asserts it behaviourally rather
 * than by matching the route's text. A rep now picks Assigned; `researched` —
 * the shared prospect pool — is refused for everyone instead of being silently
 * promoted.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OASIS_SALES_LEAD_OPERATOR_ROLES,
  REP_PIPELINE_STAGE_KEYS,
} from "../lib/oasis-sales-pipeline-policy";
import { mayWorkWebsiteSalesLifecycle } from "../lib/website-sales-workflow";
import {
  creatableOasisStages,
  oasisBoardProgramFilter,
  planOasisLeadCreate,
} from "../lib/oasis-lead-create";
import {
  OASIS_COLD_OUTBOUND_MOTION,
  OASIS_WEBSITE_SALES_PROGRAM,
} from "../lib/leads/canonical-lead-fields";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

// Upper-case on purpose: every "is this in my book" check compares a
// lowercased id, so the stamp must lowercase what the session hands it.
const REP_ID = "0B0B0B0B-0000-4000-8000-00000000000A";
const ADMIN_ID = "0B0B0B0B-0000-4000-8000-00000000000B";
const NOW = new Date("2026-09-10T12:00:00.000Z");

function planFor(
  viewer: { isAdmin: boolean; teamRole: string },
  creatorUserId: string,
  data: Record<string, unknown>,
) {
  return planOasisLeadCreate({ viewer, creatorUserId, data, now: NOW, requireRegion: true });
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
    assert.deepEqual(
      creatableOasisStages({ isAdmin: false, teamRole: role }).map((s) => s.key),
      ["assigned"],
      `${role} has no stage to create a lead in`,
    );
  }
  // ...and a role that does NOT work leads still cannot.
  assert.equal(mayWorkWebsiteSalesLifecycle("read_only"), false, "read_only gained lead creation");
  assert.deepEqual(creatableOasisStages({ isAdmin: false, teamRole: "read_only" }), []);
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

  // 2. THE PAGE. Gated on the same creatable-stage list the API enforces, so
  //    the page and the server cannot disagree about who may add a lead.
  const newPage = readFileSync("app/pipeline/new/page.tsx", "utf8");
  assert.match(newPage, /const creatable = creatableOasisStages\(viewer\)/, "page not gated on the shared rule");
  assert.match(newPage, /if \(creatable\.length === 0\) redirect\("\/pipeline"\)/);
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

  // 4. THE STAMP — handed to the shared planner with the SESSION's user id,
  //    never an id from the request body.
  assert.match(
    api,
    /planOasisLeadCreate\(\{[\s\S]*?creatorUserId: user\.id,/,
    "the records route does not stamp the creator through the shared planner",
  );
});

run("a rep's lead is theirs, in Assigned, stamped with the sales_motion the board filters on", () => {
  const plan = planFor({ isAdmin: false, teamRole: "opener" }, REP_ID, {
    name: "Found it myself",
    state: "ON",
    stage: "assigned",
  });
  assert.ok(plan.ok, "a rep's own lead in Assigned was refused");
  if (!plan.ok) return;
  assert.equal(plan.data.assigned_to, REP_ID.toLowerCase(), "the creator is not made owner");
  assert.equal(plan.data.stage, "assigned");
  assert.equal(
    plan.data.sales_motion,
    OASIS_COLD_OUTBOUND_MOTION,
    "no sales_motion stamp: /pipeline filters on it, so the lead is on no board",
  );
  assert.equal(plan.data.sales_program, OASIS_WEBSITE_SALES_PROGRAM);
  // The board's filter is the other half of the contract, on every OASIS slug.
  for (const slug of ["oasis", "oasis-ai-cc", "oasis-webdev"]) {
    assert.equal(
      oasisBoardProgramFilter(slug).salesMotion,
      plan.data.sales_motion,
      `the ${slug} board filters on a motion the stamp does not write`,
    );
  }
});

run("an admin's lead gets the same stamp — the half that was missing", () => {
  const plan = planFor({ isAdmin: true, teamRole: "owner" }, ADMIN_ID, {
    name: "CC's referral",
    state: "ON",
    stage: "founder_meeting_booked",
  });
  assert.ok(plan.ok, "an admin could not create in Founder Meeting");
  if (!plan.ok) return;
  assert.equal(plan.data.stage, "founder_meeting_booked");
  assert.equal(plan.data.assigned_to, ADMIN_ID.toLowerCase(), "an admin's lead has no owner");
  assert.equal(plan.data.sales_motion, OASIS_COLD_OUTBOUND_MOTION, "an admin's lead has no sales_motion");
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
  assert.match(api, /if \(isOasisSalesLead\) \{\s*const plan = planOasisLeadCreate\(/);
});

run("the stamp is SERVER-side, so ownership cannot be forged", () => {
  // A client that sends assigned_to — a protected lifecycle field — is refused,
  // so a rep cannot assign a lead they found to someone else.
  const forged = planFor({ isAdmin: false, teamRole: "opener" }, REP_ID, {
    name: "Forged",
    state: "ON",
    stage: "assigned",
    assigned_to: "someone-else",
  });
  assert.equal(forged.ok, false, "a client-chosen owner was accepted");
  if (forged.ok) return;
  assert.equal(forged.error, "protected_lifecycle_fields");

  // And the planner builds a server-owned copy; it never edits the body.
  const body = { name: "Clean", state: "ON", stage: "assigned" };
  const snapshot = JSON.stringify(body);
  planFor({ isAdmin: false, teamRole: "opener" }, REP_ID, body);
  assert.equal(JSON.stringify(body), snapshot, "the stamp mutates the request body");
});

run("a rep creates in Assigned only; the pool is refused, not promoted", () => {
  for (const stage of ["researched", "won", "founder_meeting_booked"]) {
    const plan = planFor({ isAdmin: false, teamRole: "closer" }, REP_ID, {
      name: "Probe",
      state: "ON",
      stage,
    });
    assert.equal(plan.ok, false, `a rep created a lead in ${stage}`);
    if (plan.ok) return;
    assert.equal(plan.error, "stage_not_creatable");
    assert.match(plan.message, /Assigned/, "the refusal must name the stage the rep can use");
  }
});

run("assigned is a rep-visible stage and researched is not", () => {
  // Why a rep's lead starts in Assigned. If this ever inverts, a rep-created
  // lead becomes invisible to its own creator again.
  assert.ok(
    (REP_PIPELINE_STAGE_KEYS as readonly string[]).includes("assigned"),
    "assigned is not on a rep's pipeline",
  );
  assert.ok(
    !(REP_PIPELINE_STAGE_KEYS as readonly string[]).includes("researched"),
    "researched became rep-visible; revisit which stages a rep may create in",
  );
});

run("admin-only powers stay admin-only", () => {
  const view = readFileSync("components/manifest/LeadPipelineView.tsx", "utf8");
  // CC: "for certain functionalities, like assigning a lead to a specific rep,
  // they won't have access." Bulk select/assign is still canManage. New from
  // application is not offered on the OASIS board at all: it filed a lead at a
  // SunBiz stage the board can never draw (2026-09-10). Narrower, not wider.
  const bulkSelect = view.match(/\(variant !== "oasis" \|\| canManage\)/g) || [];
  assert.ok(
    bulkSelect.length >= 1,
    "the admin-only controls were widened along with the create button",
  );
  assert.match(
    view,
    /\{isLeads && variant !== "oasis" && \(\s*<AutofillDropzone mode="new"/,
    "New from application is offered on the OASIS board again",
  );
});
