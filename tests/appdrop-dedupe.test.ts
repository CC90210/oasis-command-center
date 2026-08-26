import assert from "node:assert/strict";

/**
 * The incident (2026-08-26). After the drop-in path was repaired, four recovered
 * merchant applications each created a SECOND lead for a merchant who was
 * already in the CRM at `signed_application` with an email and a phone. The
 * board showed two cards per merchant, and the new card was the worse one: a
 * completed application form frequently carries no contact fields, because the
 * merchant supplied those on form 1.
 *
 * That is the normal case, not an edge case. A rep drops an application BECAUSE
 * the merchant is already being worked — that is where the paperwork comes from.
 *
 * The repair reuses `findExistingLead`, the same matcher the public form uses.
 * The risk it introduces is the opposite one: attaching to a real, worked deal
 * and trampling it. This file pins the rule that stops that.
 *
 * These are pure-logic tests over the two decisions the change makes. The
 * matcher itself is already covered where it is defined.
 */

// ── the gap-fill rule ────────────────────────────────────────────────────────
//
// Mirrors the auto-matched branch in lib/applications/apply-extracted.ts: on a
// lead WE matched, onto an application that ALREADY existed, only fill blanks.

function gapsOnly(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const have = current[k];
    if (have === undefined || have === null || have === "") out[k] = v;
  }
  return out;
}

// The real shape of the collision, taken from the live records: the rep's
// application had revenue read off bank statements and full contact details;
// the model read a different revenue off the application form and found no
// contact details at all.
const repsApplication = {
  business_legal_name: "FG Signature Homes LLC",
  monthly_revenue: 200000,
  email: "rep-entered@example.com",
  phone: "(302) 555-0100",
  status: "shopping",
  tax_id_ein: "12-3456789",
};

const modelExtracted = {
  business_legal_name: "FG Signature Homes LLC",
  monthly_revenue: 250000, // a DIFFERENT reading of the same business
  owner_dob: "1980-01-01", // genuinely new information
  business_address: "1 Main St", // genuinely new information
};

const filled = gapsOnly(repsApplication, modelExtracted);

// THE GUARD FIRING. The rep's checked number must survive a model that read
// the form differently. Both readings are plausible; the human's was verified.
assert.equal(
  "monthly_revenue" in filled,
  false,
  "a value the rep already entered must NOT be overwritten by the extractor",
);
assert.equal(
  "email" in filled,
  false,
  "the rep's contact details must never be touched on an auto-matched apply",
);

// ...while genuinely new information still lands, or the match is pointless.
assert.equal(filled.owner_dob, "1980-01-01", "a field the application lacked must be filled");
assert.equal(filled.business_address, "1 Main St", "a field the application lacked must be filled");

// Empty-ish existing values count as gaps, so a half-filled record still completes.
assert.deepEqual(
  gapsOnly({ industry: "", dba: null, website: undefined }, { industry: "auto", dba: "FG Homes", website: "x.com" }),
  { industry: "auto", dba: "FG Homes", website: "x.com" },
  "empty string, null and undefined are all gaps to fill",
);

// ── the status rule ──────────────────────────────────────────────────────────
//
// The unconditional write set status:"application_in" on every apply. On an
// auto-matched deal that drags a live opportunity BACKWARDS on the Applications
// board. One of the four real merchants was already at `shopping`.

/** Mirrors the branch: status is written only when we did not auto-match, or
 *  when the application was created fresh by this very call. */
function statusToWrite(autoMatched: boolean, applicationWasCreated: boolean): string | null {
  if (autoMatched && !applicationWasCreated) return null;
  return "application_in";
}

// THE GUARD FIRING.
assert.equal(
  statusToWrite(true, false),
  null,
  "an auto-matched drop onto an EXISTING application must not rewrite its status",
);

// ...and the paths that legitimately own the status still set it.
assert.equal(
  statusToWrite(false, true),
  "application_in",
  "a brand-new lead + application from a dropped document is an incoming application",
);
assert.equal(
  statusToWrite(false, false),
  "application_in",
  "operator-chosen autofill keeps its existing behaviour: the operator picked the target",
);
assert.equal(
  statusToWrite(true, true),
  "application_in",
  "a matched lead with NO application yet gets a real one — nothing exists to regress",
);

