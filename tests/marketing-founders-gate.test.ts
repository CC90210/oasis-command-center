/**
 * The founders gate is the only thing standing between SunBiz and the founders
 * portal. These assertions exist so a future refactor cannot quietly open it.
 *
 * The specific bug being guarded against: gating on `isAdmin` instead of tenant
 * identity. `isAdmin` is per-tenant, so every SunBiz owner would have passed.
 *
 * Run: npx tsx tests/marketing-founders-gate.test.ts
 */
import assert from "node:assert/strict";
// Imported from the PURE module, not from lib/founders/gate.ts.
// That wrapper needs a session and drags in the server chain; the security
// decision itself must stay testable in isolation.
import { isFounderTenant, parseFoundersAllowlist } from "../lib/founders-marketing-core";

const FOUNDER = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SUNBIZ = "11111111-2222-3333-4444-555555555555";

// ── the core property ────────────────────────────────────────────────
assert.equal(isFounderTenant(FOUNDER, [FOUNDER]), true, "founder tenant is allowed");
assert.equal(isFounderTenant(SUNBIZ, [FOUNDER]), false, "SunBiz tenant is refused");

// ── fail closed: an empty allowlist allows NOBODY ────────────────────
// If FOUNDERS_TENANT_IDS is unset in Vercel, the safe state is a 404 for
// everyone, not an open door. This is the single most important assertion here.
assert.equal(isFounderTenant(FOUNDER, []), false, "empty allowlist admits nobody");
assert.equal(isFounderTenant(SUNBIZ, []), false, "empty allowlist admits nobody, again");

// ── falsy / malformed tenant ids are never admitted ──────────────────
for (const bad of [null, undefined, "", "   "]) {
  assert.equal(
    isFounderTenant(bad, [FOUNDER, ""]),
    false,
    `refuses tenant id ${JSON.stringify(bad)} even when the allowlist has a blank entry`,
  );
}

// A blank entry in the allowlist must not become a wildcard that matches a
// blank tenant_id. Both sides are guarded.
assert.equal(isFounderTenant("", [""]), false, "blank never matches blank");

// ── whitespace tolerance, because the Vercel UI invites it ───────────
assert.equal(isFounderTenant(FOUNDER, [` ${FOUNDER} `]), true, "allowlist entry is trimmed");
assert.equal(isFounderTenant(` ${FOUNDER} `, [FOUNDER]), true, "tenant id is trimmed");

// ── exact match only: no prefix, suffix or case coercion ─────────────
assert.equal(isFounderTenant(FOUNDER.slice(0, -1), [FOUNDER]), false, "prefix does not match");
assert.equal(isFounderTenant(FOUNDER + "x", [FOUNDER]), false, "suffix does not match");
assert.equal(
  isFounderTenant(FOUNDER.toUpperCase(), [FOUNDER]),
  false,
  "case is not coerced — a uuid is compared as stored, not normalised",
);

// ── multi-founder: Adon and CC may be on separate tenants ────────────
const CC = "99999999-8888-7777-6666-555555555555";
assert.equal(isFounderTenant(CC, [FOUNDER, CC]), true, "second founder tenant allowed");
assert.equal(isFounderTenant(SUNBIZ, [FOUNDER, CC]), false, "third party still refused");

// ── allowlist parsing ────────────────────────────────────────────────
assert.deepEqual(parseFoundersAllowlist(undefined), [], "unset env parses to empty");
assert.deepEqual(parseFoundersAllowlist(""), [], "empty env parses to empty");
assert.deepEqual(parseFoundersAllowlist("   "), [], "whitespace-only env parses to empty");
assert.deepEqual(parseFoundersAllowlist(FOUNDER), [FOUNDER], "single id");
assert.deepEqual(
  parseFoundersAllowlist(`${FOUNDER},${CC}`),
  [FOUNDER, CC],
  "comma separated",
);
assert.deepEqual(
  parseFoundersAllowlist(` ${FOUNDER} , ${CC} , `),
  [FOUNDER, CC],
  "trailing comma and padding do not produce blank entries",
);

// A stray comma must not widen the allowlist with an empty string that could
// then match a blank tenant_id.
assert.deepEqual(parseFoundersAllowlist(",,,"), [], "only commas parses to empty");

// ── the composed real-world path ─────────────────────────────────────
const parsed = parseFoundersAllowlist(` ${FOUNDER}, `);
assert.equal(isFounderTenant(FOUNDER, parsed), true, "parse + check admits the founder");
assert.equal(isFounderTenant(SUNBIZ, parsed), false, "parse + check refuses SunBiz");

console.log("marketing-founders-gate: all assertions passed");
