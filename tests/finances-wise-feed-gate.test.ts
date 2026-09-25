/**
 * Production guard: with FINANCE_WISE_FEED_WRITES unset (as on the Worker), a
 * real Wise sync or opening balance is refused before it touches anything, so
 * the unfinished bank matching can never double-count money on the live books.
 * Dry runs (previews) are not affected by the switch.
 */
import assert from "node:assert/strict";

delete process.env.FINANCE_WISE_FEED_WRITES;

async function main(): Promise<void> {
  const { WISE_FEED_WRITES_ENABLED, WISE_FEED_OFF_MESSAGE } = await import("../lib/founders-finances/wise-feed");
  assert.equal(WISE_FEED_WRITES_ENABLED, false, "the feed writes must default to off");
  const { syncWiseFeed, postWiseOpeningBalance } = await import("../lib/founders-finances/wise-feed-io");
  const viewer = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u" };
  await assert.rejects(syncWiseFeed(viewer, {}, { dryRun: false }), (e: unknown) => e instanceof Error && e.message === WISE_FEED_OFF_MESSAGE);
  await assert.rejects(postWiseOpeningBalance(viewer, { date: "2026-09-01" }, { dryRun: false }), (e: unknown) => e instanceof Error && e.message === WISE_FEED_OFF_MESSAGE);
  console.log("finances-wise-feed-gate: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
