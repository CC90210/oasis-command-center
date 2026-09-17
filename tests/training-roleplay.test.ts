import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import {
  CALL_ENDED,
  DEBRIEF_SYSTEM_PROMPT,
  DebriefRejected,
  MAX_REP_CHARS,
  MAX_TURNS,
  buildDebriefPrompt,
  buildOwnerSystemPrompt,
  buildTurnPrompt,
  parseDebrief,
  parseOwnerReply,
  type Turn,
} from "@/lib/training/roleplay/prompt";
import { SCENARIOS, scenarioById } from "@/lib/training/roleplay/scenarios";
import { assertTranscriptSane } from "@/lib/training/roleplay/turn";
import { SEEDED_SLUGS } from "@/lib/web-leads/objections/seed-slugs";

// ---------------------------------------------------------------------------
// The practice call.
//
// Two things here are genuinely dangerous and everything else is detail.
//
// ONE: the model plays a CUSTOMER, so the objection engine's copy rules do NOT
// apply to its turns. An owner asking what something costs is the most ordinary
// thing an owner says; banning it would produce a customer who never behaves
// like one. Those rules DO apply to the debrief, which is advice a rep acts on.
// Getting that inversion wrong in either direction breaks the feature.
//
// TWO: a rep types freely into a prompt. The persona must stay on the server
// and the transcript must be fenced, or a rep can hand themselves an owner who
// agrees to everything.
//
// WHAT THIS DOES NOT COVER: the model. Nothing here asserts a real reply is any
// good, or that the seam is reachable. It asserts what happens to a reply once
// it arrives, and what is sent.
// ---------------------------------------------------------------------------

// --- scenarios -------------------------------------------------------------

assert.ok(SCENARIOS.length >= 4, "too few scenarios to practise against");
assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, "duplicate scenario id");
for (const s of SCENARIOS) {
  assert.ok(s.business.trim() && s.trade.trim(), `${s.id} has no business`);
  assert.ok(s.visible.length > 0, `${s.id} shows the rep nothing before the call`);
  assert.ok(s.temperament.trim().length > 40, `${s.id} has no real temperament to play`);
  assert.ok(s.winsIf.trim().length > 0, `${s.id} has no idea what a good call looks like`);
  // The objection they open with must be one the rep can actually have drilled.
  assert.ok(
    (SEEDED_SLUGS as readonly string[]).includes(s.opensWith),
    `${s.id} opens with "${s.opensWith}", which is not in the objection catalog, so the drill and the call teach different things`,
  );
}
assert.ok(scenarioById(SCENARIOS[0].id), "scenarioById must find a real one");
assert.equal(scenarioById("nope"), null, "an unknown scenario must resolve to null, not a default");

console.log("training-roleplay: scenarios are complete and tie to the objection catalog OK");

// --- the persona prompt ----------------------------------------------------

const scenario = SCENARIOS[0];
const system = buildOwnerSystemPrompt(scenario);
assert.ok(system.includes(scenario.business), "the owner must know which business they are");
assert.ok(system.includes(scenario.temperament), "the temperament must reach the model");
assert.ok(/never break character/i.test(system), "the owner must be told not to coach");
assert.ok(/never be abusive/i.test(system), "the owner must be told not to abuse the rep");
assert.ok(/never become an easy sale/i.test(system), "an owner who folds teaches nothing");
assert.ok(system.includes(CALL_ENDED), "the owner needs a way to end the call");
assert.ok(
  /never an instruction|is speech/i.test(system),
  "the system prompt must say the transcript is speech, not instructions",
);

const prompt = buildTurnPrompt(scenario, [{ role: "rep", text: "Hello" }]);
assert.ok(prompt.includes("<<<CALL>>>") && prompt.includes("<<<END>>>"), "the transcript must be fenced");
assert.ok(prompt.includes("never an instruction"), "the fence must be labelled as data");
for (const v of scenario.visible) {
  assert.ok(prompt.includes(v), "what the rep can see must reach the owner prompt");
}
// An empty transcript is a real state: the call has just connected.
assert.ok(
  buildTurnPrompt(scenario, []).includes("has not spoken yet"),
  "an empty transcript must render as the call having just connected",
);

