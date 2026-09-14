import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { CAPABILITIES } from "../lib/web-leads/automations";
import { UNMEASURABLE_CHECKS, evidenceStateFor } from "../lib/web-leads/check-evidence";

// ---------------------------------------------------------------------------
// The catalogue COMPONENTS, pinned against their rendered output.
//
// WHY THIS FILE EXISTS. Three fixes from the previous review round --- the
// partial-audit headline, the unmeasurable-check branch, and the missing dot
// on an unresolved row --- were pinned by nothing at all. They were verified
// once, by hand, with a render script that was then deleted. Reverting any of
// them would have left a green suite, which is the same "a guard nothing
// executes is documentation" failure _suite-web-leads.mjs was created for.
//
// HOW IT RENDERS. The suite runs every test with --conditions=react-server,
// under which react-dom/server does not resolve and react exports no
// useState, so a client component with hooks cannot be rendered in this
// process at all. web-leads-automations-catalogue.render.ts is therefore
// spawned as a plain node process, renders every scenario, and prints one
// JSON object of markup. All the assertions live here so a scenario that
// stops rendering what it should fails with a named message rather than
// silently producing a shorter string.
//
// WHAT THIS FILE DOES NOT COVER, stated rather than implied:
//   - Nothing behind an interaction. There is no DOM and no click, so
//     "one open at a time" and the show-all toggle are NOT pinned here.
//     Scenarios that need an open row pass `defaultOpenId`.
//   - No layout, no visual regression, no colour rendering. It asserts on
//     markup substrings, so a rule moving to a different element still
//     passes as long as the string is somewhere in the output.
//   - Not the copy itself. automations.ts owns that and
//     web-leads-automations.test.ts pins it.
// ---------------------------------------------------------------------------

const r = spawnSync(
  process.execPath,
  ["--import", "tsx", "tests/web-leads-automations-catalogue.render.ts"],
  { encoding: "utf8", env: { ...process.env, TSX_TSCONFIG_PATH: "tests/tsconfig.render.json" } },
);
assert.equal(
  r.status,
  0,
  `the render helper must exit 0; it exited ${r.status} with:\n${r.stderr}`,
);
const html: Record<string, string> = JSON.parse(r.stdout);

/** Markup with the tags stripped, for asserting on what a rep would read. */
const text = (key: string) => html[key].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

const TODAY_COUNT = CAPABILITIES.filter((c) => c.stage === "today").length;
const LADDER_COUNT = CAPABILITIES.filter((c) => c.stage !== "today").length;

// The exact dot element, not any rounded element: the delivery bullets and
// the ranking bar are also rounded, so a bare "rounded-full" count would
// pass while the identity dot was gone.
const DOT = "h-1.5 w-1.5 shrink-0 rounded-full";

// ---------------------------------------------------------------------------
// 1. FIVE INTRO STATES, one per situation, each saying something different.
//    The headline is the sentence a rep reads aloud, so getting it wrong is
//    not cosmetic: "we checked this site and nothing came back failing" over
//    a site we only partly looked at is a false claim about coverage.
// ---------------------------------------------------------------------------
{
  assert.match(text("introNoAudit"), /has not been checked yet/, "no audit must say so");
  assert.match(text("introNoWebsite"), /no website for this business/, "no website must say so");
  assert.match(text("introClean"), /none of the things we look for came back failing/, "a complete clean audit must say so");
  assert.match(text("introRankedFull"), /heaviest first/, "a lead with findings gets the ranked headline");

  // The one that was broken. A partial audit with nothing failing took the
  // `clean` branch, because hasAudit was true as soon as ONE dimension had
  // checks. Both halves are asserted: the right sentence present AND the
  // wrong one absent, because adding the partial line while leaving the
  // clean line beside it would be no fix at all.
  assert.match(text("introPartial"), /only got through part of this site/, "a partial audit must say it is partial");
  assert.doesNotMatch(
    text("introPartial"),
    /none of the things we look for came back failing/,
    "a partial audit must NEVER tell a rep the site came back clean: the rows beneath it say nothing was checked",
  );

  // Each intro is distinct: five situations, five sentences.
  const intros = ["introNoAudit", "introNoWebsite", "introClean", "introPartial", "introRankedFull"];
  const firstLines = intros.map((k) => text(k).slice(0, 120));
  assert.equal(new Set(firstLines).size, intros.length, "each situation must produce its own headline, not a shared one");
}
console.log("web-leads-automations-catalogue: five intro states OK");

