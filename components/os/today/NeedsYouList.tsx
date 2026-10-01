/**
 * Needs you — the first block of the owner's brief (design doc §(c) Today, 2).
 *
 * Approval cards come first: an email, a post or another outward action a
 * department drafted and is holding until this person approves it or sends it
 * back (lib/os/approvals). Up to five render inline with Approve · Send back ·
 * Comment; the rest are one link away in the Feed.
 *
 * Then the rows that already exist somewhere else in the product: a past-due
 * follow-up on the board, a founder meeting with no outcome, a ticket past its
 * SLA, a failed routine, a hot reply, an overdue invoice, a connection that
 * needs the owner (until it recovers). Each row opens the page where it is
 * resolved. The header counts the things behind the rows.
 *
 * Under them, "Review": rows to look over that are not waiting on anyone, and
 * are not in the count (model.ts isReviewItem): open leads with no next step,
 * follow-ups promised before this cycle began, today's booked meetings, bank
 * lines to categorise.
 *
 * An empty list says so, and a source that could not be read is named under
 * it — "nothing needs you" is only claimed when every source answered.
 *
 * Server component, no hooks (the approval cards are their own client
 * islands). Links keep prefetch off like every rail link.
 */
import Link from "next/link";
import { CalendarDays, ChevronRight, Landmark, LifeBuoy, PhoneCall, Plug, Receipt, Repeat, Reply } from "lucide-react";
import { ApprovalCard } from "@/components/os/approvals/ApprovalCard";
import {
  isReviewItem,
  needsYouTotal,
  type NeedsYou,
  type NeedsYouIcon,
  type NeedsYouItem,
  type NeedsYouTone,
} from "@/components/os/today/model";
import { floorCount } from "@/lib/os/count";

const ICONS: Record<NeedsYouIcon, typeof PhoneCall> = {
  follow_up: PhoneCall,
  sla: LifeBuoy,
  reply: Reply,
  meeting: CalendarDays,
  invoice: Receipt,
  bank: Landmark,
  connection: Plug,
  routine: Repeat,
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

/**
 * Past 99 the pill is a floor anyway; below it, a capped read prints "N+"
 * through the shell's one floor rule (lib/os/count.ts).
 */
function formatCount(n: number, capped = false): string {
  return n > 99 ? "99+" : floorCount(n, capped);
}

function NeedsYouRow({ item }: { item: NeedsYouItem }) {
  const Icon = ICONS[item.icon];
  return (
    <li>
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
}

/**
 * The rows: what needs the viewer first, then the Review rows under their own
 * heading. Shared by Today and the Feed's Needs-you tab, which count the same
 * rows (model.ts needsYouTotal).
 */
export function NeedsYouRows({ items }: { items: readonly NeedsYouItem[] }) {
  const waiting = items.filter((item) => !isReviewItem(item));
  const review = items.filter(isReviewItem);
  return (
    <>
      {waiting.length > 0 && (
        <ul className="divide-y divide-hairline">
          {waiting.map((item) => (
            <NeedsYouRow key={item.id} item={item} />
          ))}
        </ul>
      )}
      {review.length > 0 && (
        <div className={waiting.length > 0 ? "border-t border-hairline" : undefined}>
          <h3 className="px-4 pb-1 pt-3 text-xs font-semibold text-fg-muted">Review</h3>
          <p className="px-4 text-xs text-fg-dim">Worth a look, not counted as waiting on you.</p>
          <ul className="divide-y divide-hairline">
            {review.map((item) => (
              <NeedsYouRow key={item.id} item={item} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export function NeedsYouList({
  needsYou,
  feedHref = null,
}: {
  needsYou: NeedsYou;
  /** Where "All N in Feed" goes, when this viewer's rail has the Feed. */
  feedHref?: string | null;
}) {
  const { items, unavailable } = needsYou;
  const approvals = needsYou.approvals ?? null;
  // Things, not rows: 15 overdue follow-ups are 15 (model.ts needsYouTotal,
  // the same count the Chief of Staff card and tab print). Review rows are
  // drawn but not counted.
  const { total, capped } = needsYouTotal(needsYou);
  const urgent = items.filter((i) => i.tone === "urgent").length + (approvals?.total ?? 0);
  const moreApprovals = approvals ? approvals.total - approvals.items.length : 0;
  const waiting = items.filter((item) => !isReviewItem(item)).length;
  return (
    <section aria-labelledby="needs-you-heading" className="rounded-xl border border-hairline bg-bg-panel">
      <header className="flex items-center gap-2 border-b border-hairline px-4 py-3">
        <h2 id="needs-you-heading" className="text-sm font-semibold text-fg">
          Needs you
        </h2>
        {total > 0 && (
          <span
            className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${
              urgent > 0 ? "bg-unread text-white" : "bg-bg-elev text-fg-muted"
            }`}
            aria-label={`${capped ? "at least " : ""}${total} item${total === 1 && !capped ? "" : "s"}`}
          >
            {formatCount(total, capped)}
          </span>
        )}
      </header>

      {approvals && approvals.items.length > 0 && (
        <div className="space-y-3 border-b border-hairline px-4 py-3">
          <ul className="space-y-3" aria-label="Approvals waiting on you">
            {approvals.items.map((a) => (
              <li key={a.id}>
                <ApprovalCard approval={a} density="compact" />
              </li>
            ))}
          </ul>
          {moreApprovals > 0 && feedHref && (
            <Link href={feedHref} prefetch={false} className="inline-block text-[13px] font-medium text-accent hover:underline">
              All {approvals.total} approvals in Feed
            </Link>
          )}
          {moreApprovals > 0 && !feedHref && (
            <p className="text-xs text-fg-dim">{moreApprovals} more waiting.</p>
          )}
        </div>
      )}

      {waiting === 0 && (approvals?.items.length ?? 0) === 0 && (
        <p className="px-4 py-6 text-sm text-fg-muted">
          {unavailable.length === 0
            ? "Nothing needs you right now. Approvals, follow-ups, support SLAs and hot replies land here when they do."
            : "Nothing found in the sources that answered."}
        </p>
      )}
      <NeedsYouRows items={items} />

      {unavailable.length > 0 && (
        <p className="border-t border-hairline px-4 py-2.5 text-xs text-status-warm">
          Couldn&rsquo;t check {unavailable.join(", ")} just now. This list may be incomplete; reload in a minute.
        </p>
      )}
    </section>
  );
}
