import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The Form 1 -> Form 2 handoff screen.
 *
 * Adon, 2026-08-21: merchants who finished the interest form were shown a large
 * success tick, the words "All set." and the tenant's "a specialist will reach
 * out" message, with the actual next step offered underneath as an optional
 * "have a few minutes?" extra. They read the top, believed they were finished,
 * and left. Their application was never submitted.
 *
 * Every assertion below is that failure mode, pinned.
 */

const src = readFileSync(new URL("../components/forms/FormPublicClient.tsx", import.meta.url), "utf8");

// The completion block splits on whether another form is still owed.
const doneIdx = src.indexOf("{done ? (");
assert.ok(doneIdx > 0, "completion block not found");
const forkIdx = src.indexOf("nextForms.length > 0 ? (", doneIdx);
assert.ok(forkIdx > doneIdx, "the completion screen must branch on whether a form is still outstanding");

// Everything from the fork to the START of the else branch is what a merchant
// with an outstanding form sees. The boundary is the else marker, not the
// "All set." heading: the terminal branch opens with its large success tick
// ABOVE that heading, so slicing to the heading would pull that tick into the
// pending block and test the wrong text.
const elseIdx = src.indexOf("          ) : (", forkIdx);
assert.ok(elseIdx > forkIdx, "the fork must have an else branch for the terminal ending");
const pendingRaw = src.slice(forkIdx, elseIdx);

const terminalIdx = src.indexOf('<h2 className="text-xl font-bold text-fg">All set.</h2>', elseIdx);
assert.ok(terminalIdx > elseIdx, '"All set." must live in the terminal branch, after the else');
/** Comments in this block QUOTE the old copy in order to explain why it was
 *  removed, so the copy assertions below must read the rendered text only. */
const pending = pendingRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// 1. The pending screen must never claim completion.
// ---------------------------------------------------------------------------
assert.ok(!pending.includes("All set."), 'the outstanding-form screen must not say "All set."');
assert.ok(
  !pending.includes("{thanksMessage}"),
  "the outstanding-form screen must not render the tenant's thanks message — on this tenant it reads " +
    "'a specialist will reach out within one business day', which tells a merchant to sit back and wait " +
    "while their application is still unsubmitted",
);
assert.ok(
  !/have a few minutes/i.test(pending),
  "the next step is required, not an optional extra offered to people with spare time",
);
assert.ok(
  !/no rush|anytime/i.test(pending),
  "copy inviting the merchant to leave and come back later is the behaviour being fixed",
);

// ---------------------------------------------------------------------------
// 2. It must state progress and the outstanding requirement.
// ---------------------------------------------------------------------------
assert.ok(
  pending.includes("Part 1 complete. One step left."),
  "the heading must state both what is done and that something remains",
);
assert.ok(
  /has not been submitted yet/.test(pending),
  "the screen must say plainly that the application is not submitted",
);
assert.ok(
  pending.includes("Details received") && pending.includes("Your application"),
  "a two-line progress indicator must replace the single success tick",
);

// A lone large tick is the visual that reads as 'finished'. The pending branch
// may only use a small one, inside the progress row.
assert.ok(
  !/<CheckCircle2\s*\n?\s*className="w-12 h-12/.test(pendingRaw),
  "the large success tick must not appear while a form is still outstanding",
);

// ---------------------------------------------------------------------------
// 3. The next step must be the most prominent thing on the screen.
// ---------------------------------------------------------------------------
const cta = pendingRaw.match(/min-h-\[(\d+)px\]/);
assert.ok(cta, "the continue button must set an explicit minimum height");
assert.ok(
  Number(cta[1]) >= 56,
  `continue button is ${cta[1]}px tall; it was 44px when merchants were missing it, so it must be visibly larger`,
);

// ---------------------------------------------------------------------------
// 4. The terminal ending still exists, for forms with nothing following.
//    This screen is shared: "All set." is CORRECT when nothing is outstanding,
//    so the fix must be conditional rather than a blanket rewording.
// ---------------------------------------------------------------------------
const terminal = src.slice(terminalIdx, terminalIdx + 600);
assert.ok(terminal.includes("{thanksMessage}"), "the terminal ending keeps the tenant's thanks message");

// ---------------------------------------------------------------------------
// 5. No em dashes in merchant-facing copy.
// ---------------------------------------------------------------------------
const strippedComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const dashes = strippedComments.match(/.{0,50}[—–].{0,50}/g) || [];
assert.deepEqual(dashes, [], `em/en dash in merchant-facing copy: ${dashes.join(" | ")}`);

console.log("ok form-handoff-copy");
