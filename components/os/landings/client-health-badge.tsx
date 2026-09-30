/**
 * ClientHealthBadge — a client's health (lib/os/customers/health.ts), on the
 * /clients list and on the record's header and Health tab.
 *
 *   <ClientHealthBadge health={h} />            the badge, with the reasons as its title
 *   <ClientHealthBreakdown health={h} />        the badge plus every reason and every unknown
 *
 * Plain server component: no state, no fetch. "Not enough data" is its own
 * badge, never shown as Healthy.
 */
import { HEALTH_LABELS, type Health, type HealthLevel } from "@/lib/os/customers/health";

const TONE: Record<HealthLevel, string> = {
  healthy: "border-status-engaged/40 text-status-engaged",
  watch: "border-status-warm/40 text-status-warm",
  at_risk: "border-status-hot/40 text-status-hot",
  unknown: "border-hairline text-fg-muted",
  past: "border-hairline text-fg-dim",
};

export function ClientHealthBadge({ health }: { health: Health }) {
  const title = [
    ...health.reasons,
    ...(health.unknown.length ? [`Not known: ${health.unknown.join(", ")}.`] : []),
  ].join(" ");
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-none ${TONE[health.level]}`}
      title={title || undefined}
    >
      {HEALTH_LABELS[health.level]}
    </span>
  );
}

/**
 * `moneyTracked` false: this workspace keeps no books in the app, so payments
 * were never looked at, and the breakdown says so instead of calling them fine.
 */
export function ClientHealthBreakdown({ health, moneyTracked = true }: { health: Health; moneyTracked?: boolean }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ClientHealthBadge health={health} />
        <span className="text-[13px] text-fg-muted">
          {health.level === "healthy"
            ? moneyTracked
              ? "Nothing in payments, support, delivery or contact needs attention."
              : "Nothing in support, delivery or contact needs attention."
            : health.level === "past"
              ? "This engagement ended. The record and its history stay."
              : health.level === "unknown"
                ? "Nothing that was read needs attention, but not everything could be read."
                : "What needs attention:"}
        </span>
      </div>
      {health.reasons.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-fg">
          {health.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {health.unknown.length > 0 && (
        <p className="text-[13px] text-fg-muted">
          Not known: {health.unknown.join(", ")}. Those signals could not be read for you, so they are not counted as fine.
        </p>
      )}
      {!moneyTracked && (
        <p className="text-[13px] text-fg-muted">
          This workspace&rsquo;s payments and invoices are not kept in the app, so they are not part of this.
        </p>
      )}
      <p className="text-xs text-fg-dim">
        {moneyTracked
          ? "Computed when you open the page from overdue or failed payments, tickets that missed their response target in 30 days, projects past due, and days since the last contact."
          : "Computed when you open the page from tickets that missed their response target in 30 days, projects past due, and days since the last contact."}
      </p>
    </div>
  );
}
