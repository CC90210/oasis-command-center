/**
 * hours.ts — when a business is actually open, in ITS OWN time zone, and
 * whether a rep is allowed to phone it right now.
 *
 * ═══ THE OPERATOR'S ASK ═════════════════════════════════════════════════════
 *
 * "Some companies are closed on Monday. Some are closed on the weekends... We
 * need to be able to track and trace exactly the company hours and put that as
 * additional information in each lead so that our reps could see the times that
 * they're able to actually reach out."
 *
 * ═══ AND THE LEGAL ONE, WHICH IS STRICTER ═══════════════════════════════════
 *
 * CRTC Unsolicited Telecommunications Rules, Part III, Rule 23:
 *
 *   "a telemarketing telecommunication is restricted to the following hours:
 *    9:00 a.m. to 9:30 p.m. on weekdays (Monday to Friday); and 10:00 a.m. to
 *    6:00 p.m. on weekends (Saturday and Sunday). The hours refer to those of
 *    the consumer receiving the telemarketing telecommunication."
 *
 * That last sentence is the whole reason this file computes anything. A Toronto
 * rep dialling Vancouver at 9:00 a.m. is calling at 6:00 a.m. there, and that is
 * a violation at up to $15,000 per call. The penalty is per call, and the
 * realistic unit price observed in CRTC enforcement is about $1,000 each
 * (Marketise Solutions, CRTC 2024-176: $198,000 across 198 violations). A rep
 * making 100 dials a day is not exposed once, they are exposed 100 times.
 * Full reasoning:
 * JARVIS/BUSINESS_CONTEXT/canada-outbound-rules/CALLING_AND_MESSAGING_RULES.md
 *
 * This file WARNS. It does not block. Blocking a dial on a derived time zone
 * would be the wrong trade: our province-to-zone mapping has known ambiguities
 * (below), and a rep who can see "it is 6:12 a.m. there" makes a better decision
 * than a button that refuses without saying why.
 *
 * ═══ WHY Intl AND NOT ARITHMETIC ════════════════════════════════════════════
 *
 * Canada spans six time zones, Saskatchewan does not observe daylight saving,
 * Newfoundland is offset by half an hour, and Yukon stopped changing its clocks
 * in 2020. Hand-rolled offset maths gets all four of those wrong. Every
 * conversion here goes through Intl.DateTimeFormat with an IANA zone, which
 * carries the real rules and the real DST transition dates.
 *
 * ═══ UNKNOWN IS A SENTENCE, NEVER A BLANK AND NEVER "OPEN" ══════════════════
 *
 * Roughly three-quarters of the corpus has no hours in OpenStreetMap at all
 * (measured 2026-08-24: 26% carry the tag). "Hours unknown" has to survive all
 * the way to the screen as words. A blank cell reads as "the page did not
 * finish loading", and defaulting to open is the exact error that wastes the
 * dial and burns the lead.
 */

/** Day keys, Monday first — the order the OSM specification uses. */
export const DAY_CODES = ["mo", "tu", "we", "th", "fr", "sa", "su"] as const;
export type DayCode = (typeof DAY_CODES)[number];

export const DAY_LABELS: Record<DayCode, string> = {
  mo: "Monday",
  tu: "Tuesday",
  we: "Wednesday",
  th: "Thursday",
  fr: "Friday",
  sa: "Saturday",
  su: "Sunday",
};

const MINUTES_IN_DAY = 1440;

/**
 * The stored blob, exactly as JARVIS's services/leadgen/lib/opening-hours.js
 * `toStored()` writes it. Intervals are `[startMinute, endMinute]` pairs from
 * local midnight; an end past 1440 is a span that runs into the next day.
 *
 * If this shape drifts on the writing side, every lead in the corpus silently
 * renders "Hours unknown" — which is why `v` is checked and why
 * tests/web-leads-hours.test.ts pins the decoder against literal blobs.
 */
export type StoredHours = {
  v: number;
  status: "parsed" | "unparsed" | "absent";
  week?: Partial<Record<DayCode, number[][]>>;
  always_open?: boolean;
  public_holidays?: "closed" | number[][] | null;
  caveats?: string[];
  reason?: string | null;
};

export type Interval = { start: number; end: number };

