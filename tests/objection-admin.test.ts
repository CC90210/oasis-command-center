import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

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
  changesCopy,
  mayApproveObjections,
  mayAuthorObjections,
  mayViewObjectionLibrary,
  needsApprovalRights,
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

// --- editing copy that is already live is a CLOSER act ---------------------
//
// All three cases below are review findings from this same branch, fixed
// before it shipped. The first is the one that matters most: an earlier
// version of needsApprovalRights read the PAYLOAD alone, so a body carrying
// only `says` or `body` looked like a harmless draft fix and passed the
// author bar. On an approved row that rewrites a sentence live on reps'
// screens, with no closer involved, which reopened the exact gate this
// surface exists to close.

const DRAFT_ROW = { objectionStatus: "draft", responseStatus: "draft" };
const LIVE_ROW = { objectionStatus: "approved", responseStatus: "approved" };

assert.equal(
  needsApprovalRights({ says: "reworded" }, {}, DRAFT_ROW),
  false,
  "editing a DRAFT objection is authoring, and any rep may do it",
);
assert.equal(
  needsApprovalRights({ says: "reworded" }, {}, LIVE_ROW),
  true,
  "editing an APPROVED objection rewrites live copy and needs closer rights",
);
assert.equal(
  needsApprovalRights({}, { body: "reworded" }, LIVE_ROW),
  true,
  "editing an APPROVED answer rewrites what a rep reads aloud and needs closer rights",
);
assert.equal(
  needsApprovalRights({}, { body: "reworded" }, DRAFT_ROW),
  false,
  "editing a DRAFT answer is authoring",
);

// An unreadable or missing row demands the HIGHER permission, not the lower.
assert.equal(
  needsApprovalRights({ says: "x" }, {}, { objectionStatus: null, responseStatus: null }),
  true,
  "a status that could not be read must fail closed to the closer bar",
);

// Lifecycle changes are always the closer bar, whatever the stored status.
assert.equal(needsApprovalRights({ status: "approved" }, {}, DRAFT_ROW), true, "approving is a closer act");
assert.equal(needsApprovalRights({ status: "retired" }, {}, DRAFT_ROW), true, "retiring empties the console instantly");
assert.equal(needsApprovalRights({}, { makeDefault: true }, DRAFT_ROW), true, "promoting a default is a closer act");

// A request that changes nothing needs nothing.
assert.equal(needsApprovalRights({}, {}, LIVE_ROW), false, "an empty patch is not an approval");

assert.equal(changesCopy({ meaning: "x" }, {}), true);
assert.equal(changesCopy({}, { label: "x" }), true);
assert.equal(changesCopy({ status: "approved" }, {}), false, "a status change is lifecycle, not copy");

console.log("objection-admin: editing live copy requires closer rights OK");

// --- source-level guards for the two fixes a unit test cannot reach --------
//
// Both are review findings from this branch. Neither can be exercised here:
// one needs a live libSQL connection and the other needs a DOM. The repo's
// existing tests/objection-guards.test.ts pins that class of check by reading
// source, so these follow it rather than inventing a second convention or,
// worse, leaving two confirmed defects with nothing watching them.

/** Comments stripped before any structural assertion. Prose inside a
 *  statement contains semicolons and braces, and slicing to the next `;`
 *  without removing it cuts the statement short and asserts against a
 *  fragment. tests/objection-guards.test.ts documents the same hazard. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const adminSource = stripComments(
  fs.readFileSync(path.join(process.cwd(), "lib/web-leads/objections/admin.ts"), "utf8"),
);
const updateResponseSource = (() => {
  const start = adminSource.indexOf("export async function updateResponse(");
  assert.ok(start > 0, "updateResponse must exist to be guarded");
  const next = adminSource.indexOf("\nexport ", start + 1);
  return adminSource.slice(start, next < 0 ? adminSource.length : next);
})();

// A response id arrives in the request BODY and the objection id in the URL.
// Filtering on tenant and response id alone let a caller pair an id from one
// objection with another objection's route: makeDefault then cleared every
// default under the URL objection and promoted a row parented elsewhere,
// leaving the first with none and risking two on the second, which is a
// uniqueness failure on the partial index.
// Asserted against the WRITE statement specifically, not as a count of
// `objection_id` filters in the function. A count is the weak version and it
// proved itself weak: there are three such filters here (the ownership read,
// the makeDefault clear, and the write), so a `>= 2` check still passed with
// the write's own filter deleted, which is precisely the defect. Pin the
// statement that does the damage.
const writeStatement = (() => {
  const marker = ".update(update)";
  const at = updateResponseSource.indexOf(marker);
  assert.ok(at > 0, "updateResponse must contain the final update statement");
  const end = updateResponseSource.indexOf(";", at);
  return updateResponseSource.slice(at, end);
})();
assert.ok(
  writeStatement.includes('.eq("objection_id", objectionId)'),
  "the final updateResponse write must be scoped by objection_id, or a response id from another " +
    "objection is updated through this objection's route",
);

const ownershipRead = updateResponseSource.slice(0, updateResponseSource.indexOf(".update(update)"));
assert.ok(
  ownershipRead.includes('.eq("objection_id", objectionId)'),
  "the ownership read must be scoped by objection_id too, so a mismatched pair is rejected before any write",
);
assert.ok(
  updateResponseSource.includes("response_not_in_objection"),
  "a response that does not belong to this objection must be rejected by name, never silently no-op",
);

// Without a control that posts a response, an objection created here can be
// approved and still never reach a rep, because the console only serves
// objections with at least one approved answer. That failure looks exactly
// like the feature working.
const librarySource = fs.readFileSync(
  path.join(process.cwd(), "components/objections/ObjectionLibrary.tsx"),
  "utf8",
);
assert.ok(
  /method:\s*"POST"[\s\S]{0,400}posture/.test(librarySource) ||
    /posture[\s\S]{0,400}method:\s*"POST"/.test(librarySource),
  "the library must offer a control that POSTs a new answer, or a new objection can never become usable",
);
assert.ok(
  librarySource.includes("All four moves are taken"),
  "the add-answer control must handle the case where every posture is used",
);

console.log("objection-admin: parent scoping and the add-answer control are pinned OK");

console.log("objection-admin: normalisation, similarity and duplicates OK");
console.log("objection-admin: batch parsing and slugs OK");
console.log("objection-admin: write-path copy rules OK");
console.log("objection-admin: approval gate fails closed OK");
console.log("objection-admin: ALL OK");
