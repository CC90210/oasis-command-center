import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { toWebLead } from "../lib/web-leads/data";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// THE RULE THIS FILE EXISTS FOR. Adon, 2026-08-25: "If you're unsure, you still
// put the phone number but there's a warning that it might not be the right
// number. For the numbers that you are 100% guaranteed on, we could have my
// reps dial them first."
//
// So: a tier ORDERS the queue and LABELS the number. It never removes one.
// ---------------------------------------------------------------------------

const lead = (data: Record<string, unknown>) => toWebLead({ id: "L1", data });

// ---------------------------------------------------------------------------
// Mapping. Until 2026-08-25 every lead carried a hardcoded confidence of 50 and
// this UI never read it, so a number nobody had checked rendered identically to
// one that had been.
// ---------------------------------------------------------------------------

{
  const l = lead({
    phone: "(514) 990-0199",
    webdev_phone_tier: "warned",
    webdev_phone_reasons: ["1 other business in our list show this same number, so it may belong to them."],
    webdev_phone_ext: "44086",
    webdev_phone_alternates: ["(888) 777-8601"],
  });
  assert.equal(l.phoneTier, "warned");
  assert.equal(l.phoneReasons.length, 1);
  assert.equal(l.phoneExt, "44086");
  assert.deepEqual(l.phoneAlternates, ["(888) 777-8601"]);
}

// A lead the backfill has not reached has NO tier. It must not be defaulted to
// "probable": that reinstates exactly the false reassurance this change removed.
{
  const l = lead({ phone: "(514) 990-0199" });
  assert.equal(l.phoneTier, null, "an unassessed lead must not claim a tier");
  assert.deepEqual(l.phoneReasons, []);
  assert.equal(l.phoneExt, null);
  assert.deepEqual(l.phoneAlternates, []);
}

// A tier value we do not recognise is treated as unassessed rather than passed
// through. The field crosses a repo boundary from JARVIS; a typo there must not
// become an unhandled label on a rep's screen.
for (const bogus of ["VERIFIED", "trusted", "", 42, null, {}]) {
  assert.equal(
    lead({ phone: "x", webdev_phone_tier: bogus }).phoneTier,
    null,
    `unrecognised tier ${JSON.stringify(bogus)} must fall back to null`,
  );
}

// Reasons arrive as JSON from another repo. A malformed value must degrade to
// an empty list, never throw a rep's lead page.
for (const bogus of ["not an array", 7, null, undefined, {}]) {
  assert.deepEqual(lead({ phone: "x", webdev_phone_reasons: bogus }).phoneReasons, []);
}
assert.deepEqual(
  lead({ phone: "x", webdev_phone_reasons: ["a", 2, null, "b"] }).phoneReasons,
  ["a", "2", "b"],
  "mixed content is coerced and emptied, not dropped wholesale",
);

// ---------------------------------------------------------------------------
// THE NUMBER IS NEVER HIDDEN. This is the assertion that protects Adon's actual
// instruction, and it is checked against the source because a component that
// returns null for a warned lead would satisfy every other test here.
// ---------------------------------------------------------------------------
{
  const src = read("components/web-leads/PhoneTrust.tsx");
  assert.doesNotMatch(
    src,
    /tier === "warned"[\s\S]{0,120}return null/,
    "a warned number must still render; the tier is a label, not a filter",
  );
  // The "still dialable" half of this rule is NOT asserted here. A grep for
  // `tel:` matches the href sitting in an untaken branch, which is exactly what
  // happened when a plant made the link conditional on the tier and this test
  // stayed green. It is proved by rendering instead, in
  // scripts/render-phone-trust-check.tsx.
  assert.match(src, /href=\{`tel:/, "the component must build a tel: link at all");
  // The reasons are rendered verbatim from the JARVIS table, like every other
  // rep-facing sentence in this feature.
  assert.match(src, /lead\.phoneReasons\.map/, "the reasons must reach the screen");
}

// ---------------------------------------------------------------------------
// NO COLOUR. Same ban as every other surface here: a red phone number reads as
// a verdict about the BUSINESS, when a shared listing is a fact about OUR data.
// State is carried by a word and a shape.
// ---------------------------------------------------------------------------
{
  const src = read("components/web-leads/PhoneTrust.tsx");
  for (const cls of ["text-red-", "bg-red-", "text-green-", "bg-green-", "bg-amber-", "text-amber-"]) {
    assert.doesNotMatch(
      src,
      new RegExp(cls.replace(/-/g, "\\-")),
      `PhoneTrust must not attach ${cls} to a trust state`,
    );
  }
  // And the shared guard file must name it, so it cannot drift out of the ban.
  assert.match(
    read("tests/web-leads-guards.test.ts"),
    /components\/web-leads\/PhoneTrust\.tsx/,
    "PhoneTrust must be listed in the colour-ban loop",
  );
}

// ---------------------------------------------------------------------------
// The warning reaches the rep at the moment it matters. CallMode is the screen
// they read while the call is connecting; a warning anywhere else is too late.
// ---------------------------------------------------------------------------
{
  const src = read("components/web-leads/CallMode.tsx");
  // `<PhoneTierBadge`, with the angle bracket. A bare name match is satisfied by
  // the IMPORT line alone: deleting the actual usage left this green when it was
  // planted (2026-08-25).
  assert.match(src, /<PhoneTierBadge tier=\{lead\.phoneTier\} \/>/, "Call Mode must RENDER the tier beside the dial button");
  assert.match(src, /lead\.phoneReasons\.map/, "Call Mode must show why a number is doubtful");
  assert.match(src, /lead\.phoneExt/, "dialling without a listed extension reaches the main line");
  // The button is never disabled or hidden on a warning.
  assert.doesNotMatch(
    src,
    /disabled=\{[^}]*phoneTier/,
    "a doubtful number must stay dialable; the rep decides",
  );
}

// The shared identity block carries it on BOTH the drawer and the battle card.
{
  const src = read("components/web-leads/BusinessFacts.tsx");
  assert.match(src, /<PhoneTrust lead=\{lead\} \/>/, "the identity block must render the trust component");
}

// ---------------------------------------------------------------------------
// ORDERING. Verified first, warned last, in EVERY sort, and never as a filter.
// ---------------------------------------------------------------------------
{
  const src = read("lib/web-leads/data.ts");
  assert.match(src, /PHONE_TIER_RANK/, "the comparator must rank by phone tier");
  assert.match(src, /byTrustThen/, "trust must be applied ahead of the chosen sort");
  // Applied to the name sort too, not just the score sorts: a rep sorting
  // alphabetically is still better served dialling numbers we believe in first.
  assert.match(
    src,
    /if \(sort === "name"\) return byTrustThen\(byName\)/,
    "the name sort must also put trusted numbers first",
  );
  // An unassessed lead ranks WITH probable, not last. Burying every
  // not-yet-backfilled lead would hide most of the book on the day this ships.
  assert.match(
    src,
    /PHONE_TIER_RANK\[l\.phoneTier \?\? "probable"\]/,
    "an unassessed lead must not be buried behind every warned one",
  );
  // Ordering only. A tier must never become a WHERE clause.
  assert.doesNotMatch(
    src,
    /filter\([^)]*phoneTier/,
    "a phone tier must never filter a lead out of the list",
  );
}

console.log("web-leads-phone-trust ok");
