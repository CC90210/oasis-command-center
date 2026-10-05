/**
 * lead-member-controls-inactive.test.ts — the lead drawer's Owner and
 * Collaborators controls with a deactivated teammate on the lead.
 *
 * GET /api/team/members became active-only on 2026-09-24. The Owner <select>
 * then had no option matching a deactivated owner's id and read
 * "— Unassigned —" for a lead that IS assigned, and a deactivated collaborator's
 * chip fell back to a truncated UUID. Both controls now opt in with
 * ?include_inactive=1 and render inactive people by name, but only as HISTORY:
 * never as a selectable new owner or an addable collaborator. Every tenant uses
 * these two components.
 *
 * The option/label rules are executed directly; the wiring (the opt-in fetch,
 * the disabled attribute, the other callers keeping the live roster) is pinned
 * on the source.
 *
 * Run: node --conditions=react-server --import tsx tests/lead-member-controls-inactive.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ownerOptions } from "../components/leads/AssignmentControl";
import { addableCollaborators, collaboratorName } from "../components/leads/CollaboratorsControl";

const ACTIVE = "0e0e0e0e-0000-4000-8000-000000000001";
const RETIRED = "0e0e0e0e-0000-4000-8000-000000000002";
const OTHER_RETIRED = "0e0e0e0e-0000-4000-8000-000000000003";
const LEGACY = "0e0e0e0e-0000-4000-8000-000000000004";

const members = [
  { id: "p-1", auth_user_id: ACTIVE, full_name: "Riley Active", display_name: null, active: true },
  { id: "p-2", auth_user_id: RETIRED, full_name: "Ethan Retired", display_name: null, active: false },
  { id: "p-3", auth_user_id: OTHER_RETIRED, full_name: "Idle Retired", display_name: "Idle", active: false },
  // A response without the flag (older deploy) must read as active.
  { id: "p-4", auth_user_id: LEGACY, full_name: "Lee Legacy", display_name: null },
];

// ── Owner select ─────────────────────────────────────────────────────────────
{
  const options = ownerOptions(members, RETIRED);
  const current = options.find((o) => o.value === RETIRED);
  assert.ok(current, "a deactivated CURRENT owner must have an option, or the select reads Unassigned");
  assert.equal(current.label, "Ethan Retired (inactive)");
  assert.equal(current.disabled, true, "a deactivated owner can be shown but never re-selected");
  assert.ok(
    !options.some((o) => o.value === OTHER_RETIRED),
    "a deactivated teammate who is not the current owner is not offered at all",
  );
  assert.deepEqual(
    options.filter((o) => !o.disabled).map((o) => o.label),
    ["Riley Active", "Lee Legacy"],
    "every selectable owner is an active teammate",
  );
}
{
  const options = ownerOptions(members, ACTIVE);
  assert.ok(options.every((o) => !o.disabled), "with an active owner no inactive option is rendered");
  assert.deepEqual(options.map((o) => o.value), [ACTIVE, LEGACY]);
  assert.deepEqual(
    ownerOptions(members, "").map((o) => o.value),
    [ACTIVE, LEGACY],
    "an unassigned lead offers active teammates only",
  );
}

// ── Collaborator chips + add list ────────────────────────────────────────────
{
  assert.equal(collaboratorName(members, RETIRED), "Ethan Retired (inactive)");
  assert.equal(collaboratorName(members, OTHER_RETIRED), "Idle (inactive)", "display_name still wins");
  assert.equal(collaboratorName(members, ACTIVE), "Riley Active");
  assert.equal(collaboratorName(members, LEGACY), "Lee Legacy");
  assert.equal(
    collaboratorName(members, "0e0e0e0e-0000-4000-8000-0000000000ff"),
    "0e0e0e0e",
    "only an id matching no member falls back to the truncated UUID",
  );
  assert.equal(collaboratorName(null, RETIRED), RETIRED.slice(0, 8), "before the roster loads");

  assert.deepEqual(
    addableCollaborators(members, "", []).map((m) => m.auth_user_id),
    [ACTIVE, LEGACY],
    "inactive teammates are never offered as new collaborators",
  );
  assert.deepEqual(
    addableCollaborators(members, ACTIVE, [LEGACY]).map((m) => m.auth_user_id),
    [],
    "the owner and existing collaborators stay excluded",
  );
  assert.deepEqual(addableCollaborators(null, "", []), []);
}

// ── Wiring ───────────────────────────────────────────────────────────────────
{
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const assignment = read("components/leads/AssignmentControl.tsx");
  const collaborators = read("components/leads/CollaboratorsControl.tsx");
  const route = read("app/api/team/members/route.ts");

  for (const [name, source] of [["AssignmentControl", assignment], ["CollaboratorsControl", collaborators]] as const) {
    assert.ok(
      source.includes('fetch("/api/team/members?include_inactive=1"'),
      `${name} must ask for inactive teammates so an existing one renders by name`,
    );
  }
  assert.match(assignment, /ownerOptions\(members \|\| \[\], value\)/, "the select renders ownerOptions");
  assert.match(assignment, /disabled=\{o\.disabled\}/, "an inactive option must render disabled");
  assert.match(collaborators, /collaboratorName\(members, id\)/, "chips resolve through collaboratorName");
  assert.match(collaborators, /addableCollaborators\(members, owner, collabs\)/, "the add list excludes inactive");

  // The opt-in is opt-in: the default response stays the live roster.
  assert.match(route, /searchParams\.get\("include_inactive"\) === "1"/);
  assert.match(route, /getTenantMembers\(ctx\.tenantId, \{ includeInactive \}\)/);
  for (const path of ["components/manifest/LeadPipelineView.tsx", "app/pipeline/[id]/LeadLifecycleActions.tsx"]) {
    const source = read(path);
    assert.ok(source.includes("/api/team/members"), `${path} still reads the team roster`);
    assert.ok(!source.includes("include_inactive"), `${path} keeps the active-only default`);
  }
}

console.log("lead member controls (inactive teammates): ok");
