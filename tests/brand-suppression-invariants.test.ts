/**
 * tests/brand-suppression-invariants.test.ts — the guards that keep a two-brand
 * outreach operation legal.
 *
 * Running two real companies that contact the same merchant in sequence is
 * ordinary. What would NOT be ordinary is switching brands to keep mailing
 * someone who asked to stop. The line between those two is enforced by exactly
 * three properties, and all three are easy to break by accident during an
 * unrelated refactor:
 *
 *   1. Suppression is keyed on (tenant_id, email) and IGNORES brand.
 *   2. Both brands live on ONE tenant, so (1) actually covers both.
 *   3. The routing rule refuses to switch an opted-out or suppressed lead.
 *
 * These are STRUCTURAL assertions over source text on purpose. The failure they
 * prevent is not a wrong return value from a function under test — it is
 * somebody adding `.eq("brand", ...)` to a query while "scoping things properly",
 * which no unit test of the current code would ever notice.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// 1. Suppression enforcement must be tenant-keyed and brand-blind.
// ---------------------------------------------------------------------------
const queries = readFileSync("lib/lead-interactions-queries.ts", "utf8");
const start = queries.indexOf("export async function checkEmailSuppressed");
assert.ok(start >= 0, "checkEmailSuppressed must exist — it is the opt-out enforcement point");

// Bound the slice to the function body so we do not read a neighbouring query.
const bodyEnd = queries.indexOf("\nexport ", start + 10);
const suppressBody = queries.slice(start, bodyEnd > start ? bodyEnd : start + 2000);

assert.ok(
  suppressBody.includes('.eq("tenant_id"'),
  "suppression must be tenant-scoped",
);
assert.ok(
  !/\.eq\(\s*["'`]brand["'`]/.test(suppressBody) && !/\.eq\(\s*["'`]sending_brand["'`]/.test(suppressBody),
  "SUPPRESSION MUST NOT FILTER BY BRAND. An opt-out to either company has to " +
    "stop both, or switching brands becomes a way to keep mailing someone who " +
    "asked to stop.",
);
assert.ok(
  suppressBody.includes("checkFailed"),
  "suppression must report a failed check so the caller can fail closed rather than send",
);

// ---------------------------------------------------------------------------
// 2. Both brands share one tenant. The brand registry must not carry a
//    per-brand tenant id, because that is how (1) would silently stop covering
//    both brands.
// ---------------------------------------------------------------------------
const brands = readFileSync("lib/email/brands.ts", "utf8");
assert.ok(
  !/tenant_?[Ii]d/.test(brands),
  "the brand registry must NOT define a per-brand tenant. Both brands live on " +
    "one tenant so a single suppression row stops both.",
);

// ---------------------------------------------------------------------------
// 3. The routing rule refuses to switch an opted-out or suppressed lead, and
//    caps the switch count.
// ---------------------------------------------------------------------------
const routing = readFileSync("lib/drips/brand-routing.ts", "utf8");
assert.ok(routing.includes("opted_out"), "routing must refuse to switch an opted-out lead");
assert.ok(routing.includes("suppressed"), "routing must refuse to switch a suppressed lead");
assert.ok(routing.includes("already_switched"), "routing must cap the switch count");

// The opt-out checks must come BEFORE the silence maths, so no ordering change
// can let a long-silent opted-out lead through.
const optedOutAt = routing.indexOf("opted_out");
const silenceAt = routing.indexOf("silenceMs");
assert.ok(
  optedOutAt >= 0 && silenceAt >= 0 && optedOutAt < silenceAt,
  "the opt-out guard must be evaluated before any silence calculation",
);

// ---------------------------------------------------------------------------
// 4. The suppression BRAND (the tenant resolver on the opt-out WRITE path) must
//    not be derived from the sending brand. A value matching no tenant writes
//    tenant_id = NULL, which the enforcement query above can never match. That
//    exact failure already exists once in production.
// ---------------------------------------------------------------------------
const identity = readFileSync("lib/email/sending-identity.ts", "utf8");
const suppStart = identity.indexOf("export function suppressionBrand");
assert.ok(suppStart >= 0, "suppressionBrand must exist");
const suppEnd = identity.indexOf("\n}", suppStart);
const suppFn = identity.slice(suppStart, suppEnd);
assert.ok(
  !suppFn.includes("fromAddress") && !suppFn.includes("getBrand") && !suppFn.includes("brand)"),
  "suppressionBrand must NOT follow the sending brand — it resolves a TENANT on " +
    "the opt-out write path, and a value matching no tenant lands tenant_id = NULL",
);

console.log("brand-suppression-invariants.test.ts — all assertions passed ✓");