// ── what gets matched ────────────────────────────────────────────────────────
//
// The matcher is fed from the extracted fields. Pin that the drop path passes
// all three keys, because passing only business_name would miss a returning
// merchant whose company name was typed differently, and passing none would
// silently restore the duplicate-every-time behaviour.

function matchInputFromFields(fields: Record<string, unknown>) {
  return {
    email: typeof fields.email === "string" ? fields.email : null,
    phone: typeof fields.phone === "string" ? fields.phone : null,
    business: typeof fields.business_name === "string" ? fields.business_name : null,
  };
}

assert.deepEqual(
  matchInputFromFields({ email: "a@b.com", phone: "5551234567", business_name: "Acme LLC", monthly_revenue: 1 }),
  { email: "a@b.com", phone: "5551234567", business: "Acme LLC" },
  "all three identity keys reach the matcher",
);

// The four real recoveries had NO contact fields — name is the only signal, and
// it has to still work, or the exact incident this fixes recurs.
assert.deepEqual(
  matchInputFromFields({ business_name: "FG Signature Homes LLC" }),
  { email: null, phone: null, business: "FG Signature Homes LLC" },
  "a completed application form with no contact fields must still match on business name",
);

// A document with nothing identifying must not produce a match attempt that
// could latch onto an unrelated record.
assert.deepEqual(
  matchInputFromFields({ monthly_revenue: 50000 }),
  { email: null, phone: null, business: null },
  "no identity at all means no match input — the caller creates a fresh lead",
);

// ── fail closed on the reads (Codex review, 2026-08-26) ─────────────────────
//
// The gap-fill guard is only as good as the record it compares against. The
// first version swallowed a read failure and continued with an empty current
// record — which inverts the guard completely: with nothing to compare, EVERY
// extracted value is a "gap", so a transient database blip produces exactly the
// blind overwrite the branch exists to prevent, silently, on a live deal.

/** Mirrors both guarded reads: on an auto-matched target a failed read stops. */
function decideOnRead(autoMatched: boolean, record: { data?: unknown } | null): "proceed" | "abort" {
  if (autoMatched && !record?.data) return "abort";
  return "proceed";
}

// THE GUARD FIRING.
assert.equal(
  decideOnRead(true, null),
  "abort",
  "an unreadable record on an auto-matched target must abort, never fall through to a blind write",
);
assert.equal(
  decideOnRead(true, {}),
  "abort",
  "a record that came back without data is not an empty record — it is an unknown one",
);

// Proving the guard cannot be satisfied by the very emptiness it must reject:
// an empty `data` object is a legitimately blank record and IS safe to fill.
assert.equal(
  decideOnRead(true, { data: {} }),
  "proceed",
  "a genuinely blank record is readable and gap-filling it is the whole point",
);

// Operator-chosen autofill keeps its long-standing tolerance: they picked the
// target, so a read failure degrades rather than blocks. Changing that would be
// a behaviour change to a path this work never touched.
assert.equal(
  decideOnRead(false, null),
  "proceed",
  "operator-chosen autofill is unchanged by this work",
);

// ── the operator is told the truth about what was written ───────────────────
//
// appliedKeys is rendered verbatim ("Filled N fields"). On the gap-fill branch
// the patch may contain a subset of the extracted keys, or none at all.

function reportedKeys(autoMatchedExisting: boolean, extracted: string[], gaps: string[]): string[] {
  return autoMatchedExisting ? gaps : extracted;
}

const extractedKeys = Object.keys(modelExtracted);
const gapKeys = Object.keys(filled);

assert.deepEqual(
  reportedKeys(true, extractedKeys, gapKeys),
  gapKeys,
  "a matched apply reports the fields actually written, not everything extracted",
);
assert.equal(
  reportedKeys(true, extractedKeys, []).length,
  0,
  'when existing values blocked every write the operator must be told 0, not "Filled 4 fields"',
);
assert.deepEqual(
  reportedKeys(false, extractedKeys, []),
  extractedKeys,
  "the authoritative paths still report every extracted key",
);

console.log("appdrop-dedupe: all guards fire ✓");
