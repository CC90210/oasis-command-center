import assert from "node:assert/strict";
import {
  normalizeLeadSource,
  isLeadSourceChannel,
  readLeadSource,
  adoptLeadSource,
  withLeadSourceParam,
  describeSubmissionLink,
  recordSubmissionChannel,
  LEAD_SOURCE_KEY,
  LEAD_SOURCE_AT_KEY,
  LEAD_SOURCE_ORDER,
  LEAD_SOURCE_CHANNELS,
  LAST_SUBMITTED_VIA_KEY,
  LAST_SUBMITTED_LINK_KEY,
} from "../lib/forms/lead-source";

// The contract this file pins:
//   1. A missing or malformed ?source= NEVER rejects a submission. It becomes
//      "unknown" — the spec's required failure behavior.
//   2. Origination is FIRST TOUCH. Retries and duplicate delivery converge.
//   3. The normalizer is a total function over hostile input.

const NOW = "2026-08-24T15:00:00.000Z";

// ── 1. happy path ────────────────────────────────────────────────────────────

assert.equal(normalizeLeadSource("text"), "text");
assert.equal(normalizeLeadSource("dial"), "dial");
assert.equal(normalizeLeadSource("TEXT"), "text", "case must not matter in a pasted link");
assert.equal(normalizeLeadSource("  Dial  "), "dial", "surrounding whitespace must not matter");
assert.equal(normalizeLeadSource("sms"), "text", "sms is the same channel as text");
assert.equal(normalizeLeadSource("call"), "dial", "call is the same channel as dial");
assert.equal(normalizeLeadSource("phone"), "dial");

// ── 2. failure cases — degrade, never throw, never reject ────────────────────
// Each of these is a real way a link gets mangled in the wild: stripped query
// string, a link shortener eating params, a typo, a copy-paste that lost the
// value. Every one must yield a countable bucket.

// Every one of these must land on EXACTLY "unknown". The original version of
// this loop accepted `out === "text" || out === "unknown"`, which meant a
// regression in trim handling would still pass — the assertion was weaker than
// it looked, which is the same class of bug it exists to catch.
// (CodeRabbit, PR #290.)
for (const bad of [
  undefined,
  null,
  "",
  "   ",
  "e-mail",
  "carrier-pigeon",
  "te xt",
  "text;dial",
  123,
  true,
  {},
  [],
  ["text"],
  () => "text",
  Symbol("text"),
  NaN,
  "x".repeat(5000), // oversized: bounded before lowercasing
]) {
  const out = normalizeLeadSource(bad as unknown);
  assert.equal(
    out,
    "unknown",
    `normalizeLeadSource(${String(bad).slice(0, 20)}) must be exactly "unknown", got ${out}`,
  );
  assert.equal(
    LEAD_SOURCE_ORDER.includes(out),
    true,
    "every result must be a canonical bucket the dashboard can count",
  );
}
assert.equal(normalizeLeadSource(undefined), "unknown", "a missing param is Unknown, not an error");
assert.equal(normalizeLeadSource("carrier-pigeon"), "unknown", "an unknown word is Unknown");

// Whitespace around a REAL value is trimmed, not rejected — asserted exactly so
// a trim regression fails here instead of silently degrading to Unknown.
assert.equal(normalizeLeadSource("text "), "text", "a trailing space must still resolve to text");
assert.equal(normalizeLeadSource(" dial"), "dial", "a leading space must still resolve to dial");
assert.equal(normalizeLeadSource("\tTEXT\n"), "text", "tabs and newlines trim too");

// ── 3. prototype pollution — the reason ALIASES is a Map ─────────────────────
// An object-literal lookup would return Object.prototype for "__proto__" and a
// function for "constructor"/"toString" — truthy values that could slip past a
// naive `?? "unknown"`.

for (const hostile of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
  assert.equal(
    normalizeLeadSource(hostile),
    "unknown",
    `${hostile} must not resolve through the prototype chain`,
  );
}

// ── 4. isLeadSourceChannel excludes "unknown" ────────────────────────────────
// "unknown" is a bucket, not a channel. Conflating them would make the
// first-touch rule below treat an untagged lead as already attributed.

assert.equal(isLeadSourceChannel("text"), true);
assert.equal(isLeadSourceChannel("dial"), true);
assert.equal(isLeadSourceChannel("unknown"), false, "unknown is a bucket, never a channel");
assert.equal(isLeadSourceChannel("sms"), false, "an alias is not itself canonical");
assert.equal(isLeadSourceChannel(undefined), false);
assert.equal(isLeadSourceChannel(null), false);

// ── 5. read side tolerates every legacy lead shape ───────────────────────────