// ---------------------------------------------------------------------------
// 2. THE COVERAGE FACT IS VISIBLE WITHOUT AN INTERACTION.
//    A partially-audited lead that DOES have a failing code takes the
//    `ranked` branch, and every unchecked capability sits in `rest`, behind
//    the collapsed show-all control. Rendered, that lead showed one row, one
//    figure and a control: the words "nothing this covers has been checked"
//    were not in the DOM at all. "Heaviest first" over a one-of-ten sample
//    is a coverage claim a partial audit cannot support.
// ---------------------------------------------------------------------------
{
  assert.match(
    text("introRankedPartial"),
    /only got through part of this site/,
    "a ranked panel over a partial audit must carry the coverage fact in the markup, with no interaction",
  );
  assert.match(
    text("introRankedPartial"),
    new RegExp(`9 of the ${TODAY_COUNT} areas below were never checked`),
    "the coverage line must count the capabilities that were actually unscored",
  );
  // And it does NOT fire when the audit really did cover everything, or the
  // line would be a permanent disclaimer that means nothing.
  assert.doesNotMatch(
    text("introRankedFull"),
    /only got through part of this site/,
    "a complete audit must not carry a partial-coverage warning",
  );
}
console.log("web-leads-automations-catalogue: coverage fact visible without an interaction OK");

// ---------------------------------------------------------------------------
// 3. `null` NEVER REACHES A FORMATTER. A capability nobody checked has
//    recoverable === null, and "0 points to recover" told to an owner with
//    no website is the failure the number|null typing exists to prevent.
// ---------------------------------------------------------------------------
{
  for (const key of ["introNoAudit", "introNoWebsite", "introPartial", "rowClean", "rowUnscored", "rowNoWebsite"]) {
    assert.doesNotMatch(html[key], /\+\d/, `${key}: an unscored capability must print no figure at all, not a zero`);
    assert.doesNotMatch(html[key], /\bNaN\b|undefined|null/, `${key}: no null or NaN may reach the markup`);
  }
  // The positive half: a scored row DOES print its figure, so the assertion
  // above is not passing merely because nothing ever prints one.
  assert.match(html.rowScored, /\+4\.9/, "a scored capability prints its weighted figure");
  assert.match(html.openScored, /\+4\.9/, "and prints it through the catalogue too");
}
console.log("web-leads-automations-catalogue: null never renders as a figure OK");

// ---------------------------------------------------------------------------
// 4. THE BUNDLE COST SENTENCE IS SUPPRESSED IN EVERY NON-SCORED STATE.
//    `costsThem` is written once for a whole bundle but a bundle renders
//    when any ONE of its codes failed, so it is only ever stood behind by
//    the specific failing checks printed under it. With no finding there is
//    nothing to stand behind it, and each state gets its own sentence.
// ---------------------------------------------------------------------------
{
  const easy = CAPABILITIES.find((c) => c.id === "easy-to-call")!;
  const costsFragment = easy.costsThem!.slice(0, 40);
  assert.ok(costsFragment.length > 20, "the fixture capability must actually carry a costsThem to suppress");

  assert.ok(text("rowScored").includes(costsFragment), "a scored row DOES render the bundle cost sentence");
  for (const key of ["rowClean", "rowUnscored", "rowNoWebsite"]) {
    assert.ok(
      !text(key).includes(costsFragment),
      `${key}: the bundle cost sentence asserts a defect and must not render when none was found`,
    );
  }
  // Each non-scored state says something instead of nothing.
  assert.match(text("rowClean"), /they all passed/, "a clean row says it is clean");
  assert.match(text("rowUnscored"), /has been checked for this business/, "an unscored row says nothing was checked");
  assert.match(text("rowNoWebsite"), /no website for this business yet/, "a no-website row says there is no site");
  // And the grounding is really there on the scored one: the failing check's
  // own label and its remedies.ts cost line.
  assert.match(text("rowScored"), /LABEL:tel_link/, "a scored row names the specific failing check");
  assert.match(text("rowScored"), /copy your number by hand/, "and renders that check's own remedies.ts cost line");
}
console.log("web-leads-automations-catalogue: bundle cost sentence suppressed off a finding OK");

