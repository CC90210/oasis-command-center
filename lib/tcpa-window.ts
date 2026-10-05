/**
 * lib/tcpa-window.ts — recipient-local TCPA calling-hours check
 * (Phase 3, plan §3/§7: "SendSplitButton scheduling + TCPA 8am-9pm
 * recipient-local warning").
 *
 * The TCPA (47 U.S.C. § 227) restricts SMS/telemarketing contact to
 * 8:00am-9:00pm in the RECIPIENT's local time. This module estimates that
 * local time from the recipient's NANP area code — the same coarse
 * approximation Twilio/most CPaaS dashboards use, since true per-number
 * geolocation isn't available from a phone number alone.
 *
 * The table below is a best-effort, non-exhaustive map of the most common
 * US/Canada area codes to an IANA zone. It intentionally keeps Arizona on
 * `America/Phoenix` (no DST) rather than lumping it into `America/Denver`,
 * since that's the one case where the DST difference regularly flips
 * whether 8pm-9pm sends are inside/outside the window. Split/overlay codes
 * that straddle two zones are assigned to their dominant zone — an
 * approximation, not a guarantee. An area code NOT in the table (non-NANP
 * number, toll-free, VoIP-ported, or simply missing from this list) falls
 * back to the VIEWER's own timezone with `usedFallback: true` — callers
 * MUST surface that caveat rather than silently treating it as verified.
 */

const EASTERN = "America/New_York";
const CENTRAL = "America/Chicago";
const MOUNTAIN = "America/Denver";
const ARIZONA = "America/Phoenix"; // Mountain, no DST
const PACIFIC = "America/Los_Angeles";
const ALASKA = "America/Anchorage";
const HAWAII = "Pacific/Honolulu";
const ATLANTIC = "America/Halifax";
const NEWFOUNDLAND = "America/St_Johns";

// US TERRITORIES. Added 2026-08-14, and not for completeness — the drip
// executor sends unmapped area codes at a fixed 18:00 UTC, an hour picked
// because it is inside 8am-9pm for every zone from Hawaii to Maine. That
// reasoning silently excluded the territories, and they break it in BOTH
// directions: 18:00 UTC is 04:00 next day in Guam and 07:00 in American Samoa,
// each on the wrong side of the 8am floor.
//
// No single UTC hour can serve both — Guam (UTC+10) and American Samoa
// (UTC-11) are 21 hours apart — so widening the fallback window cannot fix
// this. Mapping them can: a resolved zone never reaches the fallback at all
// and gets its own correct quiet hours. Codex caught the gap in review.
const PUERTO_RICO = "America/Puerto_Rico"; // AST, no DST
const VIRGIN_ISLANDS = "America/St_Thomas"; // AST, no DST
const GUAM = "Pacific/Guam"; // UTC+10
const SAIPAN = "Pacific/Saipan"; // UTC+10, CNMI
const SAMOA = "Pacific/Pago_Pago"; // UTC-11

const ZONE_AREA_CODES: Record<string, string[]> = {
  [EASTERN]: [
    "201", "202", "203", "207", "212", "215", "216", "217", "224", "234", "239",
    "267", "272", "302", "304", "305", "313", "315", "330", "336", "339", "351",
    "352", "386", "401", "404", "407", "410", "412", "413", "419", "434", "440",
    "443", "470", "475", "478", "484", "551", "561", "567", "570", "571", "585",
    "586", "603", "607", "609", "610", "614", "616", "617", "631", "646", "678",
    "703", "704", "706", "716", "717", "718", "724", "727", "732", "734", "740",
    "743", "754", "757", "770", "772", "774", "781", "786", "800", "813", "814",
    "828", "845", "848", "850", "856", "857", "860", "863", "864", "878", "904",
    "908", "912", "914", "917", "919", "929", "938", "941", "947", "954", "959",
    "973", "978", "980", "984",
  ],
  [CENTRAL]: [
    "205", "210", "214", "218", "225", "228", "251", "254", "256", "270", "281",
    "309", "312", "314", "316", "318", "319", "320", "331", "334", "337", "409",
    "414", "417", "430", "432", "469", "479", "501", "504", "507", "512", "515",
    "563", "573", "601", "608", "612", "615", "618", "620", "630", "636", "641",
    "651", "660", "662", "708", "712", "713", "715", "731", "751", "763", "769",
    "779", "815", "816", "817", "830", "832", "859", "870", "901", "903", "913",
    "918", "920", "931", "936", "940", "952", "979", "985",
  ],
  [MOUNTAIN]: [
    "208", "303", "307", "385", "406", "435", "505", "575", "719", "720", "801",
    "970",
  ],
  [ARIZONA]: ["480", "520", "602", "623", "928"],
  [PACIFIC]: [
    "206", "209", "213", "253", "279", "310", "323", "341", "360", "408", "415",
    "424", "425", "442", "458", "503", "509", "510", "530", "541", "559", "562",
    "564", "619", "626", "628", "650", "657", "661", "669", "702", "707", "725",
    "747", "760", "775", "805", "818", "831", "858", "909", "916", "925", "949",
    "951", "971",
  ],
  [ALASKA]: ["907"],
  [HAWAII]: ["808"],
  [ATLANTIC]: ["902", "782"],
  [NEWFOUNDLAND]: ["709"],
  // Canada, spread across Eastern/Central/Mountain/Pacific like the US.
  // Kept as separate entries appended into the maps below rather than a
  // second table, so lookup stays a single object.
};

// Canadian area codes, folded into the same zone buckets above.
ZONE_AREA_CODES[EASTERN].push(
  "226", "249", "289", "343", "365", "416", "437", "438", "450", "506", "514",
  "519", "579", "581", "613", "647", "705", "819", "873", "902",
);
ZONE_AREA_CODES[CENTRAL].push("204", "431", "807");
ZONE_AREA_CODES[MOUNTAIN].push("403", "587", "780", "825");
ZONE_AREA_CODES[PACIFIC].push("236", "250", "604", "672", "778");

