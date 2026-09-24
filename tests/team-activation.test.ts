/**
 * tests/team-activation.test.ts — deactivating a teammate (2026-09-24).
 *
 * CC retired the OASIS sales team and asked for reps to be DEACTIVATED, not
 * deleted: gone from every live list, unable to sign in, history intact, and
 * reactivatable from Settings. These assertions execute the rules that make
 * that true and pin the wiring that keeps every surface on the same roster.
 *
 * Run: node --conditions=react-server --import tsx tests/team-activation.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BOARD_ON_DEACTIVATION,
  DEACTIVATION_BAN_UNTIL,
  POOL_ON_DEACTIVATION,
  boardUnassignPatch,
  dispositionForStage,
  planLeadDisposition,
} from "../lib/team-activation-rules";
import { CURRENT_OASIS_PIPELINE_CYCLE, isInPipelineCycle } from "../lib/pipeline-cycle";
import { OASIS_LEAD_STAGE_KEYS } from "../lib/oasis-stage-meta";
import { canonicalizeTenantMembers, isActiveMember, type MemberRow } from "../lib/team";

// ── 1. Every lifecycle stage has exactly one disposition ─────────────────────
{
  // CC's choice, 2026-09-24: warm conversations stay on the board, early work
  // returns to the pool, closed/delivery records keep their owner.
  const expected: Record<string, string> = {
    researched: "pool",
    assigned: "pool",
    attempting_contact: "pool",
    connected: "board",
    qualified: "board",
    founder_meeting_booked: "board",
    demo_completed: "board",
    proposal_sent: "board",
    won: "keep",
    lost: "keep",
    onboarding: "keep",
    in_build: "keep",
    client_review: "keep",
    launched: "keep",
  };
  for (const stage of OASIS_LEAD_STAGE_KEYS) {
    assert.ok(stage in expected, `stage ${stage} was added without deciding its deactivation disposition`);
    assert.equal(dispositionForStage(stage), expected[stage], `disposition for ${stage}`);
  }
  assert.equal(dispositionForStage(undefined), "pool", "a stageless legacy lead is prospect inventory");
  assert.equal(dispositionForStage(" Qualified "), "board", "stage keys are normalised");
  for (const key of POOL_ON_DEACTIVATION) assert.equal(BOARD_ON_DEACTIVATION.has(key), false);
}

// ── 2. The plan partitions without losing or duplicating a lead ──────────────
{
  const plan = planLeadDisposition([
    { id: "a", data: { stage: "assigned" } },
    { id: "b", data: { stage: "connected" } },
    { id: "c", data: { stage: "won" } },
    { id: "d", data: null },
    { id: "e", data: { stage: "founder_meeting_booked" } },
  ]);
  assert.deepEqual(plan, { pool: ["a", "d"], board: ["b", "e"], keep: ["c"] });
}

// ── 3. A warm lead left on the board stays VISIBLE on the board ─────────────
{
  // The board shows only rows inside the current revenue cycle. A lead assigned
  // before the boundary would vanish the moment its owner is cleared unless the
  // patch stamps the cycle explicitly.
  const before = {
    stage: "qualified",
    assigned_to: "rep-1",
    assigned_at: "2026-08-01T00:00:00.000Z",
    collaborators: ["rep-2"],
  };
  assert.equal(isInPipelineCycle({ data: before }), false, "precondition: an old assignment is outside the cycle");
  const patched = {
    ...before,
    ...boardUnassignPatch({
      previousOwner: "rep-1",
      nowIso: "2026-09-24T12:00:00.000Z",
      cycleId: CURRENT_OASIS_PIPELINE_CYCLE.id,
    }),
  };
  assert.equal(patched.assigned_to, null);
  assert.deepEqual(patched.collaborators, [], "the retired rep's collaborator grants go with them");
  assert.equal(patched.unassigned_from, "rep-1", "who held it is recorded, not lost");
  assert.equal(isInPipelineCycle({ data: patched }), true, "the unassigned warm lead must stay on the board");
}

// ── 4. Active filtering happens AFTER canonicalization ───────────────────────
{
  const row = (over: Partial<MemberRow>): MemberRow => ({
    id: "x",
    auth_user_id: "u1",
    email: "rep@oasisai.work",
    full_name: "Rep",
    display_name: null,
    team_role: "opener",
    is_owner: false,
    admin_access: false,
    invited_by: null,
    joined_at: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  assert.equal(isActiveMember(row({})), true);
  assert.equal(isActiveMember(row({ deactivated_at: "2026-09-24T00:00:00.000Z" })), false);
  const members = canonicalizeTenantMembers([
    row({ id: "a", auth_user_id: "u1" }),
    row({ id: "b", auth_user_id: "u2", email: "gone@oasisai.work", deactivated_at: "2026-09-24T00:00:00.000Z" }),
  ]).filter(isActiveMember);
  assert.deepEqual(members.map((m) => m.id), ["a"]);
}

// ── 5. Wiring: every live roster excludes inactive people ────────────────────
{
  const team = readFileSync("lib/team.ts", "utf8");
  const assignmentRoster = team.slice(team.indexOf("export async function getOasisPipelineAssignmentRoster"));
  assert.match(assignmentRoster, /isActiveMember\(member\)/, "assign menus + server checks must drop inactive people");
  assert.match(
    team.slice(team.indexOf("export async function getOasisSalesRepRoster")),
    /isActiveMember\(member\)/,
    "the sales roster (chips, scorecard, commissions, manager scope) must drop inactive people",
  );
  assert.match(
    team.slice(team.indexOf("export async function getTenantMembers")),
    /options\.includeInactive \? members : members\.filter\(isActiveMember\)/,
    "getTenantMembers defaults to active-only",
  );

  const pipeline = readFileSync("app/pipeline/page.tsx", "utf8");
  assert.match(pipeline, /activeMemberIds\.has\(id\)/, "board rep chips must come from ACTIVE members only");

  const google = readFileSync("app/api/auth/google/callback/route.ts", "utf8");
  assert.equal((google.match(/banned_until/g) || []).length >= 2, true, "Google sign-in must refuse banned accounts");

  const activation = readFileSync("lib/team-activation.ts", "utf8");
  assert.match(activation, /session_version = session_version \+ 1/, "deactivation must kill open sessions");
  assert.match(activation, /banned_until = \?/, "deactivation must block sign-in");
  assert.match(activation, /WHERE id = \? AND banned_until = \?/, "reactivation lifts only our own ban");
  assert.match(activation, /activeElsewhere/, "a login still active in another workspace is not banned");
  assert.equal(DEACTIVATION_BAN_UNTIL.startsWith("9999-"), true);
}

console.log("team-activation: all assertions passed");
