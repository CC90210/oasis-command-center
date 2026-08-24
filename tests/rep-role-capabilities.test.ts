import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  isSelfScopedRole,
  mayQuoteAndClose,
  SELF_SCOPED_ROLES,
  DEAL_CLOSING_ROLES,
  OASIS_SALES_ROLE_OPTIONS,
} from "../lib/team-roles";
import { isScopedContractor } from "../lib/web-leads/data";
import { resolvePersona } from "../lib/role-surfaces";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ===========================================================================
// OPENERS AND CLOSERS ARE REAL SEATS NOW.
//
// Operator requirement (Adon, 2026-08-24): "it shouldn't change what reps can
// do, but you should be able to establish openers and closers, because although
// it's starting off with some people doing both, we're going to grow to the
// point that there are positions specifically for certain people and the
// software should be able to accommodate that."
//
// Both halves of that are pinned below: nobody working today loses access, and
// the setter-only seat now genuinely exists.
//
// The 2026-08-21 change added `manager`, `closer`, `opener` and `builder` as
// job titles and retired `agent` to legacy. Two pieces of code that gate real
// behaviour never moved across, and both still asked `teamRole === "agent"`.
// The consequences were opposite and both wrong, which is why this file tests
// in two directions.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. THE LEAK. A rep invited as Opener or Closer was NOT scoped to their own
// book, so the Web Leads browser served them every lead in the tenant --
// exactly the leak PR #237 closed for `agent`, reopened by the roles that
// replaced it.
//
// This is the assertion that would have failed before the fix.
// ---------------------------------------------------------------------------
for (const role of ["agent", "opener", "closer", "builder"]) {
  assert.ok(
    isSelfScopedRole(role),
    `${role} must be scoped to its own records -- a tenant check alone does not stop someone who sits INSIDE the tenant`,
  );
  assert.ok(
    isScopedContractor({ userId: "u1", teamRole: role, isAdmin: false }),
    `the Web Leads viewer predicate must scope ${role}`,
  );
}

// An admin is never scoped, whatever their nominal role.
for (const role of ["agent", "opener", "closer", "builder", "owner"]) {
  assert.equal(
    isScopedContractor({ userId: "u1", teamRole: role, isAdmin: true }),
    false,
    `an admin must not be scoped as a contractor (role=${role})`,
  );
}

// Roles that are NOT self-scoped stay that way. Widening this set is how a
// staged rollout for SunBiz's own roles would get trampled.
for (const role of ["owner", "admin", "member", "read_only", "loan_officer", "processor", "marketing", ""]) {
  assert.equal(isSelfScopedRole(role), false, `${role || "(empty)"} must not be treated as a self-scoped contractor`);
}
for (const junk of [null, undefined, 42, {}, []]) {
  assert.equal(isSelfScopedRole(junk), false, `${JSON.stringify(junk)} must fail closed, not be treated as a role`);
}

