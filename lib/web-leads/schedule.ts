/**
 * lib/web-leads/schedule.ts — turning a rep's own leads into the things that
 * are actually on their calendar.
 *
 * WHY A SEPARATE MODULE. The rep's day exists as two fields scattered across
 * lead records (`next_action_at` for a callback they promised, and
 * `founder_meeting_at` for a meeting that got booked). Rep Today already reads
 * the first to rank a call queue. A calendar needs BOTH, grouped by day, and
 * needs them shaped identically so a week view does not have to know which
 * field a given entry came from. Doing that inline in a component would mean
 * the calendar and the queue could disagree about what "today" contains.
 *
 * PURE. No I/O, no database, no clock of its own -- `now` is passed in. That is
 * what makes a calendar testable at all: "what does the week of the 3rd look
 * like" is a question you can only ask a function that does not read the
 * system clock.
 *
 * IT NEVER INVENTS AN ENTRY. A lead with no scheduled time produces nothing.
 * The empty calendar of a rep who has not booked anything is the truth, and
 * padding it with "unscheduled" rows would turn the one screen that answers
 * "what am I committed to" into another list of everything.
 */

export type ScheduleKind = "callback" | "meeting";

export type ScheduleEntry = {
  leadId: string;
  businessName: string;
  phone: string | null;
  kind: ScheduleKind;
  /** ISO instant. */
  at: string;
  /** Milliseconds since epoch, for sorting without re-parsing. */
  atMs: number;
  /** The disposition that produced a callback. Null for a meeting. */
  lastDisposition: string | null;
  /** True when this is in the past and still on the books. */
  overdue: boolean;
};

export type ScheduleDay = {
  /** YYYY-MM-DD in the viewer's own timezone, used as a stable key. */
  key: string;
  /** Midnight of that local day, as an instant. */
  startMs: number;
  entries: ScheduleEntry[];
};

type LeadRow = { id: string; data: Record<string, unknown> };

const str = (d: Record<string, unknown>, k: string): string =>
  typeof d[k] === "string" ? (d[k] as string).trim() : "";

/** A local-day key. Built from the date parts rather than an ISO slice, because
 *  an ISO slice is UTC: a 9pm Toronto callback would file itself under
 *  tomorrow, and a rep would find an empty Thursday and a stranger on Friday. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Midnight of the local day containing `ms`. */
export function localDayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Every scheduled commitment on these leads, flattened and sorted.
 *
 * A single lead can legitimately contribute TWO entries -- a booked meeting and
 * a separate callback -- and both must appear. Collapsing them to one per lead
 * would silently drop whichever the code happened to check second, and the one
 * that goes missing is the one the rep does not attend.
 */
export function scheduleEntries(rows: LeadRow[], nowMs: number): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];

  for (const row of rows) {
    const data = row.data || {};
    const businessName = str(data, "business_name") || str(data, "name") || "Untitled lead";
    const phone = str(data, "phone") || null;

    const push = (raw: string, kind: ScheduleKind) => {
      if (!raw) return;
      const atMs = Date.parse(raw);
      // An unparseable date is dropped rather than rendered as "Invalid Date".
      // A calendar row a rep cannot act on is worse than a row that is absent.
      if (!Number.isFinite(atMs)) return;
      out.push({
        leadId: row.id,
        businessName,
        phone,
        kind,
        at: new Date(atMs).toISOString(),
        atMs,
        lastDisposition: kind === "callback" ? str(data, "last_disposition") || null : null,
        overdue: atMs < nowMs,
      });
    };

    push(str(data, "next_action_at"), "callback");
    push(str(data, "founder_meeting_at"), "meeting");
  }

  return out.sort((a, b) => a.atMs - b.atMs);
}

/**
 * Group entries into consecutive local days, starting at `fromMs`'s day and
 * running `days` forward.
 *
 * EVERY DAY IN THE RANGE IS PRESENT, including empty ones. A calendar that only
 * renders days with something in them is a list wearing a calendar's name: the
 * gaps are the information -- they are where a rep can book something.
 *
 * Anything already overdue is NOT folded into today. It is returned separately
 * so a surface can lead with it, because a promise a rep has already missed is
 * the single most urgent thing on the screen and burying it inside today's
 * column is how it stays missed.
 */
export function groupIntoDays(
  entries: ScheduleEntry[],
  fromMs: number,
  days: number,
): { overdue: ScheduleEntry[]; days: ScheduleDay[] } {
  const overdue = entries.filter((e) => e.overdue);
  const scheduled = entries.filter((e) => !e.overdue);

  const byKey = new Map<string, ScheduleEntry[]>();
  for (const e of scheduled) {
    const key = localDayKey(e.atMs);
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }

  const start = localDayStart(fromMs);
  const out: ScheduleDay[] = [];
  for (let i = 0; i < days; i++) {
    // Rebuilt from a Date each step rather than adding 86_400_000, so a DST
    // change does not shift every subsequent day by an hour and file a 12:30am
    // callback under the previous date.
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dayStart = d.getTime();
    const key = localDayKey(dayStart);
    out.push({ key, startMs: dayStart, entries: byKey.get(key) || [] });
  }
  return { overdue, days: out };
}

/** How many real commitments are in a grouped result. Counts overdue too --
 *  they are still commitments, and a header that excluded them would read
 *  "nothing scheduled" to a rep with four missed callbacks. */
export function countCommitments(grouped: { overdue: ScheduleEntry[]; days: ScheduleDay[] }): number {
  return grouped.overdue.length + grouped.days.reduce((n, d) => n + d.entries.length, 0);
}