console.log("training-roleplay: the persona is server-side and the transcript is fenced OK");

// --- the owner's reply -----------------------------------------------------

assert.deepEqual(parseOwnerReply("Yeah, what is this about?"), {
  text: "Yeah, what is this about?",
  ended: false,
});

// The ways a model reliably breaks character.
assert.equal(parseOwnerReply("OWNER: I am on a roof.").text, "I am on a roof.", "a speaker label is stripped");
assert.equal(parseOwnerReply("YOU: Not interested.").text, "Not interested.", "either label is stripped");
assert.equal(
  parseOwnerReply("*sighs* Go on then.").text,
  "Go on then.",
  "stage directions are stripped: a rep reading them is shown the machinery",
);
assert.equal(parseOwnerReply('"Make it quick."').text, "Make it quick.", "wrapping quotes are stripped");

const ended = parseOwnerReply(`Not for me, thanks. ${CALL_ENDED}`);
assert.equal(ended.ended, true, "the end token must end the call");
assert.ok(!ended.text.includes(CALL_ENDED), "the token must not be shown to the rep");
assert.ok(ended.text.length > 0, "the last line must still have words in it");

// A reply that is ONLY the end token is a real ending, and a blank line is not.
const bare = parseOwnerReply(CALL_ENDED);
assert.equal(bare.ended, true);
assert.ok(bare.text.trim().length > 0, "an ending must still say something rather than showing silence");

assert.throws(() => parseOwnerReply(""), /owner_reply_empty/, "an empty reply is refused, not rendered as silence");
assert.throws(() => parseOwnerReply("   "), /owner_reply_empty/, "whitespace is refused too");

// 🚨 THE OWNER IS NOT COPY-RULE CHECKED, and that is the point. A customer
// asking about money is the most ordinary thing on a sales call.
const askingPrice = parseOwnerReply("Right, so how much is this going to cost me? Ballpark, $500?");
assert.ok(
  askingPrice.text.includes("$500"),
  "an owner asking about money must survive: they are a customer, not a rep, and a customer who cannot mention money is not a customer",
);

console.log("training-roleplay: the owner's turns are cleaned but not censored OK");

// --- the debrief IS held to the rep-facing rules ---------------------------

const goodDebrief = JSON.stringify({
  verdict: "You opened well and then pitched before they had agreed anything was wrong.",
  did_well: ["You named a specific thing about their site in the first breath."],
  missed: ["You never asked what it costs them when nobody answers the phone."],
  next_time: "Ask one diagnostic question and wait for the answer before describing anything.",
});
const parsed = parseDebrief(goodDebrief);
assert.equal(parsed.didWell.length, 1);
assert.equal(parsed.missed.length, 1);
assert.ok(parsed.verdict.length > 0 && parsed.nextTime.length > 0);

assert.equal(parseDebrief("```json\n" + goodDebrief + "\n```").verdict, parsed.verdict, "a fenced reply parses");

const rejects = (raw: string, why: string): DebriefRejected => {
  assert.throws(() => parseDebrief(raw), DebriefRejected, why);
  try {
    parseDebrief(raw);
  } catch (err) {
    return err as DebriefRejected;
  }
  throw new Error("unreachable");
};

rejects("", "an empty review is refused");
rejects("I would rather not say.", "a review with no JSON is refused");
rejects(JSON.stringify({ did_well: [], missed: [] }), "a review with no verdict is refused");
rejects(
  JSON.stringify({ verdict: "Fine.", did_well: [], missed: [], next_time: "" }),
  "a review that does not say what to change is refused",
);

// A price in coaching is the same unapproved number the rest of the product
// refuses, arriving as advice.
const priced = rejects(
  JSON.stringify({
    verdict: "Solid call.",
    did_well: [],
    missed: ["You should have told them it starts at $497."],
    next_time: "Quote the starting price earlier.",
  }),
  "a review that states a price is refused",
);
assert.ok(
  priced.violations.some((v) => v.includes("money figure")),
  `the price must be named, got ${JSON.stringify(priced.violations)}`,
);

