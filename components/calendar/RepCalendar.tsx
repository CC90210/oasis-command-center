/**
 * RepCalendar — what a rep is committed to, by day.
 *
 * WHY THIS EXISTS ALONGSIDE REP TODAY (Adon, 2026-08-24): "we want to feature
 * that there's a calendar on the software as well where you'd be able to track
 * your meetings, but it will be on Google Calendar mostly just so that they get
 * the notification on their phones in case they forget or they're not looking
 * at the software."
 *
 * So the two surfaces answer different questions and neither replaces the
 * other. Rep Today answers "who do I call NEXT" -- one ranked list, worked top
 * to bottom. This answers "what am I committed to THIS WEEK", which is the
 * question you ask before promising a prospect a time. Google Calendar remains
 * the notification channel, because a phone in a pocket beats a browser tab a
 * rep is not looking at.
 *
 * THE EMPTY DAYS ARE THE POINT. Every day in the range renders whether or not
 * it has anything in it. A calendar that only shows days with entries is a list
 * wearing a calendar's name; the gaps are what a rep books INTO, and hiding
 * them removes the one thing this view adds over Rep Today.
 *
 * OVERDUE LEADS, IT DOES NOT NEST. A promise already missed is the most urgent
 * thing on the screen, so it sits above the week rather than inside today's
 * column where it would keep being missed.
 *
 * SCOPING IS THE FETCH, NOT THE RENDER. Same discipline as RepToday: the query
 * is `where assigned_to = me` and then narrowed again by the shared pipeline
 * policy. Nothing about another rep's book, and nothing about company revenue,
 * is ever read on this path -- so it cannot leak through the RSC payload.
 */

import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/Card";
import { PhoneCall, Users, AlertCircle } from "lucide-react";
import { listRecords, type TenantRecord } from "@/lib/manifest/data";
import { filterWebsiteSalesRows } from "@/lib/oasis-sales-pipeline-policy";
import {
  scheduleEntries,
  groupIntoDays,
  countCommitments,
  type ScheduleEntry,
} from "@/lib/web-leads/schedule";

/** Two weeks. Long enough to hold the callbacks a rep sets on a Friday for the
 *  following week, short enough that the page is scannable without paging. */
const DAYS_SHOWN = 14;

type Read<T> = { ok: true; value: T } | { ok: false };

async function loadMyBook(
  tenantId: string,
  userId: string,
  teamRole: string,
): Promise<Read<TenantRecord[]>> {
  try {
    const result = await listRecords({
      tenant_id: tenantId,
      entity: "lead",
      where: { assigned_to: userId.toLowerCase() },
      limit: 300,
    });
    return {
      ok: true,
      value: filterWebsiteSalesRows(result.rows, {
        role: teamRole,
        userId,
        isOwner: false,
        adminAccess: false,
      }),
    };
  } catch {
    return { ok: false };
  }
}

