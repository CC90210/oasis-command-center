/**
 * Calendar domain types. Shared by the API routes, the store and the client.
 *
 * Time representation:
 *   - Timed events store `start`/`end` as UTC ISO instants.
 *   - All-day events store `start`/`end` as local dates (`YYYY-MM-DD`), with
 *     `end` EXCLUSIVE, the same convention Google Calendar and iCalendar use.
 *     A one-day all-day event on the 3rd is start=03, end=04.
 *
 * Recurring series: one master row carries `recurrence`. A single edited
 * occurrence is a separate row with `recurringEventId` + `originalStart`
 * (the occurrence's unedited start key). A deleted occurrence is listed in
 * the master's `exdates`. That is the iCalendar RECURRENCE-ID / EXDATE model.
 */

export const CALENDAR_COLORS = [
  "tide",
  "moss",
  "saffron",
  "ember",
  "coral",
  "rose",
  "jade",
  "sky",
  "sand",
  "slate",
] as const;
export type CalendarColor = (typeof CALENDAR_COLORS)[number];

export const CALENDAR_COLOR_LABELS: Record<CalendarColor, string> = {
  tide: "Tide",
  moss: "Moss",
  saffron: "Saffron",
  ember: "Ember",
  coral: "Coral",
  rose: "Rose",
  jade: "Jade",
  sky: "Sky",
  sand: "Sand",
  slate: "Slate",
};

export type CalendarRecord = {
  id: string;
  name: string;
  color: CalendarColor;
  visible: boolean;
  isDefault: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export type Recurrence = {
  freq: RecurrenceFreq;
  /** Every N units. 1..99. */
  interval: number;
  /** WEEKLY only. 0 = Sunday … 6 = Saturday. */
  byWeekday?: number[];
  /** MONTHLY only. "day" = same day of month, "nth" = e.g. 2nd Tuesday. */
  monthlyMode?: "day" | "nth";
  /** MONTHLY "nth" only: 1..4, or -1 for "last". Absent = implied by the first date. */
  nth?: number;
  /** Last date an occurrence may START on, inclusive, `YYYY-MM-DD`. */
  until?: string;
  /** Total occurrences, including the first. */
  count?: number;
};

export type EventRecord = {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  recurrence: Recurrence | null;
  exdates: string[];
  recurringEventId: string | null;
  originalStart: string | null;
  color: CalendarColor | null;
  /** Minutes before start. */
  reminders: number[];
  guests: string[];
  /** false = shows as free. */
  busy: boolean;
  createdAt: string;
  updatedAt: string;
};

/** The writable subset a client sends. Server stamps id/timestamps. */
export type EventInput = Omit<EventRecord, "id" | "createdAt" | "updatedAt">;

export type CalendarLocation = { label: string; lat: number; lon: number };

export type CalendarPrefs = {
  weekStartsOn: 0 | 1 | 6;
  showWeekends: boolean;
  defaultDurationMin: number;
  /**
   * Where sunrise/sunset (and therefore Shabbat) is computed for. Null until
   * the user picks one: a client workspace is never handed OASIS's city.
   * Shabbat protection needs a location (validatePrefs refuses it without one).
   */
  location: CalendarLocation | null;
  /** Candle lighting, minutes before Friday sunset. */
  candleMinutesBeforeSunset: number;
  /** Shabbat ends this many minutes after Saturday sunset. */
  havdalahMinutesAfterSunset: number;
  shabbatProtection: boolean;
};

/**
 * The OASIS home workspace (slug `oasis-ai-cc`). Its members get the
 * Montréal + Shabbat defaults below. Declared here rather than imported from
 * lib/platform-operator.ts because this file ships to the browser and that one
 * reads the database; tests/calendar-routine.test.ts asserts the two agree.
 */
export const OASIS_HOME_TENANT_ID = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

/** Defaults for the OASIS workspace: Montréal, Shabbat protected. */
export const DEFAULT_PREFS: CalendarPrefs = {
  weekStartsOn: 0,
  showWeekends: true,
  defaultDurationMin: 60,
  location: { label: "Montréal", lat: 45.5017, lon: -73.5673 },
  candleMinutesBeforeSunset: 18,
  // Deliberately the later (more protective) common custom. The lock exists to
  // stop anything being booked inside Shabbat; an end time that is too EARLY is
  // the failure that matters, one that is too late only blocks a little more of
  // Saturday night. Adjustable in settings.
  havdalahMinutesAfterSunset: 72,
  shabbatProtection: true,
};

/**
 * Defaults for every other workspace: no location and no Shabbat lock until
 * the user sets them. The offsets are kept so that turning protection on
 * later starts from the same common customs.
 */
export const NEUTRAL_PREFS: CalendarPrefs = {
  ...DEFAULT_PREFS,
  location: null,
  shabbatProtection: false,
};

/** The preferences a user has before saving any: OASIS's for OASIS, neutral elsewhere. */
export function defaultPrefsFor(tenantId: string): CalendarPrefs {
  return tenantId === OASIS_HOME_TENANT_ID ? DEFAULT_PREFS : NEUTRAL_PREFS;
}

/** One rendered instance of an event on the calendar. */
export type Occurrence = {
  /** Stable per instance: `${seriesId}@${originalStart}` or the event id. */
  key: string;
  event: EventRecord;
  /** The master row, when this instance belongs to a series. */
  master: EventRecord | null;
  start: Date;
  end: Date;
  allDay: boolean;
  /** Unedited start key of this instance within its series. */
  originalStart: string | null;
};

export type CalendarView = "day" | "4day" | "week" | "month" | "year" | "schedule";

export type EditScope = "this" | "following" | "all";

/** A single persisted mutation. A user action may plan several. */
export type EventOp =
  | { op: "create"; tempId?: string; event: EventInput }
  | { op: "update"; id: string; patch: Partial<EventInput> }
  | { op: "delete"; id: string };