/** The three states a rep sees. There is no fourth, and none of them defaults. */
export type OpenState = "open" | "closed" | "unknown";

// ---------------------------------------------------------------------------
// Where the hours came from.
// ---------------------------------------------------------------------------

/**
 * Provenance, shown to the rep rather than kept in a column nobody reads.
 *
 * Two collectors feed this. OpenStreetMap's `opening_hours` tag is a curated
 * directory value. The website re-fetch reads the business's OWN page, and
 * within that there is a real difference in confidence: a schema.org
 * `openingHoursSpecification` is machine-readable and was written to be parsed,
 * whereas a line lifted out of visible page text was written to be looked at by
 * a human and might be a seasonal notice, a sister location, or a kitchen's
 * hours rather than the shop's.
 *
 * A rep is about to say this out loud to a stranger. They get to know which
 * kind of evidence they are holding, so `weak` is carried through to the screen
 * instead of being flattened into one confident-looking line.
 */
export type HoursSourceKey = "osm" | "site-jsonld" | "site-microdata" | "site-text";

export type HoursSource = {
  key: HoursSourceKey;
  /** Reads inside a sentence: "Hours from <label>." */
  label: string;
  /** True when the value came out of prose rather than structured markup. */
  weak: boolean;
};

const HOURS_SOURCES: Record<HoursSourceKey, { label: string; weak: boolean }> = {
  osm: { label: "the OpenStreetMap public directory", weak: false },
  "site-jsonld": { label: "this business's own website, from its structured data", weak: false },
  "site-microdata": { label: "this business's own website, from its structured data", weak: false },
  "site-text": { label: "this business's own website, read off the page", weak: true },
};

/**
 * Decode the stored source key, or null.
 *
 * Null for anything unrecognised rather than a guess: an unknown key means a
 * collector we do not know the confidence of, and inventing a label for it is
 * how a weak value ends up presented as a strong one.
 */
export function readHoursSource(value: unknown): HoursSource | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  const hit = HOURS_SOURCES[key as HoursSourceKey];
  return hit ? { key: key as HoursSourceKey, label: hit.label, weak: hit.weak } : null;
}

// ---------------------------------------------------------------------------
// Province -> IANA time zone.
// ---------------------------------------------------------------------------

/**
 * ONE zone per province, plus the assumption that choice makes, stated in
 * words rather than left implicit.
 *
 * Five provinces and territories genuinely span more than one zone. Choosing
 * the zone their population overwhelmingly lives in is the right call for a
 * dialer, but it is a CHOICE, and a wrong one is an hour of legal exposure.
 * So `assumption` is carried alongside and surfaced in the UI for exactly the
 * regions where it can bite, rather than being buried in a comment nobody
 * reads at 6:00 a.m. Pacific.
 *
 * The known misses, each affecting a small share of that province's businesses:
 *
 *   BC  the Peace River region (Fort St John, Dawson Creek, Chetwynd) sits on
 *       Mountain time year-round, and the eastern Kootenays (Cranbrook, Golden,
 *       Invermere) are Mountain. Both are an hour AHEAD of Vancouver, so the
 *       Vancouver assumption is the SAFE direction: we warn while they are
 *       already open, never the reverse.
 *   ON  everything west of about 90°W (Kenora, Rainy River, Atikokan) is
 *       Central, an hour BEHIND Toronto. This is the unsafe direction: a
 *       9:00 a.m. Toronto reading is 8:00 a.m. in Kenora, before the legal
 *       window opens. Flagged in the UI.
 *   QC  the Îles-de-la-Madeleine are Atlantic and Blanc-Sablon is Atlantic with
 *       no DST, both AHEAD of Montreal. Safe direction.
 *   NU  three zones. Iqaluit is Eastern, Rankin Inlet and Baker Lake are
 *       Central, Cambridge Bay is Mountain. Both alternatives are BEHIND
 *       Iqaluit, so the assumption is unsafe. Flagged.
 *   NT  effectively all Mountain; Tungsten is Pacific. Negligible, still noted.
 *   SK  Regina, which is Central WITHOUT daylight saving — that is the point of
 *       the entry. Lloydminster straddles the Alberta border and observes
 *       Mountain WITH daylight saving, so for half the year it agrees with
 *       Regina anyway.
 */
