/**
 * The books' daily upkeep, run by /api/cron/finance-books?job=<job>, which the
 * oasis-cc-cron Worker drives (config/cron-registry.json). Before this, the
 * four internal routes these jobs mirror (app/api/internal/finance/*) existed
 * and nothing scheduled them: exchange rates went stale from 09-24, Stripe
 * reached the books only through the webhook, and the Wise feed never ran.
 *
 *   fx-refresh        21:47 UTC  Bank of Canada USD/CAD for the last 30 days
 *                                (the Valet API publishes by 16:30 Eastern,
 *                                which is 21:30 UTC in winter (EST): 21:23
 *                                ran before it for half the year, so moved
 *                                2026-09-30). Rows are upserted.
 *   stripe-reconcile  21:53 UTC  payments, refunds, subscriptions and pending
 *                                fees from the last 7 days, then every payout
 *                                (stripe-ingest.ts reconcileStripe). A safety
 *                                net under the webhook; idempotent on
 *                                Stripe's own ids.
 *   wise-reconcile    22:07 UTC  a DRY RUN: it lists the Wise deposits that
 *                                EXACTLY settle one open invoice and records
 *                                none of them. Recording an invoice payment
 *                                (and deactivating its Stripe payment link)
 *                                stays a founder's click on "Check for Wise
 *                                payments" until CC approves automatic
 *                                recording; then WISE_RECONCILE_CRON_DRY_RUN
 *                                is the one line to change.
 *   wise-sync         22:29 UTC  the Wise bank feed. While
 *                                FINANCE_WISE_FEED_WRITES is not "on"
 *                                (production today) it is a DRY RUN and
 *                                writes nothing; the day the switch is
 *                                flipped, the same schedule imports.
 *
 * ORDER. Rates first (a USD fee or payout books at its own day's rate), then
 * Stripe (a payout leaves clearing before the bank feed looks at it, so the
 * feed links its line to the payout instead of booking it again), then the
 * invoice matches (the feed sets aside a deposit already recorded against an
 * invoice), then the feed. Minutes are off the 5-minute grid and away from
 * the hourly :15 / :17 jobs.
 *
 * NONE OF THEM MOVES MONEY OR WRITES TO A CLIENT. They read Stripe, Wise and
 * the Bank of Canada and write the books. The one write to Stripe is the
 * Stripe reconcile's, and the webhook makes the same one: a charge it records
 * against a fin invoice deactivates that paid invoice's payment link
 * (stripe-ingest.ts deactivatePaymentLinkIfPaid), so it cannot be paid twice.
 * Recording a Wise payment would make it too; the schedule records none.
 */
import "server-only";

import type { FinanceViewer } from "./access";
import { addDays, torontoToday } from "./fx";
import { refreshFxRates } from "./fx-io";
import { ensureFinanceSeed } from "./seed-io";
import { reconcileStripe } from "./stripe-ingest";
import { StripeApiError, StripeNotReady } from "./stripe-io";
import { WISE_FEED_WRITES_ENABLED } from "./wise-feed";
import { syncWiseFeed } from "./wise-feed-io";
import { WiseNotReady } from "./wise-io";
import { reconcileWise } from "./wise-reconcile";

export const FINANCE_BOOK_JOBS = ["fx-refresh", "stripe-reconcile", "wise-reconcile", "wise-sync"] as const;
export type FinanceBookJob = (typeof FINANCE_BOOK_JOBS)[number];

export function isFinanceBookJob(v: unknown): v is FinanceBookJob {
  return typeof v === "string" && (FINANCE_BOOK_JOBS as readonly string[]).includes(v);
}

/** The scheduled job is the system: not a founder, and not Atlas. */
const SYSTEM: FinanceViewer = { kind: "system", name: "reconcile" };

/** The daily Stripe window. Payouts are always read further back (stripe-ingest.ts PAYOUT_LOOKBACK_DAYS). */
export const STRIPE_RECONCILE_DAYS = 7;
const FX_DAYS = 30;
const WISE_DAYS = 7;

/** The feed writes only while the Finances switch is on; otherwise the run is a dry run that changes nothing. */
export function wiseSyncDryRun(writesEnabled: boolean = WISE_FEED_WRITES_ENABLED): boolean {
  return !writesEnabled;
}

/**
 * The scheduled Wise invoice match never records a payment: recording one is
 * a founder's decision (Atlas's handover, 2026-09-29) until CC approves doing
 * it automatically. Not tied to the feed's switch: turning the bank feed on
 * is not that approval.
 */
export const WISE_RECONCILE_CRON_DRY_RUN = true;

/**
 * Run one job. The result holds counts and stable codes only: the manual
 * rollback driver (cron-driver.yml) prints the response to a public log.
 */
export async function runFinanceBookJob(job: FinanceBookJob): Promise<Record<string, unknown>> {
  switch (job) {
    case "fx-refresh": {
      const to = torontoToday();
      const r = await refreshFxRates(addDays(to, -FX_DAYS), to);
      return { observations: r.observations, from: r.from, to: r.to };
    }
    case "stripe-reconcile": {
      await ensureFinanceSeed();
      return { ...(await reconcileStripe({ days: STRIPE_RECONCILE_DAYS })) };
    }
    case "wise-reconcile": {
      await ensureFinanceSeed();
      const r = await reconcileWise(SYSTEM, { days: WISE_DAYS, dryRun: WISE_RECONCILE_CRON_DRY_RUN });
      return {
        dry_run: r.dry_run,
        deposits_seen: r.deposits_seen,
        already_recorded: r.already_recorded,
        recorded: r.recorded,
        needs_confirmation: r.needs_confirmation.length,
        unmatched: r.unmatched.length,
        errors: r.errors.length,
      };
    }
    case "wise-sync": {
      await ensureFinanceSeed();
      const r = await syncWiseFeed(SYSTEM, { days: WISE_DAYS }, { dryRun: wiseSyncDryRun() });
      const sum = (k: "new_rows" | "inserted" | "posted" | "stripe_payouts" | "needs_review") => r.currencies.reduce((a, c) => a + c[k], 0);
      return {
        dry_run: r.dry_run,
        currencies: r.currencies.map((c) => c.currency),
        new_rows: sum("new_rows"),
        inserted: sum("inserted"),
        posted: sum("posted"),
        stripe_payouts: sum("stripe_payouts"),
        needs_review: sum("needs_review"),
        errors: r.currencies.reduce((a, c) => a + c.errors.length, 0),
      };
    }
  }
}

/** A failure as a stable code and status for the public log; the detail goes to the server log. */
export function financeBookJobFailure(e: unknown): { code: string; status: number } {
  if (e instanceof StripeNotReady) return { code: e.code, status: 409 };
  if (e instanceof StripeApiError) return { code: "stripe_error", status: 502 };
  if (e instanceof WiseNotReady) return { code: e.code, status: e.code === "wise_not_configured" ? 503 : 502 };
  return { code: "job_failed", status: 500 };
}
