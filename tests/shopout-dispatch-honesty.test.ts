/**
 * tests/shopout-dispatch-honesty.test.ts — a failed send must never read as ok.
 *
 * WHY THIS EXISTS
 * ---------------
 * Shopping out was physically dead from 2026-08-06 to 2026-08-11. The send
 * path failed, the route returned HTTP 200 {ok:true}, the UI painted a green
 * "Sending now — watch the thread statuses below", and the rows sat at
 * status='pending' with last_error NULL. Six lender packages went nowhere on
 * 2026-08-11 and every surface an operator can see reported success.
 *
 * The contract, on all three dispatch routes:
 *   physical_send.status === "error"  =>  ok:false, HTTP 502, and the reason
 *                                          written to the pending rows.
 *
 * These are source-level assertions rather than HTTP round-trips because the
 * routes need a Next request scope, a session and a database to execute. That
 * makes them weaker than an integration test at proving behaviour, and exactly
 * as strong at what they are for: catching a well-meaning revert to
 * `return NextResponse.json({ ok: true, ... })` on a path that just failed.
 * The behavioural proof is the deliberate-break step in the runbook.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROUTES = [
  "app/api/applications/[id]/shop-out/route.ts",
  "app/api/applications/[id]/lender-threads/retry-all/route.ts",
  "app/api/applications/[id]/lender-threads/[threadId]/retry/route.ts",
];

for (const path of ROUTES) {
  const src = readFileSync(path, "utf8");

  assert.ok(
    src.includes("physicalSendFailed"),
    `${path}: must branch on physicalSendFailed — a dispatch that delivered nothing is not a success`,
  );
  assert.ok(
    src.includes("recordDispatchFailure"),
    `${path}: must write the failure to the row. The toast is seen once; the row is what a health check reads at 3am`,
  );
  assert.ok(
    /error: "physical_send_failed"/.test(src),
    `${path}: must return a machine-readable physical_send_failed error code`,
  );
  assert.ok(
    /{ status: 502 }/.test(src),
    `${path}: a dead send path must surface a non-2xx, or the caller cannot tell it failed`,
  );
}

// ── The outcome helper's own rules ─────────────────────────────────────────
const helper = readFileSync("lib/lenders/shop-out-outcome.ts", "utf8");

// 'partial' must NOT count as a whole-batch failure: some lenders did receive
// the package, and the per-thread rows carry their own status. Treating it as
// total failure would hide the sends that landed.
assert.ok(
  /ps\?\.status === "error"/.test(helper),
  "physicalSendFailed must key on 'error' alone, not on 'partial' or 'skipped'",
);

// The stamp must be tenant-scoped AND application-scoped AND pending-only, or
// it can rewrite a thread that already sent, or cross a tenant boundary.
// pending-only is also the double-send guard: the sender moves a row to
// 'sending' before it transmits, so anything still pending was never picked up.
for (const scope of ['.eq("tenant_id"', '.eq("application_id"', '.eq("status", "pending")']) {
  assert.ok(
    helper.includes(scope),
    `recordDispatchFailure must scope its update by ${scope} — an unscoped update can overwrite a successful send`,
  );
}

// THE recovery-path regression. Both retry endpoints recover only 'error' rows
// (plus stale 'sending'), and the UI computes canRetry from the same two. A
// failed dispatch left at 'pending' therefore gets a 502 saying "use Retry"
// with no Retry button rendered and a retry request that no-ops. Telling the
// operator to take an action that does not exist is the same defect as telling
// them a dead send worked. (Codex review, 2026-08-11.)
assert.ok(
  /status: "error"/.test(helper),
  "recordDispatchFailure must move failed threads to 'error' — 'pending' is not retryable by " +
    "either retry endpoint and renders no Retry button",
);
{
  const ui = readFileSync("components/shopping-out/ShoppingOutClient.tsx", "utf8");
  assert.ok(
    /canRetry = t\.status === "error"/.test(ui),
    "the UI's retryable set must still include 'error' — recordDispatchFailure depends on it",
  );
}

// ── The UI must not infer success from a missing count ─────────────────────
const ui = readFileSync("components/shopping-out/ShoppingOutClient.tsx", "utf8");

// THE regression. The old code read:
//   ps && typeof ps.sent_count === "number" ? `${ps.sent_count} sent` : " Sending now…"
// with tone "success". A failed dispatch carries no sent_count, so every total
// failure rendered green.
assert.ok(
  !/typeof ps\.sent_count === "number"\s*\n?\s*\?/.test(ui),
  "the UI must not decide tone from the presence of sent_count — a failed dispatch has none",
);
assert.ok(
  /ps\?\.status === "sent"/.test(ui),
  "the UI must decide tone from physical_send.status, which is the field that reports the outcome",
);
assert.ok(
  !/tone: "success",\s*\n\s*message: queuedMsg/.test(ui),
  "the queued+send message must not be hardcoded to a success tone",
);

// describeSendError must not lead with the watermark branch. Watermarking is a
// non-fatal degrade now, and its failure list rides along on unrelated errors —
// leading with it told the operator to re-upload a statement when the real
// fault was the bridge.
const describeIdx = ui.indexOf("function describeSendError");
const body = ui.slice(describeIdx, describeIdx + 1400);
assert.ok(
  body.includes('json.error === "bank_statement_watermark_failed"'),
  "describeSendError must only use the watermark framing when watermarking is what actually failed",
);
assert.ok(
  body.indexOf('json.error === "bank_statement_watermark_failed"') <
    body.indexOf("failures.length > 0"),
  "the watermark branch must be gated on the error code before it inspects the failure list",
);

console.log(
  `shopout-dispatch-honesty.test.ts — ${ROUTES.length} dispatch routes fail loudly, UI reads status not counts ✓`,
);