export const PROVINCE_ZONES: Record<string, { tz: string; assumption: string | null }> = {
  NL: { tz: "America/St_Johns", assumption: null },
  NS: { tz: "America/Halifax", assumption: null },
  PE: { tz: "America/Halifax", assumption: null },
  NB: { tz: "America/Moncton", assumption: null },
  QC: {
    tz: "America/Toronto",
    assumption:
      "Assumed Eastern time. The Îles-de-la-Madeleine and Blanc-Sablon are Atlantic, one hour ahead.",
  },
  ON: {
    tz: "America/Toronto",
    assumption:
      "Assumed Eastern time. Northwestern Ontario (Kenora, Rainy River, Atikokan) is Central, one hour behind, so a business there opens an hour later than shown.",
  },
  MB: { tz: "America/Winnipeg", assumption: null },
  SK: {
    tz: "America/Regina",
    assumption:
      "Saskatchewan does not change its clocks. Lloydminster, on the Alberta border, does.",
  },
  AB: { tz: "America/Edmonton", assumption: null },
  BC: {
    tz: "America/Vancouver",
    assumption:
      "Assumed Pacific time. The Peace River region and the eastern Kootenays are Mountain, one hour ahead.",
  },
  YT: { tz: "America/Whitehorse", assumption: "Yukon stopped changing its clocks in 2020." },
  NT: { tz: "America/Yellowknife", assumption: null },
  NU: {
    tz: "America/Iqaluit",
    assumption:
      "Assumed Eastern time. Nunavut spans three zones: Rankin Inlet and Baker Lake are Central and Cambridge Bay is Mountain, both behind what is shown.",
  },
};

/**
 * Province code (or full name) to a zone.
 *
 * Returns null rather than guessing when the province is missing or
 * unrecognised. A wrong zone is worse than no zone: it produces a confident
 * local time that is an hour out, which is precisely the mistake Rule 23 fines.
 */
export function zoneForProvince(
  province: string | null | undefined,
): { tz: string; assumption: string | null } | null {
  if (!province) return null;
  const key = province.trim().toUpperCase();
  if (PROVINCE_ZONES[key]) return PROVINCE_ZONES[key];
  const byName = FULL_NAMES[key];
  return byName ? PROVINCE_ZONES[byName] : null;
}

/** The long forms OSM's `addr:province` and our ingest both produce. */
const FULL_NAMES: Record<string, string> = {
  "NEWFOUNDLAND AND LABRADOR": "NL",
  "NOVA SCOTIA": "NS",
  "PRINCE EDWARD ISLAND": "PE",
  "NEW BRUNSWICK": "NB",
  QUEBEC: "QC",
  "QUÉBEC": "QC",
  ONTARIO: "ON",
  MANITOBA: "MB",
  SASKATCHEWAN: "SK",
  ALBERTA: "AB",
  "BRITISH COLUMBIA": "BC",
  YUKON: "YT",
  "NORTHWEST TERRITORIES": "NT",
  NUNAVUT: "NU",
};

// ---------------------------------------------------------------------------
// The business's own clock.
// ---------------------------------------------------------------------------

export type LocalClock = {
  /** Day of the week AT THE BUSINESS, not at the rep. */
  dayCode: DayCode;
  /** Minutes from local midnight at the business. */
  minutes: number;
  /** "6:12 am" — what a rep reads out to decide whether to dial. */
  label: string;
  tz: string;
};

const WEEKDAY_TO_CODE: Record<string, DayCode> = {
  Mon: "mo", Tue: "tu", Wed: "we", Thu: "th", Fri: "fr", Sat: "sa", Sun: "su",
};

// Intl.DateTimeFormat construction is not free and a page renders fifty leads
// across a handful of zones, so the formatters are built once per zone.
const partFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      // h23 rather than `hour12: false`: some ICU builds render midnight as
      // "24" under hour12:false, which would put a business 1,440 minutes into
      // the wrong day.
      hourCycle: "h23",
    });
  }
  partFormatters.set(tz, f);
  return f;
}

/**
 * What time is it AT THE BUSINESS?
 *
 * `now` is injected rather than read here so every caller in one render sees
 * one instant, and so the whole path is testable at a fixed moment across DST
 * boundaries. Returns null when the zone is unknown or the platform refuses it
 * — never a fallback to the viewer's own clock, which would silently answer a
 * question about Vancouver with a Toronto time.
 */
