/**
 * Today's schedule, right column of the owner's brief.
 *
 * Two real sources and no more:
 *   - meetings booked through the pipeline today (a lead's founder_meeting_at,
 *     read by the board query), each linking to its lead;
 *   - whether the viewer's Google Calendar is connected (Settings › Personal).
 *
 * The OS has no reader for the rest of a Google Calendar yet, so this block
 * never claims the day is free: with no booked meetings it says "No meetings
 * booked", and the calendar line says what is and is not shown.
 *
 * Server component, no hooks.
 */
import Link from "next/link";
import { operatorTime, type LeadLite, type Read } from "@/components/os/today/model";

export type ScheduleGlanceProps = {
  /** Null when this viewer's pipeline is not read here (no meetings source). */
  meetings: Read<LeadLite[]> | null;
  /** The meetings list came from a window of the board and may be incomplete. */
  partial: boolean;
  calendar: Read<{ connected: boolean; address: string | null }>;
  /** Where the calendar is connected. */
  connectHref: string;
};

export function ScheduleGlance({ meetings, partial, calendar, connectHref }: ScheduleGlanceProps) {
  return (
    <section aria-labelledby="schedule-heading" className="rounded-xl border border-hairline bg-bg-panel">
      <header className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <h2 id="schedule-heading" className="text-sm font-semibold text-fg">
          Today&rsquo;s schedule
        </h2>
        <Link href="/schedule" prefetch={false} className="text-xs font-medium text-accent hover:underline">
          Open schedule
        </Link>
      </header>

      {meetings && (
        <div className="px-4 py-3">
          {!meetings.ok ? (
            <p className="text-[13px] text-status-warm">Couldn&rsquo;t load today&rsquo;s booked meetings.</p>
          ) : meetings.value.length === 0 ? (
            <p className="text-[13px] text-fg-muted">
              {partial ? "No booked meetings found in the part of the board read." : "No meetings booked through the pipeline today."}
            </p>
          ) : (
            <ul className="space-y-1">
              {meetings.value.slice(0, 5).map((m) => (
                <li key={m.id}>
                  <Link
                    href={`/pipeline/${m.id}`}
                    prefetch={false}
                    className="-mx-2 flex items-baseline gap-3 rounded-lg px-2 py-1.5 outline-none transition-colors duration-150 hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <span className="w-16 shrink-0 text-xs text-fg-dim tabular-nums">{operatorTime(m.at)}</span>
                    <span className="min-w-0 truncate text-sm text-fg">{m.name}</span>
                  </Link>
                </li>
              ))}
              {meetings.value.length > 5 && (
                <li className="pt-1 text-xs text-fg-dim">and {meetings.value.length - 5} more on the board</li>
              )}
            </ul>
          )}
        </div>
      )}

      <div className={`px-4 py-3 text-xs ${meetings ? "border-t border-hairline" : ""}`}>
        {!calendar.ok ? (
          <span className="text-status-warm">Couldn&rsquo;t check your Google Calendar connection.</span>
        ) : calendar.value.connected ? (
          <span className="text-fg-muted">
            Google Calendar connected{calendar.value.address ? ` (${calendar.value.address})` : ""}. Its own events are
            not listed here yet.
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-fg-muted">
            <span>Google Calendar</span>
            <span aria-hidden className="text-fg-dim">
              ·
            </span>
            <span>Not connected</span>
            <Link href={connectHref} prefetch={false} className="ml-auto font-medium text-accent hover:underline">
              Connect
            </Link>
          </span>
        )}
      </div>
    </section>
  );
}
