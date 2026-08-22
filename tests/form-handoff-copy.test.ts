import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The public form completion screen has THREE endings, and showing the wrong
 * one has cost real applications.
 *
 *   1. nothing outstanding          -> "All set." (correct, keep it)
 *   2. full-application outstanding -> the application is NOT submitted
 *   3. bank-statement-upload only   -> the application IS submitted
 *
 * Adon, 2026-08-21: merchants who finished the interest form were shown a
 * large success tick, "All set.", and the tenant's "a specialist will reach
 * out" message, with the real next step below them as an optional "have a few
 * minutes?" extra. They read the top, believed they were finished, and left.
 *
 * Codex review P1, same day: the first fix treated ANY outstanding form as
 * ending 2, which told merchants who had just SUBMITTED a full application
 * that it "has not been submitted yet" and labelled it "Part 1".
 */

const src = readFileSync(new URL("../components/forms/FormPublicClient.tsx", import.meta.url), "utf8");
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------
// 1. The ending is chosen by WHICH form is outstanding, not merely that one is.
// ---------------------------------------------------------------------------
assert.match(
  src,
  /const applicationOutstanding = nextForms\.some\(\(f\) => f\.slug === "full-application"\)/,
  "the copy must key on the outstanding form's slug; any-pending-form is what produced the false " +
    "'not submitted yet' on a completed application",
);

const handoffIdx = src.indexOf("const handoff = applicationOutstanding");
assert.ok(handoffIdx > 0, "handoff copy block not found");
const handoffBlock = stripComments(src.slice(handoffIdx, src.indexOf("return (", handoffIdx)));
const [appBranch, docsBranch] = handoffBlock.split(": {");
assert.ok(appBranch && docsBranch, "handoff must define both an application branch and a documents branch");

// --- ending 2: the application is genuinely not submitted ------------------
assert.match(appBranch, /Part 1 complete\. One step left\./, "handoff heading states progress AND that work remains");
assert.match(appBranch, /has not been submitted yet/, "handoff says plainly the application is not in");
assert.match(appBranch, /Details received/, "progress row shows what is done");
assert.match(appBranch, /Your application/, "progress row shows what is next");

// --- ending 3: the application IS submitted, documents remain --------------
assert.ok(
  !/has not been submitted/.test(docsBranch),
  "the documents ending must NOT claim the application is unsubmitted; it is, and saying otherwise " +
    "pushes a finished applicant to re-apply",
);
assert.ok(!/Part 1/.test(docsBranch), 'the documents ending must not label a completed application "Part 1"');
assert.match(docsBranch, /Application received/, "the documents ending confirms the application landed");
assert.match(docsBranch, /bank statements/i, "the documents ending names what is actually needed");

// ---------------------------------------------------------------------------
// 2. The pending screen renders from that classification, and never claims
//    completion.
// ---------------------------------------------------------------------------
const forkIdx = src.indexOf("nextForms.length > 0 ? (");
assert.ok(forkIdx > 0, "the completion screen must branch on whether a form is outstanding");
// Boundary is the else marker, not the "All set." heading: the terminal branch
// opens with its large tick ABOVE that heading.
const elseIdx = src.indexOf("          ) : (", forkIdx);
assert.ok(elseIdx > forkIdx, "the fork must have an else branch for the terminal ending");
const pendingRaw = src.slice(forkIdx, elseIdx);
const pending = stripComments(pendingRaw);

assert.ok(!pending.includes("All set."), 'the outstanding-form screen must not say "All set."');
assert.ok(
  !pending.includes("{thanksMessage}"),
  "the outstanding-form screen must not render the tenant's thanks message; on this tenant it reads " +
    "'a specialist will reach out within one business day', which tells a merchant to wait while " +
    "something is still required of them",
);
assert.ok(!/have a few minutes/i.test(pending), "the next step is required, not an optional extra");
assert.ok(!/no rush|anytime/i.test(pending), "copy inviting the merchant to leave is the behaviour being fixed");

for (const token of [
  "{handoff.heading}",
  "{handoff.body}",
  "{handoff.doneLabel}",
  "{handoff.nextLabel}",
  "{handoff.footer}",
]) {
  assert.ok(pending.includes(token), `pending screen must render ${token} rather than hard-coded copy`);
}

// A lone large tick reads as completion however the text is worded.
assert.ok(
  !/<CheckCircle2\s*\n?\s*className="w-12 h-12/.test(pendingRaw),
  "the large success tick must not appear while a form is outstanding",
);

// ---------------------------------------------------------------------------
// 3. The next step is the most prominent thing on the screen.
// ---------------------------------------------------------------------------
const cta = pendingRaw.match(/min-h-\[(\d+)px\]/);
assert.ok(cta, "the continue button must set an explicit minimum height");
assert.ok(
  Number(cta[1]) >= 56,
  `continue button is ${cta[1]}px; it was 44px when merchants were missing it, so it must be visibly larger`,
);

// ---------------------------------------------------------------------------
// 4. Ending 1 survives. This screen is shared by every public form, and
//    "All set." is CORRECT when nothing is outstanding, so the fix must be a
//    fork rather than a blanket rewording.
// ---------------------------------------------------------------------------
const terminalIdx = src.indexOf('<h2 className="text-xl font-bold text-fg">All set.</h2>', elseIdx);
assert.ok(terminalIdx > elseIdx, '"All set." must live in the terminal branch');
assert.ok(
  src.slice(terminalIdx, terminalIdx + 600).includes("{thanksMessage}"),
  "the terminal ending keeps the tenant's thanks message",
);

// ---------------------------------------------------------------------------
// 5. No em dashes in merchant-facing copy.
// ---------------------------------------------------------------------------
const dashes = stripComments(src).match(/.{0,50}[—–].{0,50}/g) || [];
assert.deepEqual(dashes, [], `em/en dash in merchant-facing copy: ${dashes.join(" | ")}`);

console.log("ok form-handoff-copy (3 endings)");