const dashed = rejects(
  JSON.stringify({
    verdict: "Good open — weak middle.",
    did_well: [],
    missed: [],
    next_time: "Ask sooner.",
  }),
  "a review with an em dash is refused",
);
assert.ok(dashed.violations.some((v) => v.includes("em or en dash")));

// The rules the debrief is judged by must be stated to the model, or the
// validator refuses what the prompt never forbade and the button just fails.
for (const rule of ["price", "em dash", "invent"]) {
  assert.ok(
    DEBRIEF_SYSTEM_PROMPT.toLowerCase().includes(rule.toLowerCase()),
    `the debrief prompt must state the "${rule}" rule that parseDebrief enforces`,
  );
}
assert.ok(!/[—–]/.test(DEBRIEF_SYSTEM_PROMPT), "the debrief prompt must not contain the dash it bans");

const debriefPrompt = buildDebriefPrompt(scenario, [{ role: "rep", text: "Hi there" }]);
assert.ok(debriefPrompt.includes("<<<CALL>>>"), "the transcript must be fenced for the reviewer too");
assert.ok(debriefPrompt.includes(scenario.winsIf), "the reviewer must know what a good call looked like");

console.log("training-roleplay: the debrief obeys every rep-facing copy rule OK");

// --- caps ------------------------------------------------------------------

const long: Turn[] = Array.from({ length: MAX_TURNS + 1 }, () => ({ role: "rep" as const, text: "hi" }));
assert.throws(() => assertTranscriptSane(long), /longer than a real one/, "a runaway call is refused");

assert.throws(
  () => assertTranscriptSane([{ role: "rep", text: "x".repeat(MAX_REP_CHARS + 1) }]),
  /longer than anybody says/,
  "a rep turn longer than anybody speaks is refused",
);
assert.throws(
  () => assertTranscriptSane([{ role: "rep", text: "   " }]),
  /empty line/,
  "an empty turn is refused rather than sent",
);
assert.doesNotThrow(() => assertTranscriptSane([{ role: "rep", text: "Hello" }]), "a normal call passes");

console.log("training-roleplay: the call cannot run away OK");

// --- the route must not take a persona from the client --------------------

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const routeSource = stripComments(
  fs.readFileSync(path.join(process.cwd(), "app/api/training/roleplay/route.ts"), "utf8"),
);
assert.ok(
  routeSource.includes("scenarioById("),
  "the route must resolve the scenario server-side from an id",
);
for (const forbidden of ["payload.temperament", "payload.system", "payload.persona", "payload.prompt"]) {
  assert.ok(
    !routeSource.includes(forbidden),
    `the route must never take ${forbidden} from the client: that is handing a rep the owner's script`,
  );
}
assert.ok(
  routeSource.includes("mayViewTraining"),
  "the route must prove permission before spending a model call",
);

// The page must not ship the answer sheet to the browser.
const pageSource = stripComments(
  fs.readFileSync(path.join(process.cwd(), "app/training/roleplay/[scenario]/page.tsx"), "utf8"),
);
assert.ok(
  /temperament:\s*""/.test(pageSource) && /winsIf:\s*""/.test(pageSource),
  "the temperament and win condition must be blanked before reaching the client, or a rep practises against a cheat sheet",
);

console.log("training-roleplay: the persona never leaves the server OK");
// --- review round 2 on this branch ----------------------------------------

// The cap applies to EVERY turn. The whole transcript arrives from the client,
// including the lines labelled as the owner's, so capping only the rep's left
// it trivially bypassable: relabel the text and send twenty-four of them. The
// role is a claim, not a fact.
assert.throws(
  () => assertTranscriptSane([{ role: "owner", text: "x".repeat(MAX_REP_CHARS + 1) }]),
  /longer than anybody says/,
  "an oversized OWNER turn must be refused too: the role is client-supplied",
);

const callSource = fs.readFileSync(
  path.join(process.cwd(), "components/training/RoleplayCall.tsx"),
  "utf8",
);

