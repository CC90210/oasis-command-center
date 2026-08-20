/**
 * tests/receipt-wire-account.test.ts — the reconciler must read each thread with
 * the account that CREATED it.
 *
 * THE OUTAGE THIS PINS (measured in production 2026-08-20). `reconcileReceipts`
 * hardcoded `service: "texttorrent"`, so every AI Follow-Up receipt was fetched
 * with the main SunBiz SID. A Legacy-parent thread is not visible to that SID,
 * so the read threw — and the catch around it deliberately does NOT spend a
 * check attempt, because for a transient 429 that would burn the evidence.
 *
 * For a PERMANENT account mismatch the same choice means the receipt is retried
 * forever and never resolves. All 15 AI-wire receipts sat at check_attempts=0
 * and carrier_status='unknown' from the day the wire went live.
 *
 * Why that is an outage and not a reporting nit:
 *   1. 3 of the 11 Live Subs texts had FAILED at the carrier. Asked directly,
 *      TextTorrent said so. Nothing in our system did.
 *   2. smsSendAllowed() reads these same receipts. With no terminal receipt
 *      ever recorded, the breaker cannot open for the AI wire no matter how
 *      many sends die — so the protection added for exactly this wire was
 *      inert on it.
 *
 * A guard whose evidence never arrives is not a guard. This is the
 * verify-CONTRIBUTION rule: the receipt pipeline existing is not the same as
 * the receipt pipeline reaching this wire.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// From the PURE module: delivery-receipts.ts is "server-only" and cannot be
// imported here, which is exactly why the rule lives beside the other carrier
// rules rather than next to the I/O that uses it.
import { serviceForRepKey } from "../lib/sms/carrier-status";
import { AI_WIRE_REP_KEY, AI_WIRE_SERVICE } from "../lib/drips/ai-wire-core";

// ── The mapping itself ────────────────────────────────────────────────────
assert.equal(serviceForRepKey(AI_WIRE_REP_KEY), AI_WIRE_SERVICE,
  "an AI-wire receipt must be read with the Legacy parent's account");
assert.equal(serviceForRepKey("ai_followup"), "texttorrent_followup",
  "pinned literally too, so renaming the constant cannot silently re-point the wire");

// Every other wire keeps the historical account. These are real rep_keys seen
// in sms_delivery_receipts.
for (const rep of ["admin", "alex", "jordan", "", null, undefined, "unknown_future_rep"]) {
  assert.equal(serviceForRepKey(rep), "texttorrent",
    `${JSON.stringify(rep)} must resolve to the main SunBiz account`);
}

// ── It is actually WIRED IN, not merely exported ──────────────────────────
// The whole bug was a hardcoded literal sitting where this call belongs, so the
// assertion has to be about the call site, not the helper.
{
  const src = readFileSync(new URL("../lib/sms/delivery-receipts.ts", import.meta.url), "utf8");

  assert.ok(
    !/service:\s*"texttorrent",/.test(src),
    "THE BUG: a hardcoded service in the reconciler reads every wire with the main SID",
  );
  assert.ok(
    src.includes("service: group.service"),
    "the fetch must use the service resolved from the receipt's own rep_key",
  );
  assert.ok(
    src.includes("serviceForRepKey(r.rep_key)"),
    "and that service must be derived per receipt, not per run",
  );

  // rep_key has to be SELECTED or it arrives undefined and every receipt
  // silently resolves to the main account — the original bug, restored.
  const sel = src.match(/\.select\("id, chat_id[^"]*"\)/)?.[0] ?? "";
  assert.ok(sel.includes("rep_key"), `rep_key must be in the open-receipt select; got ${sel}`);

  // Threads must be grouped by ACCOUNT as well as identity. Grouping on
  // (act_as, chat) alone would let two accounts' receipts share one fetch and
  // be read with whichever account happened to be first.
  assert.ok(
    /JSON\.stringify\(\[service, r\.act_as_email \?\? "", String\(r\.chat_id\)\]\)/.test(src),
    "the group key must include the service, and must not be a delimiter-joined string",
  );
}

console.log("receipt-wire-account.test.ts — all assertions passed");