assert.equal(readLeadSource(null), "unknown");
assert.equal(readLeadSource(undefined), "unknown");
assert.equal(readLeadSource({}), "unknown", "a pre-migration lead has no key at all");
assert.equal(readLeadSource({ [LEAD_SOURCE_KEY]: null }), "unknown");
assert.equal(readLeadSource({ [LEAD_SOURCE_KEY]: 7 }), "unknown");
assert.equal(readLeadSource({ [LEAD_SOURCE_KEY]: "text" }), "text");
assert.equal(readLeadSource({ [LEAD_SOURCE_KEY]: "DIAL" }), "dial");
// The occupied `source` enum must NOT be mistaken for origination.
assert.equal(
  readLeadSource({ source: "public_form" }),
  "unknown",
  "data.source is the channel-of-record enum and must never be read as origination",
);

// ── 6. FIRST TOUCH WINS — the idempotency boundary ───────────────────────────
// This is the property that makes the endpoint safe under retries and duplicate
// delivery. Same input twice => same stored value, and no second write.

const attributed = { [LEAD_SOURCE_KEY]: "text", [LEAD_SOURCE_AT_KEY]: "2026-08-01T00:00:00.000Z" };

assert.equal(
  adoptLeadSource(attributed, "text", NOW),
  null,
  "replaying the SAME submission must produce no write",
);
assert.equal(
  adoptLeadSource(attributed, "dial", NOW),
  null,
  "a later Dial touch must NOT steal credit from the original Text attribution",
);
assert.equal(
  adoptLeadSource(attributed, undefined, NOW),
  null,
  "an untagged re-submission must not blank an existing attribution",
);

// A lead with no attribution yet CAN be filled in — a correction, not a steal.
assert.deepEqual(
  adoptLeadSource({}, "dial", NOW),
  { [LEAD_SOURCE_KEY]: "dial", [LEAD_SOURCE_AT_KEY]: NOW },
  "an unattributed lead adopts the first real channel it sees",
);
assert.deepEqual(
  adoptLeadSource({ [LEAD_SOURCE_KEY]: "unknown" }, "text", NOW),
  { [LEAD_SOURCE_KEY]: "text", [LEAD_SOURCE_AT_KEY]: NOW },
  "upgrading OFF unknown is allowed — that is filling a gap, not reassigning",
);
assert.equal(
  adoptLeadSource({}, "carrier-pigeon", NOW),
  null,
  "a garbage tag must never overwrite; it is not a real channel",
);
assert.equal(
  adoptLeadSource({ [LEAD_SOURCE_KEY]: "text" }, "sms", NOW),
  null,
  "an ALIAS of the value already stored is still the same channel — no write",
);

// Convergence: applying the adoption twice is a fixed point.
{
  const lead: Record<string, unknown> = {};
  const first = adoptLeadSource(lead, "text", NOW);
  Object.assign(lead, first);
  const second = adoptLeadSource(lead, "text", "2026-09-01T00:00:00.000Z");
  assert.equal(second, null, "second delivery is a no-op");
  assert.equal(lead[LEAD_SOURCE_KEY], "text");
  assert.equal(lead[LEAD_SOURCE_AT_KEY], NOW, "the ORIGINAL timestamp survives the replay");
}

// ── 7. link builder composes with ?rep= and encodes once ─────────────────────

assert.equal(
  withLeadSourceParam("https://x.test/f/sun/initial-lead-capture?rep=jordan", "text"),
  "https://x.test/f/sun/initial-lead-capture?rep=jordan&source=text",
  "the channel tag must not clobber the existing rep routing",
);
assert.equal(
  withLeadSourceParam("https://x.test/f/sun/initial-lead-capture", "dial"),
  "https://x.test/f/sun/initial-lead-capture?source=dial",
);
assert.equal(
  withLeadSourceParam("https://x.test/f/sun/x?source=dial", "text"),
  "https://x.test/f/sun/x?source=text",
  "re-tagging replaces rather than appending a duplicate param",
);
// Relative base (SSR before origin is known) still keeps the tag.
assert.equal(withLeadSourceParam("/f/sun/x?rep=alex", "text"), "/f/sun/x?rep=alex&source=text");

// Round trip: whatever the builder emits must survive the normalizer.
for (const channel of ["text", "dial"] as const) {
  const url = withLeadSourceParam("https://x.test/f/sun/x?rep=matt", channel);
  const parsed = new URL(url).searchParams.get("source");
  assert.equal(normalizeLeadSource(parsed), channel, "builder output must round-trip");
}

console.log("lead-source-attribution: all assertions passed");


// ============================================================================
// EMAIL CHANNEL (added 2026-08-24) + per-submission channel
// ============================================================================

assert.equal(normalizeLeadSource("email"), "email");
assert.equal(normalizeLeadSource("EMAIL"), "email");
assert.equal(normalizeLeadSource("mail"), "email");
assert.equal(normalizeLeadSource("drip"), "email", "drip mail is the email channel");
assert.equal(isLeadSourceChannel("email"), true);
assert.deepEqual(
  [...LEAD_SOURCE_CHANNELS],
  ["text", "dial", "email"],
  "three real channels; Unknown is not one of them",
);
assert.equal(
  LEAD_SOURCE_ORDER.length,
  LEAD_SOURCE_CHANNELS.length + 1,
  "the render order is every channel plus exactly one Unknown bucket",
);
assert.equal(
  LEAD_SOURCE_ORDER[LEAD_SOURCE_ORDER.length - 1],
  "unknown",
  "Unknown must stay last so the chart never leads with it",
);

