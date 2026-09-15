import assert from "node:assert";

import {
  NEAR_DUPLICATE_SCORE,
  contentTokens,
  copyViolations,
  findDuplicate,
  normaliseSays,
  parseBatch,
  similarity,
  slugify,
  uniqueSlug,
} from "@/lib/web-leads/objections/admin";
import {
  approverName,
  mayApproveObjections,
  mayAuthorObjections,
  mayViewObjectionLibrary,
} from "@/lib/web-leads/objections/admin-access";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";

// ---------------------------------------------------------------------------
// The authoring surface, tested where it can be tested without a database.
//
// WHAT THIS COVERS: the pure decisions. Whether two objections are the same
// one, what a pasted block parses into, what copy is refused on the write
// path, and who is allowed to approve. Those are the parts that decide whether
// the library bloats and whether an unapproved sentence can reach a rep.
//
// WHAT THIS DOES NOT COVER, stated rather than implied:
//   - The SQL. `fetchAdminCatalog`, `createDraftObjection`, `updateObjection`
//     and `updateResponse` all take a live libSQL connection, and nothing here
//     stands one up. The clear-then-set that keeps the partial unique index
//     satisfiable is therefore NOT pinned by this file; it is pinned by
//     reading migration 171 and by the seed's own behaviour.
//   - The routes' wiring. These assert the gate FUNCTIONS, not that each route
//     calls them. tests/objection-guards.test.ts is the file that reads route
//     source for that class of check.
// ---------------------------------------------------------------------------

// --- normalisation ---------------------------------------------------------

assert.equal(normaliseSays("  We have NO budget.  "), "we have no budget");
assert.equal(
  normaliseSays("“Just send me an email!”"),
  "just send me an email",
  "curly quotes and punctuation must not make two identical objections look different",
);
assert.equal(normaliseSays("It’s fine"), "it's fine", "a curly apostrophe folds to a straight one");
assert.equal(normaliseSays("   "), "", "whitespace only normalises to empty");

assert.deepEqual(contentTokens("We have no budget for that right now"), ["no", "budget"]);

// --- similarity ------------------------------------------------------------

assert.equal(similarity("no budget", "no budget"), 1, "identical content words score 1");
assert.equal(similarity("", "no budget"), 0, "an empty side scores 0, never 1");
assert.equal(similarity("", ""), 0, "two empties score 0: an empty candidate must never look like a perfect match");
assert.ok(
  similarity("We have no budget for that right now", "we have absolutely no budget") >= NEAR_DUPLICATE_SCORE,
  "the same objection at very different lengths must still score as near",
);
assert.ok(
  similarity("We have no budget", "It looks fine on my phone") < NEAR_DUPLICATE_SCORE,
  "two unrelated objections must not score as near",
);

// --- duplicates ------------------------------------------------------------

const LIBRARY = [
  { id: "o1", slug: "no-budget", says: "We have no budget for that right now.", status: "approved" },
  { id: "o2", slug: "mobile-looks-fine", says: "It looks fine on my phone.", status: "approved" },
];

const exact = findDuplicate("we have no budget for that right now", LIBRARY);
assert.equal(exact.kind, "exact", "punctuation and case differences are still the same objection");
assert.equal(exact.kind === "exact" ? exact.slug : "", "no-budget");

const near = findDuplicate("We have absolutely no budget", LIBRARY);
assert.equal(near.kind, "near", "a reworded objection is surfaced, not silently accepted");
assert.ok(near.kind === "near" && near.score >= NEAR_DUPLICATE_SCORE);

assert.equal(
  findDuplicate("Who else have you done this for round here?", LIBRARY).kind,
  "none",
  "a genuinely new objection must not be flagged",
);
assert.equal(findDuplicate("   ", LIBRARY).kind, "none", "an empty candidate matches nothing");

// A duplicate verdict NEVER carries an instruction to merge: it reports, and
// the caller decides. Asserted structurally so a future refactor cannot add an
// auto-merge without this failing.
assert.ok(!("merge" in near) && !("apply" in near), "a duplicate verdict must not carry an action");

// --- batch parsing ---------------------------------------------------------

assert.deepEqual(
  parseBatch("- We already have someone\n2) Your prices are too high\n\n  • Send me something  "),
  ["We already have someone", "Your prices are too high", "Send me something"],
  "list marks and blank lines are stripped",
);

assert.deepEqual(
  parseBatch('"We are not interested"\n“We are not interested.”'),
  ["We are not interested"],
  "the same line twice in one paste is kept once, quotes and punctuation notwithstanding",
);