// ---------------------------------------------------------------------------
// 2. EVERY ROLE THAT SHARES THE "sales" PERSONA MUST BE SELF-SCOPED.
//
// lib/role-surfaces.ts already decided that opener, closer and agent get the
// same persona: own book, own commission, no company money. That decision and
// this predicate MUST agree, and they silently did not. Derived from the
// persona function itself rather than hardcoded, so adding a fourth sales role
// without scoping it fails here instead of leaking in production.
// ---------------------------------------------------------------------------
for (const { value } of OASIS_SALES_ROLE_OPTIONS) {
  const persona = resolvePersona({ teamRole: value, isTrueAdmin: false, adminAccess: false });
  if (persona === "sales") {
    assert.ok(
      isSelfScopedRole(value),
      `${value} resolves to the "sales" persona (own book) but is not self-scoped -- that combination is the leak`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. THE SETTER-ONLY SEAT. `opener` may work a book and hand it off, and may
// NOT put a price in front of a prospect.
//
// This is the feature. A setter who can quote discounts on their first week,
// promises a delivery date nobody agreed to, or confirms a custom build is
// feasible when it is not -- the exact things the offer doctrine forbids.
// ---------------------------------------------------------------------------
assert.equal(mayQuoteAndClose("opener"), false, "an opener must NOT be able to quote or close -- that is the whole point of the title");
assert.ok(isSelfScopedRole("opener"), "an opener still works their own book");

// ---------------------------------------------------------------------------
// 4. THE CLOSER SEAT WORKS. The role literally named for closing could not
// close anything before this change.
// ---------------------------------------------------------------------------
assert.ok(mayQuoteAndClose("closer"), "a closer must be able to quote and close");

// ---------------------------------------------------------------------------
// 5. NOBODY WORKING TODAY LOSES ACCESS. `agent` is the legacy role every
// current rep actually carries, it can quote and close today, and the operator
// was explicit that this change must not take anything away.
//
// Grandfathering it is a deliberate decision, not an oversight, so it is
// asserted rather than left to be "cleaned up" by someone reading the role list
// and seeing a legacy name.
// ---------------------------------------------------------------------------
assert.ok(
  mayQuoteAndClose("agent"),
  "the legacy `agent` role must KEEP quote/close -- migrating a person is a deliberate role change, never a silent revocation they discover mid-call",
);

// Everyone else is refused, including roles that sound senior. A manager does
// not close on a rep's book; an admin path exists separately and is checked by
// `isTrueAdmin` at the call site, not by this predicate.
for (const role of ["manager", "builder", "marketing", "member", "read_only", "loan_officer", "processor", "owner", "admin", ""]) {
  assert.equal(
    mayQuoteAndClose(role),
    false,
    `${role || "(empty)"} must not pass the rep quote/close role gate -- admins go through isTrueAdmin, not this`,
  );
}
for (const junk of [null, undefined, 0, {}, []]) {
  assert.equal(mayQuoteAndClose(junk), false, `${JSON.stringify(junk)} must fail closed`);
}

// Case and whitespace must not be a way past either gate.
assert.ok(mayQuoteAndClose("  CLOSER "), "role matching must tolerate case and padding rather than failing open elsewhere");
assert.equal(mayQuoteAndClose("clos er"), false, "a mangled role must not match");

// ---------------------------------------------------------------------------
// 6. AN OPENER MUST NOT BE ABLE TO CLOSE ITS OWN LEAD EITHER.
//
// Role and ownership are separate questions and BOTH are required. The route
// must keep the ownership half: a closer may no more close someone else's deal
// than an opener may close their own, and dropping either half turns the gate
// into a formality.
// ---------------------------------------------------------------------------
const salesRoute = stripComments(read("app/api/website-sales/[leadId]/route.ts"));
assert.match(
  salesRoute,
  /mayQuoteAndClose\(session\.teamRole\)\s*&&\s*\(assignedToUser \|\| attributedToUser\)/,
  "the deal gate must require BOTH the role and ownership -- either alone is not a gate",
);
// The old bare-role check must not creep back.
assert.doesNotMatch(
  salesRoute,
  /session\.teamRole === "agent"/,
  'the rep gate must not go back to a bare `teamRole === "agent"` -- that is what locked closers out and left openers unexpressible',
);

// ---------------------------------------------------------------------------
// 7. EVERY DOOR ONTO tenant_records APPLIES THE SAME SCOPING SET.
//
// The leak did not come from missing scoping; it came from TWO scoping
// predicates that were meant to be identical and were not. Both must now read
// the one shared set, so a third door cannot be added with a fresh hardcoded
// role list.
// ---------------------------------------------------------------------------
for (const door of [
  "lib/web-leads/data.ts",
  "app/api/manifest/[slug]/records/[entity]/route.ts",
]) {
  const src = stripComments(read(door));
  assert.match(src, /isSelfScopedRole\(/, `${door} must use the shared self-scoped role predicate`);
  assert.doesNotMatch(
    src,
    /teamRole === "agent"/,
    `${door} must not hardcode the legacy role -- that is the drift that reopened the #237 leak`,
  );
}

// The two sets are deliberately different memberships, and confusing them
// would either lock closers out or let openers quote. Assert they are not the
// same object and not the same contents.
assert.notDeepEqual(
  [...SELF_SCOPED_ROLES].sort(),
  [...DEAL_CLOSING_ROLES].sort(),
  "who is scoped and who may close are different questions with different answers",
);
assert.ok(SELF_SCOPED_ROLES.has("opener") && !DEAL_CLOSING_ROLES.has("opener"), "opener: scoped, cannot close");
assert.ok(SELF_SCOPED_ROLES.has("closer") && DEAL_CLOSING_ROLES.has("closer"), "closer: scoped, can close");

console.log("rep-role-capabilities ok");

// ---------------------------------------------------------------------------
// 8. "MAY PERFORM THE CLOSE" IS NOT "MAY BE PAID ON THE DEAL".
//
// An independent review (Codex, 2026-08-24) read the close RPC's role list,
// saw it permits `opener`, and reported the route gate and the RPC as
// contradicting each other. They do not -- they answer different questions
// about different people, and conflating them would break the comp plan in one
// direction or the permission model in the other:
//
//   route gate (this file)   session.teamRole -- the person CLICKING close.
//                            An opener must not, because closing means quoting
//                            a price.
//   close RPC allowlist      p_rep_user_id -- the ATTRIBUTED rep, the person
//                            being PAID. An opener absolutely belongs there:
//                            they earn the 20% opener rate when a founder
//                            closes the lead they sourced. Removing them would
//                            silently stop paying setters for two-party sales.
//
// So the two lists MUST differ, and the danger is a future editor "fixing" the
// disagreement in either direction. This pins the distinction with the reason
// attached, so the next person to notice it reads why before changing it.
// ---------------------------------------------------------------------------
const shim = stripComments(read("lib/turso-rpc-shim.ts"));
const payeeGate = shim.match(/team_role IN \('agent','closer','opener','builder','manager'\)/);
assert.ok(
  payeeGate,
  "the close RPC must keep its own PAYEE allowlist -- it is a different question from who may click close",
);
assert.ok(
  !mayQuoteAndClose("opener"),
  "an opener may not PERFORM a close even though they may be PAID on one",
);
assert.ok(
  !mayQuoteAndClose("builder") && !mayQuoteAndClose("manager"),
  "builder and manager may be paid from the ledger but may not run a deal",
);
// The RPC's own guard is defence in depth and must stay: the route gate is not
// the only caller, and a server-side re-check is what makes a forged request
// fail. Asserted by presence, so deleting it as "already checked upstream"
// fails here.
assert.match(shim, /rep_not_agent_for_tenant/, "the close RPC must re-verify the payee server-side, not trust the route");

console.log("rep-role-capabilities (payee vs actor) ok");