// ---------------------------------------------------------------------------
// 5. THE UNMEASURABLE BRANCH IS FIRST. A check our own model cannot measure
//    for anybody is named as our flaw BEFORE any attempt to read a signal
//    that was never going to be there.
//
//    PINNED IN TWO HALVES (Task 5, 2026-09-14), because the claim has two
//    halves. The ORDER is `evidenceStateFor`'s, a pure function in
//    lib/web-leads/check-evidence.ts, called here directly with an explicit
//    table. The RENDERING is CheckEvidenceLine's, exercised by the render
//    helper from an explicit state.
//
//    This replaces the previous shape, where the only way to reach the
//    branch was for the render helper to write an entry into
//    UNMEASURABLE_CHECKS and delete it again -- which is the only reason
//    that table was exported as mutable module state at all. It is a plain
//    const now.
//
//    The control is what makes this a real ordering claim rather than a
//    vacuous one: with the table empty, the same code and the same signals
//    DO produce an evidence line, so the unmeasurable branch displaced
//    something rather than winning by default.
// ---------------------------------------------------------------------------
{
  const SIGNALS = { telLinks: 0 };
  const control = evidenceStateFor("tel_link", SIGNALS);
  assert.equal(
    control.kind,
    "measured",
    "control: with the table empty, this code and these signals DO resolve to a measured line",
  );
  const displaced = evidenceStateFor("tel_link", SIGNALS, { tel_link: "OUR MODEL CANNOT MEASURE THIS ONE YET." });
  assert.equal(
    displaced.kind,
    "unmeasurable",
    "the unmeasurable branch must come FIRST and displace the evidence line, not render beside it",
  );
  // The production table really is empty, so no check on a live card is
  // currently disclaimed. Asserted rather than assumed: an entry added here
  // would silently change what every surface says about that check.
  assert.deepEqual(UNMEASURABLE_CHECKS, {}, "the unmeasurable table is empty in production");

  // And the rendering half: an unmeasurable state names it as our flaw.
  assert.match(html.rowUnmeasurableLine, /Not measurable:/, "an unmeasurable check is named as our flaw");
  assert.doesNotMatch(html.rowUnmeasurableLine, /Seen on the site:/, "and only that, not both lines at once");
  assert.match(html.rowEvidenceWithoutUnmeasurable, /Seen on the site:/, "control, rendered: the evidence line is what it displaces");
}
console.log("web-leads-automations-catalogue: unmeasurable branch fires first OK");

// ---------------------------------------------------------------------------
// 6. NO IDENTITY DOT WHEN NO DIMENSION RESOLVED. FALLBACK_HUE.to and
//    DIM_HUES.content.to are both #7dd3fc and the dot paints .to alone, so a
//    fallback dot is pixel-identical to a content dot. No area identified,
//    no identity mark.
// ---------------------------------------------------------------------------
{
  assert.ok(html.rowScored.includes(DOT), "a row with a resolved dimension wears its identity dot");
  assert.ok(!html.rowNoHue.includes(DOT), "a row with no resolved dimension must render NO dot rather than the shared fallback hue");
  assert.ok(!html.introNoAudit.includes(DOT), "an unaudited lead resolves no dimension anywhere, so no row wears a dot");
  // Ladder entries carry no codes, so they never resolve one either.
  assert.ok(html.openLadder.includes(DOT), "the scored website rows on this lead still wear theirs");
  // This lead fails exactly one code, so `relevant` holds one row and the
  // other nine sit behind the collapsed show-all. One visible website row
  // with a resolved dimension, five ladder rows with none: one dot.
  assert.equal(
    (html.openLadder.match(new RegExp(DOT, "g")) || []).length,
    1,
    "exactly the one relevant website row wears a dot here; the five ladder rows wear none",
  );
}
console.log("web-leads-automations-catalogue: no dot on an unresolved row OK");