export function localClock(tz: string | null, now: Date): LocalClock | null {
  if (!tz) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = partsFormatter(tz).formatToParts(now);
  } catch {
    return null;
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayCode = WEEKDAY_TO_CODE[get("weekday")];
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (!dayCode || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const minutes = (hour % 24) * 60 + minute;
  return { dayCode, minutes, label: formatMinutes(minutes), tz };
}

/** 545 -> "9:05 am". Lowercase because it sits inside sentences, not headings. */
export function formatMinutes(minutes: number): string {
  const m = ((Math.round(minutes) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const suffix = h24 < 12 ? "am" : "pm";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

// ---------------------------------------------------------------------------
// Decoding the stored blob.
// ---------------------------------------------------------------------------

/**
 * Read whatever is on the lead into a StoredHours, or null.
 *
 * Tolerates a JSON string as well as an object: the blob travels through
 * libSQL, which hands JSON columns back as TEXT, and a strict `typeof ===
 * "object"` check is the shape that breaks in production and nowhere else.
 * Anything unrecognised returns null, which renders as the unknown sentence.
 */
export function readStoredHours(value: unknown): StoredHours | null {
  let v: unknown = value;
  if (typeof v === "string") {
    if (!v.trim()) return null;
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const status = o.status;
  if (status !== "parsed" && status !== "unparsed" && status !== "absent") return null;
  // A future schema version may mean anything at all. Refusing to read it shows
  // the raw string, which is always safe; guessing at it is not.
  if (typeof o.v !== "number" || o.v !== 1) return null;
  return o as StoredHours;
}

/** One day's intervals out of the stored pairs, defensively. */
export function intervalsFor(stored: StoredHours | null, day: DayCode): Interval[] {
  if (!stored || stored.status !== "parsed" || !stored.week) return [];
  const raw = stored.week[day];
  if (!Array.isArray(raw)) return [];
  const out: Interval[] = [];
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [start, end] = pair;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    out.push({ start, end });
  }
  return out;
}

/**
 * Open, closed, or unknown — computed in the BUSINESS'S local time.
 *
 * Mirrors openStateAt() in JARVIS's services/leadgen/lib/opening-hours.js,
 * including the previous-day check that keeps a late-night business open at
 * 1:00 a.m. The two are deliberately small and separately tested rather than
 * shared across repos; if they ever disagree, the JARVIS one is the definition.
 */
export function openState(stored: StoredHours | null, clock: LocalClock | null): OpenState {
  if (!stored || stored.status !== "parsed" || !clock) return "unknown";
  for (const iv of intervalsFor(stored, clock.dayCode)) {
    if (clock.minutes >= iv.start && clock.minutes < iv.end) return "open";
  }
  // Yesterday's span may still be running: `Fr 20:00-02:00` is open at 1:00 a.m.
  // on Saturday. Without this every late-night business reads as shut at exactly
  // the hour it is open.
  const idx = DAY_CODES.indexOf(clock.dayCode);
  const prev = DAY_CODES[(idx + 6) % 7];
  const carried = clock.minutes + MINUTES_IN_DAY;
  for (const iv of intervalsFor(stored, prev)) {
    if (iv.end > MINUTES_IN_DAY && carried >= iv.start && carried < iv.end) return "open";
  }
  return "closed";
}

/**
 * The next time the door state changes, within the coming week.
 *
 * Not decoration: "Opens at 9:00 am" is the difference between a rep skipping a
 * lead and a rep scheduling it. Returns null when nothing changes in seven days
 * (always open, or never open) — both of which are said in words elsewhere.
 */
export function nextTransition(
  stored: StoredHours | null,
  clock: LocalClock | null,
): { kind: "opens" | "closes"; label: string; day: DayCode; daysAhead: number } | null {
  if (!stored || stored.status !== "parsed" || !clock) return null;
  if (stored.always_open) return null;
  const state = openState(stored, clock);
  const startIdx = DAY_CODES.indexOf(clock.dayCode);

  if (state === "open") {
    // The interval we are inside ends first. Check today, then a span carried
    // over from yesterday.
    for (const iv of intervalsFor(stored, clock.dayCode)) {
      if (clock.minutes >= iv.start && clock.minutes < iv.end) {
        return { kind: "closes", label: formatMinutes(iv.end), day: clock.dayCode, daysAhead: iv.end >= MINUTES_IN_DAY ? 1 : 0 };
      }
    }
    const prev = DAY_CODES[(startIdx + 6) % 7];
    for (const iv of intervalsFor(stored, prev)) {
      const carried = clock.minutes + MINUTES_IN_DAY;
      if (iv.end > MINUTES_IN_DAY && carried >= iv.start && carried < iv.end) {
        return { kind: "closes", label: formatMinutes(iv.end), day: clock.dayCode, daysAhead: 0 };
      }
    }
    return null;
  }

  // Closed: the next opening is the earliest interval start from now onward.
  for (let ahead = 0; ahead < 8; ahead += 1) {
    const day = DAY_CODES[(startIdx + ahead) % 7];
    for (const iv of intervalsFor(stored, day)) {
      if (ahead === 0 && iv.start <= clock.minutes) continue;
      return { kind: "opens", label: formatMinutes(iv.start), day, daysAhead: ahead };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The week, as text.
// ---------------------------------------------------------------------------

/** "9:00 am to 5:00 pm", or a span that runs past midnight written as such. */
export function formatInterval(iv: Interval): string {
  if (iv.start === 0 && iv.end >= MINUTES_IN_DAY) return "Open 24 hours";
  return `${formatMinutes(iv.start)} to ${formatMinutes(iv.end)}`;
}

/** One day's hours as a rep would say them. "Closed" when there are none. */
export function formatDay(intervals: Interval[]): string {
  if (intervals.length === 0) return "Closed";
  return intervals.map(formatInterval).join(", ");
}

export type WeekRow = { day: DayCode; label: string; hours: string; isToday: boolean };

/**
 * The whole week, always seven rows.
 *
 * Seven rows even when a day is closed, because a MISSING Monday row and a
 * Monday row saying "Closed" look the same to a glancing eye and mean opposite
 * things. Returns an empty array only when there is no grid at all, which the
 * caller renders as the unknown sentence instead.
 */
export function weekRows(stored: StoredHours | null, clock: LocalClock | null): WeekRow[] {
  if (!stored || stored.status !== "parsed") return [];
  return DAY_CODES.map((day) => ({
    day,
    label: DAY_LABELS[day],
    hours: formatDay(intervalsFor(stored, day)),
    isToday: clock?.dayCode === day,
  }));
}

// ---------------------------------------------------------------------------
// The legal calling window. CRTC UTR Part III, Rule 23.
// ---------------------------------------------------------------------------

/**
 * 9:00 a.m. to 9:30 p.m. Monday to Friday; 10:00 a.m. to 6:00 p.m. Saturday and
 * Sunday. IN THE RECIPIENT'S LOCAL TIME — the rule says so explicitly, and that
 * is the half reps get wrong from a single office.
 */
export const CALL_WINDOW: Record<DayCode, { start: number; end: number }> = {
  mo: { start: 9 * 60, end: 21 * 60 + 30 },
  tu: { start: 9 * 60, end: 21 * 60 + 30 },
  we: { start: 9 * 60, end: 21 * 60 + 30 },
  th: { start: 9 * 60, end: 21 * 60 + 30 },
  fr: { start: 9 * 60, end: 21 * 60 + 30 },
  sa: { start: 10 * 60, end: 18 * 60 },
  su: { start: 10 * 60, end: 18 * 60 },
};

export type CallWindow =
  | { allowed: true; window: string }
  | { allowed: false; window: string; reason: string }
  | { allowed: null; reason: string };

/**
 * May a rep legally dial this business right now?
 *
 * `allowed: null` means we could not work out the business's zone. That is NOT
 * permission and it is NOT a refusal — it is "we do not know", and it is said in
 * those words, because a caution that appears only when we happen to have a
 * province would train reps to read its absence as an all-clear.
 */
export function callWindowState(clock: LocalClock | null): CallWindow {
  if (!clock) {
    return {
      allowed: null,
      reason:
        "No province on file, so the local time where this business is cannot be worked out. Confirm it before dialling.",
    };
  }
  const w = CALL_WINDOW[clock.dayCode];
  const window = `${formatMinutes(w.start)} to ${formatMinutes(w.end)} their time`;
  if (clock.minutes >= w.start && clock.minutes < w.end) return { allowed: true, window };
  return {
    allowed: false,
    window,
    // "Canadian telemarketing rules" and not a bare "calls are permitted".
    // This sentence sits near a business's own hours, and the operator read an
    // unattributed legal window as a claim about the PROSPECT: identical times
    // on every card, in the place a rep looks for that shop's hours, reads as
    // invented data. Naming whose rule it is makes it unmistakably about us.
    reason: `It is ${clock.label} where this business is. Canadian telemarketing rules permit calls ${window}.`,
  };
}

/**
 * Everything one lead's hours amount to, resolved once.
 *
 * The list, the drawer and the battle card all render from this, so the three
 * of them can never print a different open/closed state for the same business
 * while a rep is on the phone.
 */
export type LeadHours = {
  tz: string | null;
  zoneAssumption: string | null;
  clock: LocalClock | null;
  stored: StoredHours | null;
  raw: string | null;
  /** Where the hours came from, or null when we hold none. */
  source: HoursSource | null;
  state: OpenState;
  /** The single line a rep reads: "Open now", "Closed now", "Hours unknown". */
  headline: string;
  /** A full sentence expanding the headline. Never empty. */
  detail: string;
  week: WeekRow[];
  caveats: string[];
  call: CallWindow;
};

export function leadHours(
  input: {
    province: string | null;
    openingHours: unknown;
    openingHoursRaw: string | null;
    openingHoursCheckedAt?: string | null;
    openingHoursSource?: unknown;
  },
  now: Date,
): LeadHours {
  const zone = zoneForProvince(input.province);
  const tz = zone?.tz ?? null;
  const clock = localClock(tz, now);
  const stored = readStoredHours(input.openingHours);
  const raw = input.openingHoursRaw && input.openingHoursRaw.trim() ? input.openingHoursRaw.trim() : null;
  // Provenance is only meaningful when we actually hold something. A source key
  // sitting on a lead with no hours would render "Hours from their website"
  // under a sentence saying we have no hours, which is the same class of
  // confusing-but-confident output this whole change exists to remove.
  const source = stored || raw ? readHoursSource(input.openingHoursSource) : null;
  const state = openState(stored, clock);
  const next = nextTransition(stored, clock);

  let headline: string;
  let detail: string;
  if (state === "open") {
    headline = "Open now";
    detail = next
      ? `Open now, and closes at ${next.label} their time.`
      : "Open now.";
    if (stored?.always_open) detail = "Open 24 hours.";
  } else if (state === "closed") {
    headline = "Closed now";
    if (next) {
      const when =
        next.daysAhead === 0 ? "later today"
          : next.daysAhead === 1 ? "tomorrow"
            : `on ${DAY_LABELS[next.day]}`;
      detail = `Closed now. Opens ${when} at ${next.label} their time.`;
    } else {
      detail = "Closed now, and the hours we hold show no opening in the next week.";
    }
  } else {
    // THREE different reasons we cannot say, kept apart. "We hold a string we
    // could not read" is a different fact from "the directory has nothing", and
    // a rep who knows which one it is knows whether to trust the raw line
    // beneath or to ask on the call.
    headline = "Hours unknown";
    if (stored?.status === "unparsed" && raw) {
      detail = `We hold opening hours for this business but could not read them reliably, so they are shown exactly as recorded. Confirm on the call.`;
    } else if (!tz) {
      detail = "No province on file, so we cannot work out the local time where this business is. Confirm the hours on the call.";
    } else if (!input.openingHoursCheckedAt) {
      // "Nobody has looked" and "we looked and found nothing" are different
      // facts and a rep acts on them differently. Collapsing them into one
      // sentence is how a gap in OUR collection gets read as a fact about the
      // business.
      detail = "Nobody has checked this business's hours yet. Ask when they open.";
    } else {
      detail = "We looked and found no published hours for this business. Ask when they open.";
    }
  }

  return {
    tz,
    zoneAssumption: zone?.assumption ?? null,
    clock,
    stored,
    raw,
    source,
    state,
    headline,
    detail,
    week: weekRows(stored, clock),
    caveats: Array.isArray(stored?.caveats) ? stored!.caveats!.filter((c) => typeof c === "string") : [],
    call: callWindowState(clock),
  };
}
