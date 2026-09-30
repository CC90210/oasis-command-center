/**
 * Today's schedule, right column of the owner's brief.
 *
 * Real sources and no more:
 *   - the viewer's own Schedule calendar for today (lib/calendar, read by
 *     loaders.ts loadTodayCalendar): their time blocks and events, repeating
 *     ones expanded exactly as /schedule shows them;
 *   - meetings booked through the pipeline today (a lead's founder_meeting_at,
 *     read by the board query), each linking to its lead;
 *   - in an OASIS workspace, whether the workspace calendar is set up
 *     (lib/integrations/google-calendar systemCalendarConfig: its credentials
 *     are present, not proof they work). It is the FALLBACK: a booking goes
 *     on the host's own Google Calendar when they have connected one, and on
 *     the workspace calendar only when they have not;
 *   - whether the viewer's own Google Calendar is connected (Settings ›
 *     Personal).
 *
 * The calendar entries and the booked meetings are one list in time order.
 * "Nothing today" is said only when BOTH were read and both are empty; a read
 * that failed says so on its own line and never counts as empty.
 *
 * "Not connected" used to be the whole story on a check that looked only at
 * the personal login (0 rows in the database) while every booking went to the
 * workspace calendar; and a failed credential read printed the same "Not
 * connected". A read that fails now says "Couldn't check".
 *
 * The OS has no reader for the rest of a Google Calendar yet, so this block
 * never claims the Google Calendar is free: the calendar lines say what is and
 * is not shown.
 *
 * Server component, no hooks.
 */
import Link from "next/link";
import { operatorTime, type CalendarStatus, type LeadLite, type Read } from "@/components/os/today/model";

/** One entry of the viewer's own Schedule calendar today. */
export type CalendarBlock = { key: string; title: string; startMs: number; endMs: number; allDay: boolean };
/** Today's calendar entries. `partial`: the calendar holds more rows than were read. */
export type CalendarDay = { blocks: CalendarBlock[]; partial: boolean };

export type ScheduleGlanceProps = {
  /** The viewer's own Schedule calendar today. Null when it is not read for this viewer. */
  blocks: Read<CalendarDay> | null;
  /** Null when this viewer's pipeline is not read here (no meetings source). */
  meetings: Read<LeadLite[]> | null;
  /** The meetings list came from a window of the board and may be incomplete. */
  partial: boolean;
  calendar: Read<CalendarStatus>;
  /** Where the calendar is connected. */
  connectHref: string;
};

/** How many rows the glance lists before "and N more". */
const SHOWN = 10;

type Row =
  | { kind: "block"; key: string; at: number; allDay: boolean; title: string; endMs: number }
  | { kind: "meeting"; key: string; at: number; allDay: false; title: string; id: string };

/**
 * What to say when no row is listed. Each source is "empty" (read, nothing in
 * it), or not: not read here, or failed / incomplete, which is never empty.
 * The combined line needs both to be empty; otherwise only what is known.
 */
function emptyText(blocks: ScheduleGlanceProps["blocks"], meetings: ScheduleGlanceProps["meetings"], partial: boolean): string | null {
  const calendarEmpty = !!blocks?.ok && !blocks.value.partial && blocks.value.blocks.length === 0;
  const meetingsEmpty = !!meetings?.ok && meetings.value.length === 0;
  const noMeetings = partial ? "no booked meetings found in the part of the board read" : "no meetings booked through the pipeline today";
  if (calendarEmpty && meetingsEmpty) return `Nothing on your Schedule today, and ${noMeetings}.`;
  if (calendarEmpty) return "Nothing on your Schedule today.";
  if (meetingsEmpty) return `${noMeetings[0].toUpperCase()}${noMeetings.slice(1)}.`;
  return null;
}

export function ScheduleGlance({ blocks, meetings, partial, calendar, connectHref }: ScheduleGlanceProps) {
  const rows: Row[] = [
    ...(blocks?.ok
      ? blocks.value.blocks.map((b): Row => ({ kind: "block", key: `b:${b.key}`, at: b.startMs, allDay: b.allDay, title: b.title, endMs: b.endMs }))
      : []),
    ...(meetings?.ok ? meetings.value.map((m): Row => ({ kind: "meeting", key: `m:${m.id}`, at: m.at, allDay: false, title: m.name, id: m.id })) : []),
  ].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.at - b.at);
  const empty = rows.length === 0 ? emptyText(blocks, meetings, partial) : null;
  const read = Boolean(blocks) || Boolean(meetings);

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

      {read && (
        <div className="space-y-2 px-4 py-3">
          {blocks && !blocks.ok && <p className="text-[13px] text-status-warm">Couldn&rsquo;t load your Schedule for today.</p>}
          {meetings && !meetings.ok && <p className="text-[13px] text-status-warm">Couldn&rsquo;t load today&rsquo;s booked meetings.</p>}
          {rows.length > 0 && (
            <ul className="space-y-1">
              {rows.slice(0, SHOWN).map((r) => (
                <li key={r.key}>
                  <Link
                    href={r.kind === "meeting" ? `/pipeline/${r.id}` : "/schedule"}
                    prefetch={false}
                    className="-mx-2 flex items-baseline gap-3 rounded-lg px-2 py-1.5 outline-none transition-colors duration-150 hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <span className="w-16 shrink-0 text-xs text-fg-dim tabular-nums">{r.allDay ? "All day" : operatorTime(r.at)}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.title}</span>
                    <span className="shrink-0 text-xs text-fg-dim">
                      {r.kind === "meeting" ? "Booked call" : r.allDay ? "" : `to ${operatorTime(r.endMs)}`}
                    </span>
                  </Link>
                </li>
              ))}
              {rows.length > SHOWN && <li className="pt-1 text-xs text-fg-dim">and {rows.length - SHOWN} more today</li>}
            </ul>
          )}
          {empty && <p className="text-[13px] text-fg-muted">{empty}</p>}
          {rows.length > 0 && meetings?.ok && meetings.value.length === 0 && partial && (
            <p className="text-xs text-fg-dim">No booked meetings found in the part of the board read.</p>
          )}
          {blocks?.ok && blocks.value.partial && (
            <p className="text-xs text-fg-dim">Only your first 5,000 calendar events were read; some may be missing.</p>
          )}
        </div>
      )}

      <div className={`space-y-1.5 px-4 py-3 text-xs ${read ? "border-t border-hairline" : ""}`}>
        {!calendar.ok ? (
          <p className="text-status-warm">Google Calendar · Couldn&rsquo;t check the connection just now.</p>
        ) : (
          <>
            {calendar.value.workspace && (
              <p className="text-fg-muted">
                {calendar.value.workspace.configured
                  ? `Workspace calendar${calendar.value.workspace.address ? ` (${calendar.value.workspace.address})` : ""} · Set up: meetings book here when a host has no Google Calendar connected.`
                  : "Workspace calendar · Not set up: a host without a connected calendar cannot be booked."}
              </p>
            )}
            {calendar.value.personal.connected ? (
              <p className="text-fg-muted">
                Your Google Calendar · Connected{calendar.value.personal.address ? ` (${calendar.value.personal.address})` : ""}.
                Its own events are not listed here yet.
              </p>
            ) : (
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-fg-muted">
                <span>{calendar.value.workspace ? "Your Google Calendar" : "Google Calendar"}</span>
                <span aria-hidden className="text-fg-dim">
                  ·
                </span>
                <span>Not connected</span>
                <Link href={connectHref} prefetch={false} className="ml-auto font-medium text-accent hover:underline">
                  Connect
                </Link>
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
