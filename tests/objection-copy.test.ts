import assert from "node:assert";

import { OBJECTIONS, ANGLES } from "@/lib/web-leads/angles";
import {
  ALTERNATE_ANSWERS,
  POSTURE_LABEL,
  mergeAnswers,
  type SeedAnswer,
} from "@/lib/web-leads/objections/alternate-answers";
import { SEEDED_SLUGS } from "@/lib/web-leads/objections/seed-slugs";

// ---------------------------------------------------------------------------
// Copy rules for every sentence a rep says out loud when handling an
// objection. Until this file existed there were NONE: automations.ts carries
// six pinned copy rules and every one of them is proven to fire, while
// objection response bodies, which are read verbatim to a stranger on a live
// call, had no em-dash guard, no money guard and no empty-body guard at all.
//
// WHAT THIS COVERS: the primary response bodies in angles.ts (both the eight
// universal OBJECTIONS and the seven ANGLES), and every alternate in
// ALTERNATE_ANSWERS. Those are the three sources the seed writes into
// objection_response, and objection_response is what ObjectionCard renders.
//
// WHAT THIS DOES NOT COVER, stated rather than implied:
//   - Whether a sentence is any GOOD. No test can tell a rep that a move
//     lands. Only the Phase 2 scoreboard's recovery-by-posture can, and it
//     needs the alternates this file guards to exist before it can compare
//     anything at all.
//   - The rows actually in Turso. This reads the SOURCE the seed writes from.
//     A row edited directly in the database, or an older row from a previous
//     seed run, is not visible here.
//   - `meaning` and `prevent`. `meaning` does render on the card, but it is
//     the rep's own briefing rather than a spoken line, and `prevent` is
//     coaching prose that legitimately cites sources with punctuation these
//     rules ban.
// ---------------------------------------------------------------------------

/** En dash and em dash. Both render as a dash a rep would stumble over, and
 *  both are the standing tell of generated text in customer-facing copy. */
const DASH = /[—–]/;
/** A double hyphen renders literally on the card rather than as a dash. */
const DOUBLE_HYPHEN = /--/;
/** A currency symbol, or a figure attached to a money word. A rep reading a
 *  number off a script is quoting a price nobody scoped to this business,
 *  which is the single worst thing this product can put in someone's mouth.
 *  The catalog's own `source` field exists for cited figures; a spoken line
 *  is not the place for one either way, so this is a flat ban rather than a
 *  source-gated check, and it says so rather than implying a check it does
 *  not perform. */
const MONEY = /[$£€]|\b\d[\d,.]*\s*(?:dollars?|bucks|grand|cents?|k)\b/i;

/** Every spoken body the seed will write, with a label for the failure text. */
function spokenBodies(): { where: string; body: string }[] {
  const out: { where: string; body: string }[] = [];
  for (const o of OBJECTIONS) {
    out.push({ where: `OBJECTIONS[${JSON.stringify(o.says.slice(0, 32))}].response`, body: o.response });
  }
  for (const [dimension, angle] of Object.entries(ANGLES)) {
    out.push({ where: `ANGLES.${dimension}.objection.response`, body: angle.objection.response });
  }
  for (const [slug, alternates] of Object.entries(ALTERNATE_ANSWERS)) {
    for (const alt of alternates) {
      out.push({ where: `ALTERNATE_ANSWERS.${slug}/${alt.posture}`, body: alt.body });
    }
  }
  return out;
}

const BODIES = spokenBodies();

// The count is asserted, not assumed. A refactor that made spokenBodies()
// silently collect nothing would turn every rule below into a loop over an
// empty array, and a copy guard that inspects zero strings passes forever
// while checking nothing.
assert.ok(
  BODIES.length >= 45,
  `expected at least 45 spoken bodies (15 primaries + 30 alternates), collected ${BODIES.length}. ` +
    `A copy rule that iterates an empty list passes while checking nothing.`,
);

for (const { where, body } of BODIES) {
  assert.ok(body.trim().length > 0, `${where} must not be empty: the card would render a blank answer`);
  assert.ok(!DASH.test(body), `${where} contains an em or en dash, which is banned in customer-facing copy`);
  assert.ok(!DOUBLE_HYPHEN.test(body), `${where} contains a double hyphen, which renders literally on the card`);
  assert.ok(!MONEY.test(body), `${where} states a money figure; a spoken line must never quote an unscoped price`);
}

