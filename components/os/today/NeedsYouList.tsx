/**
 * Needs you — the first block of the owner's brief (design doc §(c) Today, 2).
 *
 * Only rows that already exist somewhere else in the product: a past-due
 * follow-up on the board, a ticket past its SLA, a hot reply, an overdue
 * invoice. Each row opens the page where it is resolved. There are no
 * approval cards yet (the `approvals` table is plan W5); when they land they
 * join this list, not a second one.
 *
 * An empty list says so, and a source that could not be read is named under
 * it — "nothing needs you" is only claimed when every source answered.
 *
 * Server component, no hooks. Links keep prefetch off like every rail link.
 */
import Link from "next/link";
import { CalendarDays, ChevronRight, Landmark, LifeBuoy, PhoneCall, Receipt, Reply } from "lucide-react";
import type { NeedsYou, NeedsYouIcon, NeedsYouTone } from "@/components/os/today/model";

const ICONS: Record<NeedsYouIcon, typeof PhoneCall> = {
  follow_up: PhoneCall,
  sla: LifeBuoy,
  reply: Reply,
  meeting: CalendarDays,
  invoice: Receipt,
  bank: Landmark,
};

/** Icon colour carries the tone; the words carry the meaning, so colour is never the only signal. */
const ICON_TONE: Record<NeedsYouTone, string> = {
  urgent: "text-status-hot",
  attention: "text-status-warm",
  info: "text-fg-dim",
};

const PILL_TONE: Record<NeedsYouTone, string> = {
  urgent: "bg-unread text-white",
  attention: "bg-bg-elev text-fg",
  info: "bg-bg-elev text-fg-muted",
};

/** Past 99 the pill is a floor anyway; below it, a capped read prints "N+". */
function formatCount(n: number, capped = false): string {
  return n > 99 ? "99+" : capped ? `${n}+` : String(n);
}

export function NeedsYouList({ needsYou }: { needsYou: NeedsYou }) {
  const { items, unavailable } = needsYou;
  const urgent = items.filter((i) => i.tone === "urgent").length;
  return (
    <section aria-labelledby="needs-you-heading" className="rounded-xl border border-hairline bg-bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <h2 id="needs-you-heading" className="text-sm font-semibold text-fg">
          Needs you
        </h2>
        {items.length > 0 && (
          <span
            className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${
              urgent > 0 ? "bg-unread text-white" : "bg-bg-elev text-fg-muted"
            }`}
            aria-label={`${items.length} item${items.length === 1 ? "" : "s"}`}
          >
            {formatCount(items.length)}
          </span>
        )}
      </header>

      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-fg-muted">
          {unavailable.length === 0
            ? "Nothing needs you right now. Follow-ups, support SLAs and hot replies land here when they do."
            : "Nothing found in the sources that answered."}
        </p>
      ) : (
        <ul className="divide-y divide-hairline">
          {items.map((item) => {
            const Icon = ICONS[item.icon];
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  prefetch={false}
                  className="group flex items-start gap-3 px-4 py-3 outline-none transition-colors duration-150 hover:bg-bg-hover focus-visible:bg-bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                >
                  <Icon size={16} strokeWidth={1.75} aria-hidden className={`mt-0.5 shrink-0 ${ICON_TONE[item.tone]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-fg">{item.title}</span>
                    {item.detail && <span className="mt-0.5 block truncate text-[13px] text-fg-muted">{item.detail}</span>}
                  </span>
                  {item.count !== null && (
                    <span
                      className={`mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${PILL_TONE[item.tone]}`}
                    >
                      {formatCount(item.count, item.capped === true)}
                    </span>
                  )}
                  <ChevronRight
                    size={16}
                    strokeWidth={1.75}
                    aria-hidden
                    className="mt-0.5 shrink-0 text-fg-dim transition-colors duration-150 group-hover:text-fg-muted"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {unavailable.length > 0 && (
        <p className="border-t border-hairline px-4 py-2.5 text-xs text-status-warm">
          Couldn&rsquo;t check {unavailable.join(", ")} just now. This list may be incomplete; reload in a minute.
        </p>
      )}
    </section>
  );
}