// First-touch-wins holds across the new channel too.
assert.equal(
  adoptLeadSource({ [LEAD_SOURCE_KEY]: "text" }, "email", NOW),
  null,
  "an emailed application must not steal origination from the original text",
);
assert.deepEqual(
  adoptLeadSource({}, "email", NOW),
  { [LEAD_SOURCE_KEY]: "email", [LEAD_SOURCE_AT_KEY]: NOW },
  "an unattributed lead adopts email like any other channel",
);

// ---- describeSubmissionLink: the token MUST NOT survive into an email ------
// The full-application URL is a bearer credential for that lead's form. This is
// the guard that keeps it out of the operator notification.

{
  const signed =
    "https://oasisai.work/f/sun/full-application/eyJhbGciOiJIUzI1NiJ9.SECRETTOKEN.sig";
  const out = describeSubmissionLink(signed, "email");
  assert.equal(out.includes("SECRETTOKEN"), false, "the signed token must be redacted");
  assert.equal(out.includes("[signed-link]"), true, "and replaced with a visible marker");
  assert.equal(out.startsWith("Email"), true, "the channel leads, because that is the answer");
  assert.equal(out.includes("/f/sun/full-application/"), true, "the form is still identifiable");
}

{
  // An anonymous share link has no token segment and must survive intact.
  const share = "https://oasisai.work/f/sun/initial-lead-capture?rep=jordan&source=text";
  const out = describeSubmissionLink(share, "text");
  assert.equal(out.includes("rep=jordan"), true, "a tokenless link is not mangled");
  assert.equal(out.includes("[signed-link]"), false, "nothing to redact here");
}

assert.equal(
  describeSubmissionLink(null, "unknown"),
  "Unknown (no link recorded)",
  "a missing link degrades to honest copy, never a crash",
);
assert.equal(describeSubmissionLink("", "dial"), "Dial (no link recorded)");
assert.equal(
  describeSubmissionLink("not a url at all", "email").includes("not a url at all"),
  true,
  "a malformed URL still reports, it does not throw",
);
{
  // Oversized input is bounded before it reaches an inbox.
  const huge = "https://x.test/f/sun/x/" + "A".repeat(5000);
  assert.equal(describeSubmissionLink(huge, "email").length < 600, true, "output is bounded");
}

// ---- recordSubmissionChannel: LATEST WINS, unlike origination -------------

{
  const patch = recordSubmissionChannel(
    "email",
    "https://oasisai.work/f/sun/full-application/TOKEN123",
    NOW,
  );
  assert.equal(patch?.[LAST_SUBMITTED_VIA_KEY], "email");
  assert.equal(
    patch?.[LAST_SUBMITTED_LINK_KEY].includes("TOKEN123"),
    false,
    "the stored description is redacted too, not only the emailed one",
  );
}

assert.equal(
  recordSubmissionChannel(undefined, undefined, NOW),
  null,
  "nothing to record means no write",
);
assert.equal(
  recordSubmissionChannel("carrier-pigeon", undefined, NOW),
  null,
  "an unrecognized channel with no link is not worth a write",
);
{
  // A link with no channel still records: knowing WHICH form beats knowing nothing.
  const patch = recordSubmissionChannel(undefined, "https://x.test/f/sun/full-application/T", NOW);
  assert.equal(patch?.[LAST_SUBMITTED_VIA_KEY], "unknown");
}
{
  // Latest wins — the opposite of adoptLeadSource, on purpose.
  const first = recordSubmissionChannel("text", "https://x.test/f/sun/a", NOW);
  const second = recordSubmissionChannel("email", "https://x.test/f/sun/b", "2026-09-01T00:00:00.000Z");
  assert.equal(first?.[LAST_SUBMITTED_VIA_KEY], "text");
  assert.equal(
    second?.[LAST_SUBMITTED_VIA_KEY],
    "email",
    "a later submission through a different channel MUST overwrite - this axis is not first-touch",
  );
}

// The two axes are independent: origination text + this-application email is a
// real, expected combination and neither value may clobber the other.
{
  const lead: Record<string, unknown> = { [LEAD_SOURCE_KEY]: "text" };
  Object.assign(lead, recordSubmissionChannel("email", "https://x.test/f/sun/x", NOW));
  assert.equal(readLeadSource(lead), "text", "origination survives a later emailed application");
  assert.equal(lead[LAST_SUBMITTED_VIA_KEY], "email", "and the submission channel is recorded");
}

console.log("lead-source email channel + submission channel: all assertions passed");