assert.deepEqual(
  parseBatch("It looks fine on my phone. I checked it myself."),
  ["It looks fine on my phone. I checked it myself."],
  "a line is NOT split on sentences: objections routinely contain a full stop, and splitting doubles the library",
);

assert.deepEqual(parseBatch("   \n\n  "), [], "a paste of whitespace yields nothing");

// --- slugs -----------------------------------------------------------------

assert.equal(slugify("We have no budget for that right now."), "no-budget");
assert.equal(
  slugify("We have no budget"),
  slugify("We have no budget for that right now."),
  "filler words must not produce two slugs for the same objection",
);
assert.ok(slugify("   ").startsWith("objection-"), "an unsluggable objection still gets a usable slug");

assert.equal(uniqueSlug("no-budget", []), "no-budget");
assert.equal(uniqueSlug("no-budget", ["no-budget"]), "no-budget-2");
assert.equal(uniqueSlug("no-budget", ["no-budget", "no-budget-2"]), "no-budget-3");

// --- copy rules on the write path ------------------------------------------

assert.deepEqual(copyViolations("A perfectly ordinary sentence.", "The answer", 1200), []);
assert.equal(copyViolations("", "The answer", 1200).length, 1, "empty is refused");
assert.ok(copyViolations("a — b", "The answer", 1200)[0].includes("em or en dash"));
assert.ok(copyViolations("a -- b", "The answer", 1200)[0].includes("double hyphen"));
assert.ok(copyViolations("it costs $500", "The answer", 1200)[0].includes("money figure"));
assert.ok(copyViolations("about 5 grand", "The answer", 1200)[0].includes("money figure"));
assert.ok(copyViolations("x".repeat(1300), "The answer", 1200)[0].includes("over the 1200"));

// ALL violations, not the first: somebody pasting a batch should fix their
// wording once rather than discover the rules one at a time.
const many = copyViolations("costs $5 — and -- more", "The answer", 1200);
assert.equal(many.length, 3, `expected three violations, got ${many.length}: ${many.join(" | ")}`);

// --- who may do what -------------------------------------------------------

const closer = { ok: true, tenantId: WEBDEV_TENANT_ID, teamRole: "closer", isAdmin: false, email: "c@oasisai.work" };
const opener = { ok: true, tenantId: WEBDEV_TENANT_ID, teamRole: "opener", isAdmin: false, email: "o@oasisai.work" };
const admin = { ok: true, tenantId: WEBDEV_TENANT_ID, teamRole: "support", isAdmin: true, email: "a@oasisai.work" };
const otherTenant = { ok: true, tenantId: "some-other-tenant", teamRole: "closer", isAdmin: true, email: "x@y.z" };

assert.equal(mayViewObjectionLibrary(opener), true, "a rep who works leads may read the library");
assert.equal(mayAuthorObjections(opener), true, "a rep may draft an objection they heard");
assert.equal(
  mayApproveObjections(opener),
  false,
  "an opener may NOT approve: putting a sentence in a rep's mouth is the deal-closing bar",
);
assert.equal(mayApproveObjections(closer), true, "a closer may approve");
assert.equal(mayApproveObjections(admin), true, "a tenant admin may approve");

// Fail closed, every way in.
assert.equal(mayViewObjectionLibrary(otherTenant), false, "another tenant sees nothing, admin or not");
assert.equal(mayApproveObjections(otherTenant), false, "another tenant approves nothing, admin or not");
assert.equal(mayApproveObjections({ ok: false }), false, "an unauthenticated session approves nothing");
assert.equal(mayViewObjectionLibrary(null), false, "a null session reads nothing");
assert.equal(mayViewObjectionLibrary(undefined), false, "an undefined session reads nothing");
assert.equal(
  mayApproveObjections({ ok: true, tenantId: WEBDEV_TENANT_ID, teamRole: null, isAdmin: false }),
  false,
  "a missing role approves nothing",
);

assert.equal(approverName(closer), "c@oasisai.work", "the email identifies the approver");
assert.equal(
  approverName({ ok: true, tenantId: WEBDEV_TENANT_ID, teamRole: "closer", email: null, userId: "u-1" }),
  "u-1",
  "with no email the user id stands in, so an approval always records somebody",
);
assert.equal(
  approverName({ ok: true, tenantId: WEBDEV_TENANT_ID, teamRole: "closer" }),
  "unknown",
  "approverName never returns empty: updateObjection refuses to stamp an approval by nobody",
);

console.log("objection-admin: normalisation, similarity and duplicates OK");
console.log("objection-admin: batch parsing and slugs OK");
console.log("objection-admin: write-path copy rules OK");
console.log("objection-admin: approval gate fails closed OK");
console.log("objection-admin: ALL OK");
