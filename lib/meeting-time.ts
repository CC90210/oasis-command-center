/**
 * Meeting times in the PROSPECT's time zone. Pure and client-safe.
 *
 * Reps call trades across Canada from Montreal. "Two o'clock" on the phone is
 * the prospect's two o'clock; the instant sent to Google is what matters, and
 * Google shows each attendee their own local time. The Pipeline wizard keeps
 * its Eastern-only picker (founderMeetingIso in LeadLifecycleActions.tsx);
 * deduping the two conversions is a follow-up.
 */
export const EASTERN_TIME_ZONE = "America/Toronto";

export type ProspectZone = { timeZone: string; label: string; known: boolean };

const ZONE_BY_PROVINCE: Record<string, { timeZone: string; label: string }> = {
  BC: { timeZone: "America/Vancouver", label: "Pacific time" },
  YT: { timeZone: "America/Whitehorse", label: "Yukon time" },
  AB: { timeZone: "America/Edmonton", label: "Mountain time" },
  NT: { timeZone: "America/Edmonton", label: "Mountain time" },
  SK: { timeZone: "America/Regina", label: "Saskatchewan time" },
  MB: { timeZone: "America/Winnipeg", label: "Central time" },
  ON: { timeZone: "America/Toronto", label: "Eastern time" },
  QC: { timeZone: "America/Toronto", label: "Eastern time" },
  NB: { timeZone: "America/Halifax", label: "Atlantic time" },
  NS: { timeZone: "America/Halifax", label: "Atlantic time" },
  PE: { timeZone: "America/Halifax", label: "Atlantic time" },
  NL: { timeZone: "America/St_Johns", label: "Newfoundland time" },
};

const PROVINCE_CODE_BY_NAME: Record<string, string> = {
  "british columbia": "BC",
  yukon: "YT",
  alberta: "AB",
  "northwest territories": "NT",
  saskatchewan: "SK",
  manitoba: "MB",
  ontario: "ON",
  quebec: "QC",
  "québec": "QC",
  "new brunswick": "NB",
  "nova scotia": "NS",
  "prince edward island": "PE",
  "newfoundland and labrador": "NL",
  newfoundland: "NL",
};

/** Every zone a rep can pick by hand, deduplicated, west to east. */
export const ZONE_CHOICES: readonly { timeZone: string; label: string }[] = [
  ZONE_BY_PROVINCE.BC, ZONE_BY_PROVINCE.YT, ZONE_BY_PROVINCE.AB, ZONE_BY_PROVINCE.SK,
  ZONE_BY_PROVINCE.MB, ZONE_BY_PROVINCE.ON, ZONE_BY_PROVINCE.NS, ZONE_BY_PROVINCE.NL,
];

/**
 * The zone a lead's province implies. Unknown, empty or multi-zone (Nunavut)
 * returns Eastern with known:false, and the panel says "Times are Eastern".
 * Edge towns (Kenora, Lloydminster, the Magdalen Islands) are why the rep can
 * override it.
 */
export function prospectTimeZone(province: string | null | undefined): ProspectZone {
  const raw = (province || "").trim();
  const code = raw.length === 2 ? raw.toUpperCase() : PROVINCE_CODE_BY_NAME[raw.toLowerCase()] ?? "";
  const zone = ZONE_BY_PROVINCE[code];
  return zone ? { ...zone, known: true } : { timeZone: EASTERN_TIME_ZONE, label: "Eastern time", known: false };
}

/** 07:00 to 20:45 local, every 15 minutes. Fewer, likelier choices than all 96. */
export const MEETING_TIME_OPTIONS: readonly { value: string; label: string }[] = Array.from(
  { length: 56 },
  (_, index) => {
    const total = 7 * 60 + index * 15;
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    const mm = String(minutes).padStart(2, "0");
    return {
      value: `${String(hours).padStart(2, "0")}:${mm}`,
      label: `${hours % 12 || 12}:${mm} ${hours < 12 ? "a.m." : "p.m."}`,
    };
  },
);

function partsIn(timeZone: string, instant: number): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** YYYY-MM-DD for "today plus N days" as the prospect's calendar sees it. */
export function dateChoiceInZone(daysFromToday: number, timeZone: string, now: number = Date.now()): string {
  const v = partsIn(timeZone, now);
  return new Date(Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day) + daysFromToday))
    .toISOString()
    .slice(0, 10);
}

/**
 * The UTC instant for a wall-clock date and time in `timeZone`, or null when
 * that wall-clock time does not exist there (the spring-forward gap) or the
 * input is malformed. Same three-pass correction as the Pipeline wizard.
 */
export function meetingIsoInZone(date: string, time: string, timeZone: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const target = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const p = partsIn(timeZone, instant);
    const observed = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    instant += target - observed;
  }
  const v = partsIn(timeZone, instant);
  const roundTrip = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), Number(v.hour), Number(v.minute));
  return roundTrip === target ? new Date(instant).toISOString() : null;
}

/** "Tue, Oct 6, 2:00 p.m." in the given zone. */
export function formatMeetingInZone(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