// US territories — see the zone constants above for why these are load-bearing
// rather than cosmetic.
ZONE_AREA_CODES[PUERTO_RICO] = ["787", "939"];
ZONE_AREA_CODES[VIRGIN_ISLANDS] = ["340"];
ZONE_AREA_CODES[GUAM] = ["671"];
ZONE_AREA_CODES[SAIPAN] = ["670"];
ZONE_AREA_CODES[SAMOA] = ["684"];

const AREA_CODE_TO_ZONE: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [zone, codes] of Object.entries(ZONE_AREA_CODES)) {
    for (const code of codes) out[code] = zone;
  }
  return out;
})();

/** Extract the NANP area code (first 3 digits after the country code) from
 *  an E.164-ish string. Returns null if the number doesn't look like NANP. */
function areaCodeFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  // E.164 NANP: +1AAANNNNNNN (11 digits with leading 1) or bare 10-digit.
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (!ten) return null;
  return ten.slice(0, 3);
}

/** Best-effort viewer timezone (browser Intl, or the given fallback). */
function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Toronto";
  } catch {
    return "America/Toronto";
  }
}

export type TcpaCheck = {
  timeZone: string;
  /** True when the phone's area code wasn't in the table and we fell back
   *  to the viewer's own timezone — the caller MUST show this caveat. */
  usedFallback: boolean;
  /** 0-23, local hour at `at` in `timeZone`. */
  hour: number;
  /** TCPA window is [8am, 9pm) local. */
  withinWindow: boolean;
  /** Human label, e.g. "9:14 PM". */
  timeLabel: string;
};

export type TcpaDispatchSkipReason = "sms_timezone_unresolved" | "outside_sms_hours";

/**
 * Route an SMS delivery through the recipient-local window verdict. Keeping
 * the effect callbacks here makes the fail-closed branch executable in tests:
 * an unresolved timezone can never fall through to the send callback.
 */
export async function dispatchByTcpaWindow<TSkip, TSend>(
  check: Pick<TcpaCheck, "usedFallback" | "withinWindow">,
  effects: {
    skip: (reason: TcpaDispatchSkipReason) => TSkip | Promise<TSkip>;
    send: () => TSend | Promise<TSend>;
  },
): Promise<TSkip | TSend> {
  if (check.usedFallback) return effects.skip("sms_timezone_unresolved");
  if (!check.withinWindow) return effects.skip("outside_sms_hours");
  return effects.send();
}

/**
 * Resolve the TCPA calling-hours check for a recipient phone at a given
 * instant (default now). Falls back to the viewer's timezone (with
 * `usedFallback: true`) when the area code isn't recognized.
 */
export function checkTcpaWindow(recipientPhone: string | null | undefined, at: Date = new Date()): TcpaCheck {
  const areaCode = areaCodeFromPhone(recipientPhone);
  const zone = (areaCode && AREA_CODE_TO_ZONE[areaCode]) || null;
  const timeZone = zone || viewerTimeZone();
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(at),
    10,
  );
  const normalizedHour = hour === 24 ? 0 : hour;
  const timeLabel = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  return {
    timeZone,
    usedFallback: !zone,
    hour: normalizedHour,
    withinWindow: normalizedHour >= 8 && normalizedHour < 21,
    timeLabel,
  };
}

/**
 * The next instant (>= `from`) that falls inside the recipient-local TCPA
 * window — used to compute "Tomorrow 9am (their time)" schedule presets.
 * Walks forward hour-by-hour (cheap; window is at most 24h out) rather than
 * doing timezone-offset arithmetic by hand.
 */
export function nextTcpaWindowStart(recipientPhone: string | null | undefined, from: Date = new Date()): Date {
  let candidate = new Date(from);
  for (let i = 0; i < 48; i++) {
    if (checkTcpaWindow(recipientPhone, candidate).withinWindow) return candidate;
    candidate = new Date(candidate.getTime() + 30 * 60_000);
  }
  return from; // should never hit — defensive fallback
}

/**
 * Construct the UTC Date for `hour:minute` local wall-clock in `timeZone`,
 * on `from`'s local calendar day (in that same zone) + `dayOffset` days.
 * Used for schedule-send presets like "6pm their time" / "tomorrow 9am
 * their time". Mirrors the search technique in lib/dates.ts
 * operatorDayStartIso — walk a UTC seed ±15h in 15-min steps and match wall-
 * clock parts — which is robust across DST without hand-rolled offset math.
 */
export function zonedWallClockTime(
  timeZone: string,
  hour: number,
  minute: number,
  from: Date = new Date(),
  dayOffset: number = 0,
): Date {
  const dayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(from);
  const get = (type: string) => dayParts.find((p) => p.type === type)?.value || "1970";
  const targetY = parseInt(get("year"), 10);
  const targetM = parseInt(get("month"), 10);
  const targetD = parseInt(get("day"), 10) + dayOffset;
  const seedUtcMs = Date.UTC(targetY, targetM - 1, targetD, 12, 0, 0);
  for (let offsetMin = -15 * 60; offsetMin <= 15 * 60; offsetMin += 15) {
    const candidate = new Date(seedUtcMs + offsetMin * 60_000);
    const hh =
      parseInt(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(candidate), 10) % 24;
    const mm = parseInt(new Intl.DateTimeFormat("en-US", { timeZone, minute: "2-digit" }).format(candidate), 10);
    if (hh === hour && mm === minute) return candidate;
  }
  return from; // should never hit — defensive fallback
}