function dayLabel(startMs: number, todayKey: string, key: string): { title: string; sub: string } {
  const d = new Date(startMs);
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  const sub = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (key === todayKey) return { title: "Today", sub: `${weekday}, ${sub}` };
  return { title: weekday, sub };
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function EntryRow({ entry }: { entry: ScheduleEntry }) {
  const isMeeting = entry.kind === "meeting";
  return (
    <li>
      <Link
        href={`/web-leads?lead=${encodeURIComponent(entry.leadId)}`}
        className="flex items-baseline gap-3 rounded-md px-2 py-2 transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
      >
        <span className="w-[4.5rem] shrink-0 text-xs font-semibold tabular-nums text-fg-muted">
          {timeLabel(entry.at)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {isMeeting
              ? <Users className="h-3.5 w-3.5 shrink-0 text-fg-dim" />
              : <PhoneCall className="h-3.5 w-3.5 shrink-0 text-fg-dim" />}
            <span className="truncate text-sm font-medium text-fg">{entry.businessName}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-fg-faint">
            {isMeeting ? "Booked meeting" : "Callback"}
            {entry.lastDisposition ? ` · last call: ${entry.lastDisposition.replace(/_/g, " ")}` : ""}
            {entry.phone ? ` · ${entry.phone}` : ""}
          </span>
        </span>
      </Link>
    </li>
  );
}

export async function RepCalendar({
  tenantId,
  userId,
  teamRole,
  calendarConnected,
}: {
  tenantId: string;
  userId: string;
  teamRole: string;
  /** Whether this rep has linked Google. Drives an invitation, never a warning:
   *  an unconnected rep still has a complete, working calendar here. */
  calendarConnected: boolean;
}) {
  const read = await loadMyBook(tenantId, userId, teamRole);
  const nowMs = Date.now();

  // A failed read is NOT an empty week. Saying "nothing scheduled" to a rep
  // whose database call failed is the one message that would make them stop
  // checking, so the two states are rendered separately and always have been.
  if (!read.ok) {
    return (
      <div className="space-y-5">
        <PageHeader title="Calendar" subtitle="Your callbacks and booked meetings." />
        <Card noPadding>
          <div className="flex items-start gap-3 p-4 text-sm text-amber-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">Could not load your calendar.</p>
              <p className="mt-1 text-xs text-amber-300/80">
                This is a loading problem, not an empty week. Refresh, and tell an admin if it keeps happening.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  const entries = scheduleEntries(read.value, nowMs);
  const grouped = groupIntoDays(entries, nowMs, DAYS_SHOWN);
  const total = countCommitments(grouped);
  const todayKey = grouped.days[0]?.key ?? "";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Calendar"
        subtitle={
          total === 0
            ? "Nothing scheduled yet. Callbacks you set while logging a call show up here."
            : `${total} commitment${total === 1 ? "" : "s"} over the next two weeks.`
        }
      />

      {!calendarConnected && (
        <Card noPadding>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-fg">Get these on your phone</p>
              <p className="mt-0.5 text-xs text-fg-muted">
                Connect Google Calendar and every callback you schedule arrives with a reminder 10 minutes before.
                Your calendar here works either way.
              </p>
            </div>
            <Link
              href="/settings#integrations"
              className="shrink-0 rounded-md border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-fg transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              Connect calendar
            </Link>
          </div>
        </Card>
      )}

      {grouped.overdue.length > 0 && (
        <Card noPadding>
          <div className="border-b border-bg-border px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-amber-300">
              Past due · {grouped.overdue.length}
            </p>
            <p className="mt-0.5 text-xs text-fg-muted">You told these people you would call. Clear them first.</p>
          </div>
          <ul className="p-2">
            {grouped.overdue.map((e) => <EntryRow key={`${e.leadId}-${e.kind}-${e.atMs}`} entry={e} />)}
          </ul>
        </Card>
      )}

      <div className="space-y-3">
        {grouped.days.map((day) => {
          const { title, sub } = dayLabel(day.startMs, todayKey, day.key);
          const isToday = day.key === todayKey;
          return (
            <Card key={day.key} noPadding>
              <div className={`flex items-baseline justify-between gap-3 px-4 py-2.5 ${day.entries.length ? "border-b border-bg-border" : ""}`}>
                <div className="flex items-baseline gap-2">
                  <span className={`text-sm font-bold ${isToday ? "text-accent" : "text-fg"}`}>{title}</span>
                  <span className="text-xs text-fg-faint">{sub}</span>
                </div>
                {day.entries.length > 0 && (
                  <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-faint">
                    {day.entries.length}
                  </span>
                )}
              </div>
              {day.entries.length > 0 && (
                <ul className="p-2">
                  {day.entries.map((e) => <EntryRow key={`${e.leadId}-${e.kind}-${e.atMs}`} entry={e} />)}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      {total === 0 && (
        <Card>
          <EmptyState message="When you log a call and set a next attempt, or book a meeting, it lands here and on your phone." />
        </Card>
      )}
    </div>
  );
}
