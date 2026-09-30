/**
 * tests/os-stripe-sync.test.ts — "Stripe connected" is a time, never a bare
 * "Connected".
 *
 * WHY. On 2026-09-29 Stripe was pinned and its webhook healthy, and nothing
 * had reached the books since 09-24: no Stripe activity, and no reconcile
 * scheduled. A card saying "Connected" would have said the books were
 * current. Where Today, the Finance tab and Finances › Settings report
 * Stripe, they now say when the books last heard from it: the newest webhook
 * event or completed reconcile (stripe-ingest.ts lastStripeSync).
 *
 * Pure: the copy (lib/founders-finances/stripe-sync-status.ts), the Today
 * Finance card's Stripe line (components/os/today/model.ts), plus a source
 * check that each surface prints that line and no "Connected" of its own.
 *
 * Run: node --conditions=react-server --import tsx tests/os-stripe-sync.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STRIPE_SYNC_STALE_AFTER_MS, stripeSyncLine, syncedAgo } from "../lib/founders-finances/stripe-sync-status";
import { buildDepartmentCards, stripeConnection, FINANCE_STRIPE_HREF } from "../components/os/today/model";

const root = join(__dirname, "..");
const NOW = Date.parse("2026-09-29T20:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 60 * 60 * 1000;

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 5).join("\n        ")}`);
  }
}

check("the relative time reads like a person: just now, minutes, hours, days", () => {
  assert.equal(syncedAgo(NOW - 20_000, NOW), "just now");
  assert.equal(syncedAgo(NOW - 60_000, NOW), "1 minute ago");
  assert.equal(syncedAgo(NOW - 12 * 60_000, NOW), "12 minutes ago");
  assert.equal(syncedAgo(NOW - 3 * H, NOW), "3 hours ago");
  assert.equal(syncedAgo(NOW - 47 * H, NOW), "47 hours ago");
  assert.equal(syncedAgo(NOW - 5 * 24 * H, NOW), "5 days ago");
});

check("never synced / synced / stale", () => {
  assert.deepEqual(stripeSyncLine(null, NOW), { state: "never", note: "Never synced" });
  assert.deepEqual(stripeSyncLine("not a time", NOW), { state: "never", note: "Never synced" });
  assert.deepEqual(stripeSyncLine(ago(3 * H), NOW), { state: "live", note: "Last synced 3 hours ago" });
  assert.equal(stripeSyncLine(ago(STRIPE_SYNC_STALE_AFTER_MS + H), NOW).state, "stale", "a daily job that has not run for two days is flagged");
  assert.equal(stripeSyncLine(ago(5 * 24 * H), NOW).note, "Last synced 5 days ago");
});

check("the Finance card's Stripe line: not connected, couldn't check, never synced, last synced, stale", () => {
  assert.deepEqual(stripeConnection(false, null, NOW), { label: "Stripe", state: "not_connected", note: "Not connected", href: FINANCE_STRIPE_HREF });
  assert.deepEqual(stripeConnection(null, { ok: true, lastSyncAt: ago(H) }, NOW), { label: "Stripe", state: "error", note: "Couldn't check", href: null });
  assert.deepEqual(stripeConnection(true, { ok: false }, NOW), { label: "Stripe", state: "error", note: "Couldn't check", href: null });
  assert.deepEqual(stripeConnection(true, null, NOW), { label: "Stripe", state: "error", note: "Couldn't check", href: null }, "pinned, but when it synced was not read");
  assert.deepEqual(stripeConnection(true, { ok: true, lastSyncAt: null }, NOW), { label: "Stripe", state: "no_data", note: "Never synced", href: null });
  assert.deepEqual(stripeConnection(true, { ok: true, lastSyncAt: ago(3 * H) }, NOW), { label: "Stripe", state: "live", note: "Last synced 3 hours ago", href: null });
  assert.deepEqual(stripeConnection(true, { ok: true, lastSyncAt: ago(5 * 24 * H) }, NOW), { label: "Stripe", state: "error", note: "Last synced 5 days ago", href: null });
});

check("Today's Finance card carries the line, pinned or not, with or without a goal", () => {
  const card = (connected: boolean | null, sync: { ok: true; lastSyncAt: string | null } | { ok: false } | null) =>
    buildDepartmentCards({
      departments: [{ key: "finance", label: "Finance", href: "/team/finance" }],
      needsYou: { items: [], unavailable: [], approvals: null } as unknown as Parameters<typeof buildDepartmentCards>[0]["needsYou"],
      sales: null,
      delivery: null,
      content: null,
      goal: { kind: "no_goal" } as unknown as Parameters<typeof buildDepartmentCards>[0]["goal"],
      stripeConnected: connected,
      stripeSync: sync,
      routines: null,
      nowMs: NOW,
    })[0];
  assert.equal(card(true, { ok: true, lastSyncAt: ago(2 * H) }).connection?.note, "Last synced 2 hours ago");
  assert.equal(card(true, { ok: true, lastSyncAt: null }).connection?.note, "Never synced");
  assert.equal(card(false, null).connection?.note, "Not connected");
  for (const c of [card(true, { ok: true, lastSyncAt: ago(2 * H) }), card(true, { ok: true, lastSyncAt: null }), card(null, null)]) {
    assert.doesNotMatch(c.connection?.note ?? "", /^Connected$/, "never a bare Connected");
  }
});

check("every surface that reports Stripe prints the sync line, never a Connected of its own", () => {
  const today = readFileSync(join(root, "components/today/FounderToday.tsx"), "utf8");
  assert.match(today, /stripeSync: money\?\.stripeSync \?\? null/, "Today passes the sync read to the Finance card");
  const money = readFileSync(join(root, "lib/goals/oasis-money.ts"), "utf8");
  assert.match(money, /lastStripeSync\(\)/, "the money reader reads when Stripe last synced");
  const settings = readFileSync(join(root, "app/founders/finances/settings/page.tsx"), "utf8");
  assert.match(settings, /stripeSyncLine\(lastSync, Date\.now\(\)\)/);
  assert.match(settings, /\{sync\.note\}/);
  // Settings' Last synced is lastStripeSync's: a live event that reached the books (the
  // shared LAST_SYNCED_EVENT_SQL, tests/finances-stripe-payouts.test.ts runs it) or a
  // reconcile. Not the newest delivery: a failing or test-mode one is not a sync.
  assert.match(settings, /const lastSync = \[lastEvent\?\.synced_at, lastEvent\?\.reconciled_at\]/);
  const pageContext = readFileSync(join(root, "lib/founders-finances/page-context.ts"), "utf8");
  assert.match(pageContext, /\(\$\{LAST_SYNCED_EVENT_SQL\}\) AS synced_at/);
  const ingestSrc = readFileSync(join(root, "lib/founders-finances/stripe-ingest.ts"), "utf8");
  assert.match(ingestSrc, /SELECT \(\$\{LAST_SYNCED_EVENT_SQL\}\) AS event_at/, "lastStripeSync reads the same condition");
  const numbers = readFileSync(join(root, "components/os/department/numbers.ts"), "utf8");
  assert.match(numbers, /stripeSyncLine\(money\.stripeSync\.lastSyncAt, Date\.now\(\)\)\.note/, "the Finance tab's MRR tile says when Stripe last synced");
  for (const [name, src] of [["settings", settings], ["numbers", numbers]] as const) {
    assert.doesNotMatch(src, /["'>]Connected["'<]/, `${name} prints no bare Connected`);
  }
});

if (failures) {
  console.error(`os-stripe-sync: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("os-stripe-sync: all checks passed");
