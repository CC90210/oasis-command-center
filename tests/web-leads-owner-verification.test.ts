import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const card = readFileSync(join(process.cwd(), "components/web-leads/LeadCards.tsx"), "utf8");
// "Confirmed" must be reachable ONLY from the confirmed state. If this ever
// renders for an unverified lead, the badge is lying to a rep on a live call.
assert.match(card, /l\.ownerVerification === "confirmed"[\s\S]{0,400}Confirmed/);

// Every other named state gets its OWN label, matched inside that state's own
// branch -- not merely present somewhere in the file.
assert.match(
  card,
  /l\.ownerVerification === "self_reported"[\s\S]{0,400}Their own word/,
  "self_reported must render the 'Their own word' label",
);
assert.match(
  card,
  /l\.ownerVerification === "conflict"[\s\S]{0,400}Mismatched/,
  "conflict must render its own warning label -- it is the state a rep most needs to see, not an ordinary unverified lead",
);
assert.match(
  card,
  /l\.ownerVerification === "unchecked"[\s\S]{0,400}No lookup yet/,
  "unchecked must render its own label -- no lookup ran at all, it must not read as an already-checked self-reported number",
);
assert.match(card, /lookup_failed[\s\S]{0,400}Not checked/);

// THE REGRESSION THIS FILE EXISTS TO CATCH: conflict and unchecked used to
// fall through one shared else branch straight into "Their own word" -- the
// same reassuring label an ordinary self-reported lead wears, on the state a
// rep most needs to see. Extract each named branch on its own (up to the next
// ternary boundary) and prove IT specifically does not carry another state's
// label, rather than trusting the whole-file regex checks above not to match
// by coincidence.
function branchFor(state: string): string {
  const marker = `l.ownerVerification === "${state}"`;
  const at = card.indexOf(marker);
  assert.ok(at !== -1, `must find the ${state} branch`);
  const rest = card.slice(at, at + 500);
  const close = rest.indexOf(") : ");
  return close === -1 ? rest : rest.slice(0, close);
}
assert.doesNotMatch(
  branchFor("conflict"),
  /Their own word/,
  "conflict must not share self_reported's label -- that is the exact bug this test pins",
);
assert.doesNotMatch(
  branchFor("unchecked"),
  /Their own word/,
  "unchecked must not share self_reported's label -- nobody has said anything, because no lookup ran",
);
assert.doesNotMatch(
  branchFor("conflict"),
  />Not checked</,
  "conflict must not read as merely unchecked or failed -- it is a positive mismatch, not an absence of data",
);

// Fail closed: an unrecognised value must render as unverified, never as
// verified. "Confirmed" must be reachable from exactly one branch in the
// whole file -- a future catch-all else that reuses it would move this count.
const confirmedCount = (card.match(/>Confirmed</g) || []).length;
assert.equal(confirmedCount, 1, "'Confirmed' must be reachable from exactly one branch, not a catch-all");

assert.match(card, /\{l\.ownerEvidence \?/, "the evidence sentence must render");
console.log("web-leads-owner-verification ok");
