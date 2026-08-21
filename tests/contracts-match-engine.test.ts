/**
 * The contracts must state the rates the engine actually pays.
 *
 * This is the highest-stakes consistency check in the repo. A contract quoting
 * a number the payout engine does not use is not a documentation bug — it is a
 * promise the company breaks, in writing, to someone who signed it. And it is
 * the kind of drift nobody notices for months, because the contract lives in a
 * Google Doc and the engine lives in TypeScript.
 *
 * So: render every agreement, then assert every rate that appears in it is the
 * engine's own constant. If someone edits a rate in one place, this fails.
 */
import assert from "node:assert/strict";
import {
  COMPANY_TRACK_BPS,
  MANAGER_OVERRIDE_BPS,
  MAX_HUMAN_PAYOUT_BPS,
  PRICE_BOOK,
  SELF_TRACK_BPS,
  SPECIALIST_SPLIT_FLOOR_CENTS,
} from "../lib/website-sales-comp";
import { CLAWBACK_WINDOW_DAYS } from "../lib/turso-rpc-shim";
import { renderContract, type ContractRole } from "../lib/contracts/templates";

const VARS = {
  contractorName: "Jordan Example",
  contractorEmail: "jordan@example.com",
  effectiveDate: "2026-09-01",
};

const ROLES: ContractRole[] = ["opener", "closer", "manager", "builder"];
const rendered = Object.fromEntries(ROLES.map((r) => [r, renderContract(r, VARS)])) as Record<ContractRole, string>;

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/* ── 1. Every agreement renders, is substantial, and is signable. ──────────*/
for (const role of ROLES) {
  const doc = rendered[role];
  assert.ok(doc.length > 1_500, `${role} agreement is suspiciously short (${doc.length} chars)`);
  assert.ok(doc.includes(VARS.contractorName), `${role}: the contractor's name must appear`);
  assert.ok(doc.includes(VARS.contractorEmail), `${role}: the contractor's email must appear`);
  assert.ok(doc.includes(VARS.effectiveDate), `${role}: the effective date must appear`);
  assert.equal(
    (doc.match(/Signature: _+/g) || []).length, 2,
    `${role}: two signature lines — the company and the contractor`,
  );
  // No unresolved template holes reaching a document someone signs.
  assert.equal(doc.includes("undefined"), false, `${role}: rendered 'undefined' into a contract`);
  assert.equal(doc.includes("NaN"), false, `${role}: rendered 'NaN' into a contract`);
  assert.equal(/\$\{/.test(doc), false, `${role}: an unexpanded template literal reached the output`);
  assert.equal(/\bTBD\b|\bTODO\b|XXX/.test(doc), false, `${role}: a placeholder reached the output`);
}

/* ── 2. Section numbering is contiguous. ───────────────────────────────────
 * An earlier draft assembled the builder's boilerplate by string-splitting
 * rendered Markdown. It produced duplicate and skipped section numbers, which
 * in a signed document is worse than ugly: clauses get cited by number. */
for (const role of ROLES) {
  const nums = [...rendered[role].matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
  assert.ok(nums.length >= 8, `${role}: expected a full clause set, saw ${nums.length}`);
  assert.deepEqual(
    nums,
    Array.from({ length: nums.length }, (_, i) => i + 1),
    `${role}: sections must run 1..n with no gaps or repeats — got ${nums.join(",")}`,
  );
}

/* ── 3. THE RATES. Each agreement must quote the engine's own numbers. ─────*/
assert.ok(rendered.opener.includes(pct(COMPANY_TRACK_BPS.opener)), "opener agreement states the company-sourced opener rate");
assert.ok(rendered.opener.includes(pct(SELF_TRACK_BPS.opener)), "opener agreement states the self-sourced opener rate");

assert.ok(rendered.closer.includes(pct(COMPANY_TRACK_BPS.closer)), "closer agreement states the company-sourced closer rate");
assert.ok(rendered.closer.includes(pct(COMPANY_TRACK_BPS.full_stack)), "closer agreement states the company full-stack rate");
assert.ok(rendered.closer.includes(pct(SELF_TRACK_BPS.open_close)), "closer agreement states the self open+close rate");
assert.ok(rendered.closer.includes(pct(SELF_TRACK_BPS.full_stack)), "closer agreement states the self full-stack rate");

assert.ok(rendered.manager.includes(pct(MANAGER_OVERRIDE_BPS)), "manager agreement states the override rate");
assert.ok(
  /retains/i.test(rendered.manager),
  "the manager agreement must say the override is on what the company RETAINS — 20% of gross is a different, ruinous promise",
);

/* Build fees are dollars, and every tier must be listed. */
for (const [id, tier] of Object.entries(PRICE_BOOK)) {
  const fee = `$${(tier.builderFeeCents / 100).toLocaleString("en-CA")}`;
  assert.ok(
    rendered.builder.includes(fee),
    `builder agreement must quote the ${id} build fee (${fee})`,
  );
}

/* ── 4. Terms that protect BOTH sides must appear in all four. ─────────────*/
for (const role of ROLES) {
  const doc = rendered[role];
  assert.ok(/cash collected/i.test(doc), `${role}: must state commission is on cash collected`);
  assert.ok(doc.includes(pct(MAX_HUMAN_PAYOUT_BPS)), `${role}: must state the payout ceiling`);
  assert.ok(/independent contractor/i.test(doc), `${role}: must state contractor status`);
  assert.ok(/Governing law/i.test(doc), `${role}: must name a governing law`);
  assert.ok(/terminat/i.test(doc), `${role}: must have a termination clause`);
}

/* The clawback window must be stated identically wherever it appears — a
 * contract saying 30 days against an engine enforcing 60 is unenforceable. */
for (const role of ["opener", "closer", "manager"] as ContractRole[]) {
  assert.ok(
    rendered[role].includes(`${CLAWBACK_WINDOW_DAYS} days`),
    `${role}: the clawback window must match the ledger's CLAWBACK_WINDOW_DAYS`,
  );
}
assert.ok(
  // [\s\S] not `.` — the clause wraps across a line in the rendered Markdown,
  // and a dot would silently fail to see it.
  /not subject to the [\s\S]*?clawback/i.test(rendered.builder),
  "the builder agreement must say build fees are NOT clawed back — they built the site, a refund does not un-build it",
);

/* ── 5. The small-deal rule must be disclosed, not buried. ─────────────────
 * A rep who finds out only after closing a $500 deal that it pays differently
 * has been ambushed. */
const floorDollars = `$${(SPECIALIST_SPLIT_FLOOR_CENTS / 100).toLocaleString("en-CA")}`;
for (const role of ["opener", "closer", "manager"] as ContractRole[]) {
  assert.ok(
    rendered[role].includes(floorDollars),
    `${role}: must disclose the ${floorDollars} split threshold`,
  );
  assert.ok(
    /still commissionable in full|not excluded/i.test(rendered[role]),
    `${role}: must make clear small deals still pay — the threshold changes WHO works it, not whether it counts`,
  );
}

/* ── 6. A rate the engine does not use must never appear. ──────────────────
 * The regression this whole file exists to catch: someone edits a percentage
 * in the contract prose and nothing else notices. */
const engineRates = new Set(
  [
    ...Object.values(COMPANY_TRACK_BPS),
    ...Object.values(SELF_TRACK_BPS),
    MANAGER_OVERRIDE_BPS,
    MAX_HUMAN_PAYOUT_BPS,
    5_000, // UPSELL_SHARE_BPS — the share of overage
    500, 1_000, // the below-book / below-floor step-downs, quoted as points
    200, // accelerator bands
  ].map((b) => pct(b)),
);
// Percentage-point phrasing ("5 percentage points") is legitimate prose, so
// only bare percentages are checked.
for (const role of ROLES) {
  const quoted = [...rendered[role].matchAll(/\*\*(\d+(?:\.\d+)?%)\*\*/g)].map((m) => m[1]);
  for (const q of quoted) {
    assert.ok(
      engineRates.has(q),
      `${role}: quotes ${q}, which is not a rate lib/website-sales-comp.ts pays. ` +
        `Either the engine changed and the contract did not, or someone typed a number into a contract.`,
    );
  }
}

console.log(
  `contracts-match-engine: OK — ${ROLES.length} agreements, every quoted rate traced to the engine, ` +
    `clawback ${CLAWBACK_WINDOW_DAYS}d consistent, ${Object.keys(PRICE_BOOK).length} tiers disclosed`,
);
