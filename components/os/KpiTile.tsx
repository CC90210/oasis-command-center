/**
 * KpiTile — one number, with "unknown is not zero" built in.
 *
 *   <KpiTile label="Cash on hand" value="$41,200" status="live" hint="Stripe + bank, 5 min ago" />
 *   <KpiTile label="Ad spend 7d" value={null} status="not_connected" connectHref="/settings/connections" />
 *   <KpiTile label="Win rate 30d" value={null} status="error" hint="Pipeline read failed" />
 *   <KpiTile label="SLA breached" value={null} status="no_data" emptyText="No tickets yet" />
 *
 * THE RULE THIS COMPONENT EXISTS TO HOLD. A tile only prints `value` when
 * `status` is "live". A disconnected source says "Not connected" with a way to
 * connect it; a failed read says it failed; a live source with no answer yet
 * prints an em dash; and a source that answered but has never held anything (a
 * support desk with no ticket ever, a bank never imported) says so in words,
 * "no_data", because a 0 there reads as a verdict ("within SLA", "nothing to
 * review") that no data stands behind. None of them can print 0 — so a page
 * that falls back to `?? 0` on a missing source still cannot render "$0" to
 * the owner, which reads as "the business made nothing" and is the exact
 * failure lib/goals and the Today money cards were rebuilt to prevent. A real
 * zero from a live source is a real zero and renders as one.
 *
 * Server component (no hooks). Format `value` before passing it: this tile
 * knows nothing about currencies or units.
 */

import Link from "next/link";

export type KpiStatus = "live" | "not_connected" | "error" | "no_data";

export type KpiTileProps = {
  label: string;
  /** Pre-formatted. Ignored unless status is "live"; null there renders "—". */
  value: string | number | null;
  status: KpiStatus;
  /** One muted line under the value: period, source, freshness, or why. */
  hint?: string;
  /** Where "Connect" goes when status is "not_connected". */
  connectHref?: string;
  /** What a "no_data" tile says in place of a number. Defaults to "No data yet". */
  emptyText?: string;
  /** A live tile's link to where its number is acted on ("Open Connections"). Ignored unless status is "live". */
  action?: { label: string; href: string };
};

export function KpiTile({ label, value, status, hint, connectHref, emptyText, action }: KpiTileProps) {
  const live = status === "live";
  const shown = live && value !== null && value !== "" ? value : null;
  return (
    <div className="rounded-xl border border-hairline bg-bg-panel p-4">
      <div className="text-[12.5px] font-medium leading-4 text-fg-muted">{label}</div>
      {live ? (
        <div className="mt-2 text-2xl font-semibold leading-8 tracking-tight text-fg tabular-nums">
          {shown ?? <span className="text-fg-dim" aria-label="No data yet">—</span>}
        </div>
      ) : status === "no_data" ? (
        <div className="mt-2 flex min-h-8 items-baseline">
          <span className="text-sm font-medium text-fg-muted">{emptyText || "No data yet"}</span>
        </div>
      ) : status === "not_connected" ? (
        <div className="mt-2 flex min-h-8 flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-fg-muted">Not connected</span>
          {connectHref && (
            <Link href={connectHref} prefetch={false} className="text-sm font-medium text-accent hover:underline">
              Connect
            </Link>
          )}
        </div>
      ) : (
        <div className="mt-2 flex min-h-8 items-baseline gap-2">
          <span className="text-2xl font-semibold leading-8 text-fg-dim" aria-hidden>
            —
          </span>
          <span className="text-sm font-medium text-status-warm">Couldn’t load</span>
        </div>
      )}
      {hint && <div className="mt-1 text-xs leading-4 text-fg-dim">{hint}</div>}
      {live && action && (
        <Link href={action.href} prefetch={false} className="mt-1 inline-block text-xs font-medium text-accent hover:underline">
          {action.label}
        </Link>
      )}
    </div>
  );
}
