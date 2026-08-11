/**
 * tests/shopout-sender-locality.test.ts — the lender send stays IN THIS APP.
 *
 * WHY THIS EXISTS
 * ---------------
 * Shopping out was dead from 2026-08-06 to 2026-08-11. It took all day to fix
 * because it was not one bug, it was three, stacked, each hidden behind the one
 * in front of it:
 *
 *   1. bravo_cli/bridge_tools.py hard-required BRAVO_SUPABASE_URL and raised
 *      before the Turso compat shim could route the call.
 *   2. send_gateway.get_supabase() had its OWN copy of that requirement, so
 *      fixing (1) moved the failure one process to the right.
 *   3. The VPS has no Cloudflare R2 credentials at all, and the module that
 *      resolves them does not exist on that box — so it could not download the
 *      bank statements it existed to attach. Unpatchable.
 *
 * All three existed only because the send took a detour: this app built the
 * package and had the bytes, then handed it to another machine to send, and
 * that machine had to re-acquire a database, a storage backend and a credential
 * it was never given. Three failure points instead of zero.
 *
 * The send is local now. FundMate always was, and had none of these outages.
 *
 * This test is what stops the detour being re-introduced. It is deliberately
 * crude — string checks over the route sources — because the failure it guards
 * is architectural, and an architectural regression is always visible as an
 * import or a fetch that should not be there.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Strip comments before asserting on "does this file reference X".
 *
 * The first version of this test flagged its own subject matter: the sender's
 * header explains WHY BRAVO_SUPABASE_URL must not appear, and the guard read
 * that explanation as a violation. A guard that forbids naming the thing it
 * forbids makes the codebase unable to record why a rule exists — so it checks
 * executable code, and the prose is free to say whatever is true.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments, incl. JSDoc
    .replace(/(^|[^:])\/\/.*$/gm, "$1 "); // line comments, sparing "https://"
}

const SEND_PATHS = [
  "app/api/applications/[id]/shop-out/route.ts",
  "app/api/applications/[id]/lender-threads/retry-all/route.ts",
];

for (const path of SEND_PATHS) {
  const src = code(path);

  // ── The send must be in-process ──────────────────────────────────────────
  assert.ok(
    src.includes("dispatchPendingSunbizThreads"),
    `${path}: must dispatch in-process via lib/lenders/shop-out-dispatch.ts`,
  );

  // ── and must NOT go back out to the bridge / VPS ─────────────────────────
  // Both spellings, because the tool name alone is enough to resurrect it.
  for (const banned of ["shop_out_send_batch", "/api/bridge/exec-tool"]) {
    assert.ok(
      !src.includes(banned),
      `${path}: references "${banned}". The lender send must not route through ` +
        `the bridge or the VPS — that machine has no R2 credentials and cannot ` +
        `attach the bank statements, which is the outage this guard exists for.`,
    );
  }
}

// ── Retry must take the SAME route as Send ─────────────────────────────────
// When they differ, "retry worked" stops being evidence that Send is fixed —
// which is exactly how the 2026-08-06 outage stayed ambiguous for five days.
{
  const shopOut = code(SEND_PATHS[0]);
  const retryAll = code(SEND_PATHS[1]);
  const usesDispatcher = (s: string) => /dispatchPendingSunbizThreads\(/.test(s);
  assert.ok(
    usesDispatcher(shopOut) && usesDispatcher(retryAll),
    "Send and Retry-all must call the same dispatcher, or retrying proves nothing about sending",
  );
}

// ── The sender itself must take no Supabase-shaped input ───────────────────
{
  const sender = code("lib/integrations/sunbiz-lender-mail-send.ts");

  // A credential that does not exist cannot be missing, and a routing key that
  // is not read cannot be deleted. Both of those DID happen and both took the
  // send down, so the sender names neither.
  for (const dead of [
    "BRAVO_SUPABASE_URL",
    "BRAVO_SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    assert.ok(
      !sender.includes(dead),
      `sunbiz-lender-mail-send.ts references ${dead}. Turso is the data plane; ` +
        `a Supabase-shaped env requirement here is the exact shape of the outage.`,
    );
  }

  // Attachments come from storage (R2), read in THIS process. If this ever
  // becomes a fetch to another host, layer 3 is back.
  assert.ok(
    /db\.storage\.from\(LEAD_DOC_BUCKET\)\.download\(/.test(sender),
    "attachments must be downloaded in-process from storage, not fetched from another machine",
  );

  // Tenant-prefix check before any read — storage_path arrives from a request
  // body, and an unchecked path attaches one tenant's statements to another
  // tenant's email.
  assert.ok(
    sender.includes("sunbiz_attachment_outside_tenant"),
    "the sender must reject any storage_path outside the caller's tenant prefix",
  );

  // A partial package is worse than no package: a funder reading an incomplete
  // file declines, and the merchant is told the market passed.
  assert.ok(
    sender.includes("sunbiz_attachment_download_failed"),
    "a failed attachment download must refuse the whole send, never send it short",
  );
}

// ── One inbox conversation, but SIX separate sends ─────────────────────────
//
// Adon, 2026-08-11: six lender emails made six inbox conversations. The fix is
// a shared References header, NOT one email addressed to every lender — those
// look similar and one of them ends deals. A funder who can see the deal is
// also with three competitors declines or lowballs on sight.
{
  const sender = code("lib/integrations/sunbiz-lender-mail-send.ts");
  const dispatch = code("lib/lenders/shop-out-dispatch.ts");

  assert.ok(
    /References: input\.threadRootId/.test(sender),
    "every lender send must carry the shared References anchor, or they scatter " +
      "into one inbox conversation per lender",
  );
  assert.ok(
    /"Message-Id": rfc822/.test(sender),
    "each send must keep its OWN unique Message-Id — it is the receipt and the " +
      "key the reply classifier correlates on",
  );
  assert.ok(
    !/In-Reply-To/.test(sender),
    "do not set In-Reply-To: it asserts this is a reply to a message that was " +
      "never delivered. References alone groups the thread and claims nothing untrue.",
  );

  // THE one that protects the deal. `to` takes a single recipient, resolved per
  // thread inside the loop. If this ever becomes a joined list, every funder
  // sees every other funder.
  assert.ok(
    /to: recipient,/.test(dispatch),
    "each lender must be sent to individually. Never join lender addresses into " +
      "one To/CC — exposing the competing funders on a deal is how it gets declined.",
  );

  // Anchor must be derived from the deal, not minted per run: a per-batch random
  // id starts a NEW conversation every time Retry is pressed, which is the
  // flooding this exists to prevent.
  assert.ok(
    /function dealThreadRootId\(applicationId: string\)/.test(dispatch) &&
      /shopout-\$\{applicationId\}/.test(dispatch),
    "the conversation anchor must be derived from the application id so retries " +
      "and later waves join the SAME thread",
  );
  assert.ok(
    !/randomUUID\(\)[\s\S]{0,80}threadRootId/.test(dispatch),
    "the anchor must not be random per run",
  );
}

// ── The dispatcher must claim rows before sending ──────────────────────────
{
  const dispatch = code("lib/lenders/shop-out-dispatch.ts");

  // The VPS shop_out_sender cron still polls the same pending rows every
  // minute. Without a conditional claim, both send and the funder receives the
  // same deal twice.
  assert.ok(
    /\.update\(\{ status: "sending"[\s\S]{0,200}?\.eq\("status", "pending"\)/.test(dispatch),
    "each thread must be claimed with a conditional pending->sending update before " +
      "sending, or a concurrent sender double-emails the lender",
  );

  // The receipt is what makes shopout.sent_without_proof meaningful. Stamped in
  // the same write that sets 'sent', so a status can never outrun its evidence.
  assert.ok(
    /status: "sent"[\s\S]{0,400}?send_interaction_id:/.test(dispatch),
    "the receipt must be stamped in the same write that sets status='sent'",
  );
}

console.log(
  "shopout-sender-locality.test.ts — lender send is in-process, bridge-free, " +
    "claims before sending, stamps its receipt ✓",
);