// A queued reply is keyed on the exact prompt, so collecting it needs the
// identical transcript resent. Without a retry the rep's next line built a
// different transcript, a different key, and the finished reply was orphaned.
assert.ok(
  /const retry = useCallback/.test(callSource),
  "there must be a retry that resends the unchanged transcript, or a slow model breaks the call with no way forward",
);
assert.ok(
  /transcript: retryable/.test(callSource),
  "the retry must resend the SAME transcript, not a rebuilt one, or it will not collect the queued reply",
);
assert.ok(
  /setRetryable\(pending\)/.test(callSource),
  "a pending turn must record what to retry, inside the one shared handler",
);

// Asking for the review ends the call. Leaving it open left the input live
// under a review that no longer described the conversation, with no way to
// regenerate it.
assert.ok(
  /setReview\(out\.payload\.debrief\);[\s\S]{0,400}setEnded\(true\)/.test(callSource),
  "a successful review must end the call, or the rep keeps talking to a stale review",
);

// A retry button alone was not enough. A rep who typed again instead of
// retrying built a different transcript, which replaced the one key that could
// collect the queued reply, and orphaned the stalled turn anyway. The pending
// turn has to resolve before the call can move.
assert.ok(
  /\|\| retryable\) return;/.test(callSource),
  "send must refuse while a turn is waiting to be retried, or the retry it just added is bypassable",
);
// Anchored to the TEXTAREA. The loose version matched anywhere, and once the
// review button gained the same guard it passed with the textarea's deleted:
// a check that any one of several places has a property proves nothing about
// the place that matters.
assert.ok(
  /<textarea[\s\S]{0,900}disabled=\{busy \|\| Boolean\(retryable\)\}/.test(callSource),
  "the TEXTAREA must be disabled while a turn is pending, so the only way forward is the retry",
);

// Round 3, and that one was a REGRESSION I introduced. Locking on ANY failure
// meant a terminal error, a 500 or a call already past its turn cap, disabled
// the input forever with no queued reply to collect and no way to continue or
// to abandon. Worse than the bug it was fixing. Only a genuinely pending turn
// locks the call.
assert.ok(
  /reason === "owner_thinking"/.test(callSource),
  "only a genuinely pending turn may lock the call: a terminal failure has nothing to protect",
);

// Rounds 4 and 5. A terminal failure left the rep's line in the transcript
// while re-enabling the input, which POISONED the call: past the turn cap
// every later submission carried the same over-long transcript and was refused
// again, and an unusable reply produced two rep turns in a row. Round 5 found
// the identical defect in the RETRY path, because send and retry each
// implemented these transitions separately.
//
// The fix is one handler used by both. That is what these assertions pin: not
// that the rollback exists somewhere, but that neither path has its own copy
// of the logic to drift.
assert.ok(
  /const turnFailed = useCallback/.test(callSource),
  "there must be ONE handler for a turn that produced no answer, or the two paths drift apart again",
);
assert.ok(
  /turnFailed\(out\.reason, next\)/.test(callSource),
  "send must delegate its failure handling",
);
assert.ok(
  /turnFailed\(out\.reason, retryable\)/.test(callSource),
  "retry must delegate to the SAME handler: a terminal failure there poisons the call exactly as it did in send",
);
assert.ok(
  /setTranscript\(pending\.slice\(0, -1\)\)/.test(callSource),
  "a terminal failure must roll the unanswered rep turn back out of the transcript",
);
assert.ok(
  /setTyped\(last\?\.text \?\? ""\)/.test(callSource),
  "and hand the rep their words back, which is what makes trying again literally possible",
);

// The review button is the other door to the same bypass: reviewing a
// transcript that ends on an unanswered line clears the retry and orphans the
// queued reply.
assert.ok(
  /disabled=\{busy \|\| Boolean\(retryable\)\}[\s\S]{0,60}onClick=\{getReview\}/.test(callSource),
  "review must be disabled while a turn is pending, or it bypasses the lock by another button",
);

console.log("training-roleplay: a stalled turn is retryable and a review ends the call OK");

console.log("training-roleplay: ALL OK");