// ---------------------------------------------------------------------------
// 7. THE RANKING BAR IS SCALED AGAINST THE REAL MAXIMUM, NOT A FLOOR OF 1.
//    maxRanking carried `Math.max(1, ...)`, written when the key was raw
//    check points whose smallest non-zero value was 4. Weighted composite
//    points go well below 1, so a lone row worth 0.65 drew at 65% of a bar
//    captioned "drawn against the largest one in this list" while BEING the
//    largest one in the list.
// ---------------------------------------------------------------------------
{
  assert.match(html.openSoleSubOne, /\+0\.7/, "the fixture must really produce a sub-1.0 figure, or this pins nothing");
  assert.match(
    html.openSoleSubOne,
    /width:100%/,
    "the only scored row in a list must draw a full bar whatever its absolute value; a floor of 1 draws it at 65%",
  );
}
console.log("web-leads-automations-catalogue: ranking bar scaled against the real maximum OK");

// ---------------------------------------------------------------------------
// 8. NO PANEL IS EVER BLANK, and the stage groups are always separated and
//    labelled. Design spec §5 and §3.3.
// ---------------------------------------------------------------------------
{
  for (const key of ["introNoAudit", "introNoWebsite", "introClean", "introPartial", "introRankedFull", "introRankedPartial"]) {
    const rows = html[key].split("aria-expanded").length - 1;
    assert.ok(rows > 0, `${key}: a rep must never be shown a panel with no rows`);
    assert.ok(
      rows >= LADDER_COUNT,
      `${key}: the ladder is never matched against an audit and must always be present in full`,
    );
    assert.match(text(key), /Do not open with them/, `${key}: every later-stage group carries its do-not-open-with-it warning`);
  }
  // The no-audit and no-website leads render every website capability plus
  // the whole ladder, unranked, rather than an empty primary list.
  for (const key of ["introNoAudit", "introNoWebsite"]) {
    assert.equal(
      html[key].split("aria-expanded").length - 1,
      TODAY_COUNT + LADDER_COUNT,
      `${key}: every capability renders, because none of them is held back behind show-all when nothing was measured`,
    );
  }
}
console.log("web-leads-automations-catalogue: no blank panel, ladder always present OK");

// ---------------------------------------------------------------------------
// 9. NO VERDICT COLOUR, NO EM DASH, NO DOUBLE HYPHEN, in anything rendered.
//    The same sweep web-leads-guards.test.ts applies to the rest of this
//    feature, applied here to the OUTPUT rather than the source, so a banned
//    string arriving from automations.ts or remedies.ts is caught too.
// ---------------------------------------------------------------------------
{
  for (const [key, markup] of Object.entries(html)) {
    for (const cls of ["text-red-", "bg-red-", "text-green-", "bg-green-", "bg-amber-"]) {
      assert.ok(!markup.includes(cls), `${key}: ${cls} renders a judgement the measurement does not support`);
    }
    const rendered = text(key);
    assert.ok(!rendered.includes("—"), `${key}: an em dash renders literally on the card`);
    assert.ok(!rendered.includes("--"), `${key}: a double hyphen renders literally on the card`);
  }
}
console.log("web-leads-automations-catalogue: colour ban and dash sweep OK");

console.log("web-leads-automations-catalogue: ALL OK");