console.log(`objection-copy: ${BODIES.length} spoken bodies obey the copy rules OK`);

// ---------------------------------------------------------------------------
// Coverage. Every seeded objection must have alternates, or its card renders
// one answer and ObjectionCard's picker (gated on answers.length > 1) never
// appears for it. That was the state of all fifteen before this change.
// ---------------------------------------------------------------------------

for (const slug of SEEDED_SLUGS) {
  const alternates = ALTERNATE_ANSWERS[slug];
  assert.ok(
    alternates && alternates.length > 0,
    `${slug} has no alternates, so its posture picker will not render and its posture can never ` +
      `be compared against another`,
  );
}

const orphans = Object.keys(ALTERNATE_ANSWERS).filter((s) => !(SEEDED_SLUGS as readonly string[]).includes(s));
assert.deepEqual(orphans, [], `ALTERNATE_ANSWERS keys matching no seeded slug write nothing: ${orphans.join(", ")}`);

console.log(`objection-copy: all ${SEEDED_SLUGS.length} seeded slugs carry alternates, no orphan keys OK`);

// ---------------------------------------------------------------------------
// Distinct moves. Three rewordings of one posture would defeat the whole
// four-posture model: "recovery by posture" would compare a posture against
// itself.
// ---------------------------------------------------------------------------

for (const [slug, alternates] of Object.entries(ALTERNATE_ANSWERS)) {
  const postures = alternates.map((a) => a.posture);
  const dupe = postures.find((p, i) => postures.indexOf(p) !== i);
  assert.equal(dupe, undefined, `${slug} has two alternates with posture ${dupe}`);

  const bodies = alternates.map((a) => a.body.trim());
  const dupeBody = bodies.find((b, i) => bodies.indexOf(b) !== i);
  assert.equal(dupeBody, undefined, `${slug} has two alternates with identical wording`);
}

assert.deepEqual(
  Object.keys(POSTURE_LABEL).sort(),
  ["agree_and_redirect", "question_back", "reframe_the_cost", "take_it_away"],
  "POSTURE_LABEL must name every posture, or an alternate renders with an empty button",
);

console.log("objection-copy: postures and wording distinct within every objection OK");

// ---------------------------------------------------------------------------
// mergeAnswers, the guard the seed writer depends on. It lives in the
// alternates module rather than in the seed script precisely so it can be
// proven here: the seed runs main() as a module-level side effect, so
// importing it from a test would execute a seed run.
// ---------------------------------------------------------------------------

const PRIMARY: SeedAnswer = { label: "Agree, then redirect", body: "primary body", posture: "agree_and_redirect" };

// A real slug merges to primary + its alternates, and only the primary keeps
// index 0, which is what the seed writes is_default = 1 against.
const merged = mergeAnswers("no-budget", { ...PRIMARY, posture: "question_back", label: "Question it back" });
assert.equal(merged.length, 3, "no-budget must merge to three answers");
assert.equal(merged[0].body, "primary body", "the primary must stay at index 0, which is the is_default row");
assert.equal(new Set(merged.map((a) => a.posture)).size, 3, "all three postures must differ");
for (const a of merged.slice(1)) {
  assert.equal(a.label, POSTURE_LABEL[a.posture], "an alternate must carry its posture's standard label");
}

// A slug with no alternates throws rather than returning a one-answer card.
assert.throws(
  () => mergeAnswers("no-such-objection-slug", PRIMARY),
  /no ALTERNATE_ANSWERS entry for no-such-objection-slug/,
  "a slug with no alternates must throw, not silently render a card with no picker",
);

// A primary whose posture collides with an alternate's throws. This is the
// case that would otherwise overwrite a row on the writer's natural key
// (tenant_id, objection_id, posture) and leave the card with fewer answers
// than were written, which looks identical to never having written them.
assert.throws(
  () => mergeAnswers("no-budget", { ...PRIMARY, posture: ALTERNATE_ANSWERS["no-budget"][0].posture }),
  /has two answers with posture/,
  "a posture collision must throw: it would silently overwrite a row on the writer's natural key",
);

console.log("objection-copy: mergeAnswers merges, and throws on a missing slug and on a posture collision OK");
console.log("objection-copy: ALL OK");
