/**
 * One compact card per department on the owner's brief (design doc §(c)
 * Today, 3): a status line, one real number, and the way into the department.
 *
 * The number follows "unknown is not zero": a live read prints its value (a
 * real 0 included), a failed read says it failed, a source the OS cannot see
 * says "Not connected" with a Connect link, and a department nothing measures
 * yet shows an em dash and says why. None of them can print a fallback 0.
 *
 * The card is a <section>, not one big link: a Connect link inside a card link
 * would be a link in a link. The department name is the way in.
 *
 * Server component, no hooks.
 */
import Link from "next/link";
import { ChevronRight, Hash } from "lucide-react";
import type { DeptCardModel, DeptTone } from "@/components/os/today/model";

const DOT: Record<DeptTone, string> = {
  needs_you: "bg-unread",
  attention: "bg-status-warm",
  ok: "bg-status-engaged",
  quiet: "bg-fg-faint",
};

export function DepartmentCard({ card }: { card: DeptCardModel }) {
  const m = card.metric;
  return (
    <section
      aria-label={card.label}
      className="flex min-w-0 flex-col rounded-xl border border-hairline bg-bg-panel p-4 transition-colors duration-150 hover:border-bg-border-strong"
    >
      <div className="flex items-center justify-between gap-2">
        <Link
          href={card.href}
          prefetch={false}
          className="group inline-flex min-w-0 items-center gap-1.5 rounded text-sm font-semibold text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <Hash size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-dim" />
          <span className="truncate">{card.label}</span>
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            aria-hidden
            className="shrink-0 text-fg-dim transition-colors duration-150 group-hover:text-fg-muted"
          />
        </Link>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[card.tone]}`} />
          <span className="truncate">{card.status}</span>
        </span>
      </div>

      <div className="mt-3 flex min-h-8 items-baseline gap-2">
        {m.kind === "live" ? (
          <>
            <span className="text-2xl font-semibold leading-8 tracking-tight text-fg tabular-nums">{m.value}</span>
            <span className="min-w-0 truncate text-[13px] text-fg-muted">{m.label}</span>
          </>
        ) : m.kind === "not_connected" ? (
          <>
            <span className="text-sm font-medium text-fg-muted">Not connected</span>
            <Link href={m.connectHref} prefetch={false} className="text-sm font-medium text-accent hover:underline">
              Connect
            </Link>
          </>
        ) : m.kind === "error" ? (
          <>
            <span aria-hidden className="text-2xl font-semibold leading-8 text-fg-dim">
              —
            </span>
            <span className="min-w-0 truncate text-[13px] text-status-warm">Couldn&rsquo;t load · {m.label}</span>
          </>
        ) : (
          <>
            <span aria-hidden className="text-2xl font-semibold leading-8 text-fg-dim">
              —
            </span>
            <span className="min-w-0 text-[13px] text-fg-muted">{m.label}</span>
          </>
        )}
      </div>

      {card.detail && <p className="mt-1 truncate text-xs text-fg-dim">{card.detail}</p>}

      {card.connection && (
        <p className="mt-3 flex flex-wrap items-center gap-x-1.5 border-t border-hairline pt-3 text-xs text-fg-muted">
          <span>{card.connection.label}</span>
          <span aria-hidden className="text-fg-dim">
            ·
          </span>
          <span>Not connected</span>
          <Link href={card.connection.href} prefetch={false} className="ml-auto font-medium text-accent hover:underline">
            Connect
          </Link>
        </p>
      )}
    </section>
  );
}
