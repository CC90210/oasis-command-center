/**
 * tests/resolve-send-number.test.ts — text the number that WORKS, not the one
 * on file, and check consent against the number actually texted.
 *
 * THE GAP (measured 2026-08-21). The phone lookup writes what it finds into
 * `phone_lookup_candidates` and deliberately does not overwrite `data.phone` —
 * that field is the merchant's own record of themselves and clobbering it would
 * destroy it. Correct, and it left the chain one link short:
 *
 *   phone:      6619789433                    <- the office landline
 *   candidates: +12094831972 (Wireless), ...  <- the mobile just found
 *
 * Everything downstream keyed on `phone`, so a lookup could succeed, find a
 * reachable mobile, and the lead stayed held anyway. An entire night of lookups
 * would have produced nothing usable.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const exec = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
const store = readFileSync(new URL("../lib/sms/destination-health.ts", import.meta.url), "utf8");

// ── The send path resolves a number rather than reading the stored one ────
assert.ok(
  exec.includes("const resolved = await resolveSendNumber(row.tenant_id, data);"),
  "dispatch must ask which number to text, not assume data.phone",
);
assert.ok(
  !/const phone = typeof data\.phone === "string"/.test(exec),
  "the old direct read of data.phone must be gone, or the lookup result is ignored",
);

// ── EVERY GATE USES THE SAME NUMBER ──────────────────────────────────────
// Checking consent against one number and texting another is how a merchant who
// opted out gets texted anyway. All of these must take `phone`, which is the
// RESOLVED value.
{
  for (const [call, why] of [
    ["checkPhoneOptOut(row.tenant_id, phone)", "opt-out"],
    ["isTextable(row.tenant_id, phone)", "reachability"],
    ["checkTcpaWindow(phone)", "TCPA quiet hours"],
  ] as const) {
    assert.ok(exec.includes(call), `${why} must be checked against the resolved number`);
  }
  // And the resolution must happen BEFORE the first gate.
  const resolveIdx = exec.indexOf("const resolved = await resolveSendNumber");
  const optOutIdx = exec.indexOf("checkPhoneOptOut(row.tenant_id, phone)");
  assert.ok(resolveIdx > 0 && optOutIdx > resolveIdx, "resolution must precede the consent check");
}

// ── Preference order, and the refusals ───────────────────────────────────
{
  // Delivered beats looked-up beats unknown — the shared helper owns this and
  // must be the thing called, not a second copy of the rule.
  assert.ok(store.includes("chooseTextableNumber(pool, verdicts)"), "must reuse the existing preference helper");
  assert.ok(
    store.includes("wirelessCandidates(data.phone_lookup_candidates)"),
    "looked-up wireless numbers must be considered as send targets",
  );
  // A landline that IS the stored number must not be silently re-offered: the
  // helper excludes explicitly-untextable numbers.
  assert.ok(store.includes("if (res.error) return null;"), "an unreadable health table must not promote an unvetted number");
}

// ── VERIFIED-ONLY narrows the POOL, not just the final answer ────────────
// chooseTextableNumber only excludes numbers proven untextable. Under
// verified-only a candidate with no verdict row at all is equally unacceptable,
// and that is the state the whole 347-lead cohort is in — so the stricter
// filter is applied to the pool rather than by loosening the shared helper for
// everyone.
{
  assert.ok(
    /const pool = verifiedOnly\(\)/.test(store),
    "verified-only must filter the candidate pool",
  );
  // An empty pool yields no number — but as a HOLD, not a bare null. See
  // hold-not-skip.test.ts: returning null for both "no number at all" and
  // "nothing verified yet" is what burned 190 rows over two days.
  assert.ok(
    store.includes('if (pool.length === 0) return { phone: null, source: null, hold: "awaiting_verification" };'),
    "an empty pool must hold, never fall back to the stored number",
  );
}

// ── The stored number is still preferred when it is the good one ─────────
// This is not "always use the looked-up number". A merchant who gave us their
// mobile must keep receiving texts on it.
assert.ok(
  store.includes('candidates.push({ phone: stored, source: "provided" })'),
  "the stored number remains a candidate",
);
assert.ok(
  store.includes("if (forms.has(w)) continue;"),
  "and is not duplicated when the lookup returns the same number",
);

console.log("resolve-send-number.test.ts — all assertions passed");
