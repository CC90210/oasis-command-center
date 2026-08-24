import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  PROVINCE_ZONES, DAY_CODES, CALL_WINDOW,
  zoneForProvince, localClock, readStoredHours, intervalsFor,
  openState, nextTransition, formatMinutes, formatDay, weekRows,
  callWindowState, leadHours,
} from "../lib/web-leads/hours";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// A stored blob exactly as JARVIS's services/leadgen/lib/opening-hours.js
// toStored() writes it. Written as a LITERAL rather than generated, because
// this is a cross-repo contract: if the writing side changes shape and this
// stays green, the whole corpus silently renders "Hours unknown".
const NINE_TO_FIVE = {
  v: 1,
  status: "parsed" as const,
  week: {
    mo: [[540, 1020]], tu: [[540, 1020]], we: [[540, 1020]],
    th: [[540, 1020]], fr: [[540, 1020]], sa: [], su: [],
  },
  always_open: false,
  public_holidays: "closed" as const,
  caveats: ["Closed on public holidays.", "The open or closed state below does not account for public holidays."],
};

// ═══════════════════════════════════════════════════════════════════════════
// TIME ZONES. Canada has six, one province refuses daylight saving, one is
// offset by half an hour, and one territory stopped changing its clocks in
// 2020. Every one of those is a real hour of legal exposure under CRTC Rule 23,
// which measures the calling window in the RECIPIENT'S local time.
// ═══════════════════════════════════════════════════════════════════════════

// Instants chosen on purpose: 2026-01-15 is deep in standard time, 2026-07-15
// is deep in daylight time, and both are far from a transition so a one-day
// error in the DST rules cannot pass by luck.
const WINTER = new Date("2026-01-15T17:00:00Z"); // 12:00 EST
const SUMMER = new Date("2026-07-15T16:00:00Z"); // 12:00 EDT

assert.equal(localClock("America/Toronto", WINTER)!.label, "12:00 pm", "Toronto in January");
assert.equal(localClock("America/Toronto", SUMMER)!.label, "12:00 pm", "Toronto in July");

// SASKATCHEWAN. The whole reason the province gets its own zone entry: it does
// not change its clocks, so it agrees with Winnipeg in winter and with Edmonton
// in summer. A single hardcoded UTC-6 would be right in January and an hour
// wrong every day from March to November -- and "an hour wrong" at 9am means a
// rep dialling at 8am local, before the legal window opens.
{
  const skWinter = localClock(zoneForProvince("SK")!.tz, WINTER)!;
  const skSummer = localClock(zoneForProvince("SK")!.tz, SUMMER)!;
  const mbWinter = localClock(zoneForProvince("MB")!.tz, WINTER)!;
  const mbSummer = localClock(zoneForProvince("MB")!.tz, SUMMER)!;
  const abSummer = localClock(zoneForProvince("AB")!.tz, SUMMER)!;

  assert.equal(skWinter.label, "11:00 am", "Saskatchewan in January is UTC-6");
  assert.equal(skSummer.label, "10:00 am", "Saskatchewan in July is STILL UTC-6");
  assert.equal(mbWinter.label, "11:00 am", "Manitoba matches Saskatchewan in winter");
  assert.equal(mbSummer.label, "11:00 am", "Manitoba springs forward and Saskatchewan does not");
  assert.notEqual(skSummer.label, mbSummer.label, "the whole point of the Regina zone");
  assert.equal(skSummer.label, abSummer.label, "in summer Saskatchewan reads as Mountain");
}

// NEWFOUNDLAND. Half an hour, which integer-hour offset maths cannot express.
{
  const nl = localClock(zoneForProvince("NL")!.tz, WINTER)!;
  assert.equal(nl.label, "1:30 pm", "Newfoundland is UTC-3:30 in January");
  assert.equal(nl.minutes % 60, 30, "a half-hour offset must survive into the minute count");
}

// YUKON stopped observing daylight saving in 2020 and sits on UTC-7 year-round.
{
  assert.equal(localClock(zoneForProvince("YT")!.tz, WINTER)!.label, "10:00 am");
  assert.equal(localClock(zoneForProvince("YT")!.tz, SUMMER)!.label, "9:00 am");
}

// The spread that makes this feature necessary at all: one instant, six clocks.
{
  const at = (p: string) => localClock(zoneForProvince(p)!.tz, SUMMER)!.label;
  assert.equal(at("BC"), "9:00 am");
  assert.equal(at("AB"), "10:00 am");
  assert.equal(at("SK"), "10:00 am");
  assert.equal(at("MB"), "11:00 am");
  assert.equal(at("ON"), "12:00 pm");
  assert.equal(at("NS"), "1:00 pm");
  assert.equal(at("NL"), "1:30 pm");
}

// DST TRANSITION. 2026-03-08 07:00Z is 2:00am EST, the instant the clock jumps
// to 3:00am. A rep looking at a Toronto lead at that moment must not be told it
// is 2:00am.
{
  const jump = localClock("America/Toronto", new Date("2026-03-08T07:00:00Z"))!;
  assert.equal(jump.label, "3:00 am", "the spring-forward hour does not exist");
  // Regina sails through it untouched.
  assert.equal(localClock("America/Regina", new Date("2026-03-08T07:00:00Z"))!.label, "1:00 am");
}

// The day of the week is the BUSINESS's, not the viewer's. 2026-01-15 17:00Z is
// Thursday everywhere in Canada, but at 2026-01-16 04:00Z it is already Friday
// in Halifax and still Thursday in Vancouver -- and Rule 23's weekend window is
// two and a half hours narrower than its weekday one.
{
  const t = new Date("2026-01-16T04:00:00Z");
  assert.equal(localClock("America/Halifax", t)!.dayCode, "fr");
  assert.equal(localClock("America/Vancouver", t)!.dayCode, "th");
}

// Every province and territory maps to a zone the platform actually knows.
for (const [code, entry] of Object.entries(PROVINCE_ZONES)) {
  assert.ok(localClock(entry.tz, SUMMER), `${code} -> ${entry.tz} must be a zone Intl accepts`);
}

// The five regions that genuinely span zones SAY SO. An hour's error is an
// hour of legal exposure, so the assumption is surfaced rather than buried.
for (const code of ["ON", "BC", "QC", "NU", "SK"]) {
  assert.ok(zoneForProvince(code)!.assumption, `${code} spans zones and must declare the assumption made`);
}
assert.equal(zoneForProvince("NS")!.assumption, null, "a single-zone province must not nag");

// An unknown or missing province returns null rather than guessing. A wrong
// zone is worse than no zone: it produces a confident local time that is wrong.
for (const bad of [null, undefined, "", "  ", "XX", "California", "42"]) {
  assert.equal(zoneForProvince(bad as string | null), null, String(bad));
}
assert.equal(zoneForProvince("ontario")!.tz, "America/Toronto", "long names and case still resolve");
assert.equal(zoneForProvince(" qc ")!.tz, "America/Toronto", "whitespace is tolerated");
assert.equal(localClock(null, SUMMER), null, "no zone means no clock, never the viewer's own");
assert.equal(localClock("Not/AZone", SUMMER), null, "a zone Intl rejects returns null, never throws");

// ═══════════════════════════════════════════════════════════════════════════
// DECODING THE STORED BLOB.
// ═══════════════════════════════════════════════════════════════════════════

assert.ok(readStoredHours(NINE_TO_FIVE), "the literal contract blob must decode");
assert.ok(readStoredHours(JSON.stringify(NINE_TO_FIVE)), "a JSON string decodes too -- libSQL hands JSON back as TEXT");

for (const bad of [
  null, undefined, "", "   ", "not json", 42, [], [1, 2],
  { status: "parsed" },                       // no version
  { v: 1 },                                   // no status
  { v: 2, status: "parsed", week: {} },       // a future schema means anything
  { v: 1, status: "something_else" },
]) {
  assert.equal(readStoredHours(bad), null, JSON.stringify(bad));
}

// A malformed interval inside an otherwise valid blob is DROPPED, not rendered.
{
  const dodgy = readStoredHours({
    v: 1,
    status: "parsed",
    week: { mo: [[540, 1020], [1020, 540], ["9", "17"], [600], null, [700, 800]] },
  })!;
  assert.deepEqual(intervalsFor(dodgy, "mo"), [{ start: 540, end: 1020 }, { start: 700, end: 800 }]);
}
assert.deepEqual(intervalsFor(null, "mo"), []);
assert.deepEqual(intervalsFor(readStoredHours({ v: 1, status: "absent" }), "mo"), []);

// ═══════════════════════════════════════════════════════════════════════════
// OPEN, CLOSED, UNKNOWN. Never a fourth state and never a default.
// ═══════════════════════════════════════════════════════════════════════════

const stored = readStoredHours(NINE_TO_FIVE)!;
const clockAt = (day: typeof DAY_CODES[number], minutes: number) =>
  ({ dayCode: day, minutes, label: formatMinutes(minutes), tz: "America/Toronto" });

assert.equal(openState(stored, clockAt("mo", 600)), "open", "10:00 on a Monday");
assert.equal(openState(stored, clockAt("mo", 539)), "closed", "one minute before opening");
assert.equal(openState(stored, clockAt("mo", 540)), "open", "the opening minute itself is open");
assert.equal(openState(stored, clockAt("mo", 1020)), "closed", "the closing minute itself is shut");
assert.equal(openState(stored, clockAt("sa", 600)), "closed", "a day with no hours is closed");
assert.equal(openState(stored, null), "unknown", "no clock is never a state");
assert.equal(openState(null, clockAt("mo", 600)), "unknown", "no hours is never a state");
assert.equal(
  openState(readStoredHours({ v: 1, status: "unparsed", reason: "x" }), clockAt("mo", 600)),
  "unknown",
  "a string we could not read is never resolved into open or closed",
);

// An overnight span. Without the previous-day check every late-night business
// reads as shut at exactly the hour it is open.
{
  const bar = readStoredHours({ v: 1, status: "parsed", week: { fr: [[1200, 1560]] } })!; // Fri 20:00-02:00
  assert.equal(openState(bar, clockAt("fr", 1300)), "open", "Friday 21:40");
  assert.equal(openState(bar, clockAt("sa", 60)), "open", "Saturday 1:00am, still Friday night");
  assert.equal(openState(bar, clockAt("sa", 180)), "closed", "Saturday 3:00am");
}
// And one that wraps the week boundary: Sunday night into Monday morning.
{
  const late = readStoredHours({ v: 1, status: "parsed", week: { su: [[1320, 1620]] } })!;
  assert.equal(openState(late, clockAt("mo", 60)), "open", "Monday 1:00am belongs to Sunday's span");
}

// ═══════════════════════════════════════════════════════════════════════════
// THE NEXT CHANGE. "Opens at 9:00 am" is the difference between a rep skipping
// a lead and scheduling it.
// ═══════════════════════════════════════════════════════════════════════════

assert.deepEqual(
  nextTransition(stored, clockAt("mo", 600)),
  { kind: "closes", label: "5:00 pm", day: "mo", daysAhead: 0 },
);
assert.deepEqual(
  nextTransition(stored, clockAt("mo", 400)),
  { kind: "opens", label: "9:00 am", day: "mo", daysAhead: 0 },
  "before opening, the next change is today",
);
{
  // Friday evening: the next opening is Monday, three days out, because the
  // weekend is closed.
  const t = nextTransition(stored, clockAt("fr", 1200))!;
  assert.equal(t.kind, "opens");
  assert.equal(t.day, "mo");
  assert.equal(t.daysAhead, 3);
}
assert.equal(
  nextTransition(readStoredHours({ v: 1, status: "parsed", always_open: true, week: {} }), clockAt("mo", 600)),
  null,
  "a business that never closes has no next change",
);
assert.equal(
  nextTransition(readStoredHours({ v: 1, status: "parsed", week: {} }), clockAt("mo", 600)),
  null,
  "a week with no hours at all has no next opening to promise",
);

// ═══════════════════════════════════════════════════════════════════════════
// FORMATTING.
// ═══════════════════════════════════════════════════════════════════════════

assert.equal(formatMinutes(0), "12:00 am", "midnight is 12, never 0 and never 24");
assert.equal(formatMinutes(720), "12:00 pm", "noon is 12 pm");
assert.equal(formatMinutes(1439), "11:59 pm");
assert.equal(formatMinutes(1440), "12:00 am", "an overnight end wraps into the next morning");
assert.equal(formatMinutes(1560), "2:00 am", "26:00 reads as 2:00 am");
assert.equal(formatMinutes(545), "9:05 am", "minutes are zero-padded");
assert.equal(formatDay([]), "Closed", "an empty day says the word, never a dash");
assert.equal(formatDay([{ start: 540, end: 1020 }]), "9:00 am to 5:00 pm");
assert.equal(
  formatDay([{ start: 480, end: 720 }, { start: 780, end: 1020 }]),
  "8:00 am to 12:00 pm, 1:00 pm to 5:00 pm",
  "a split day shows both windows",
);
assert.equal(formatDay([{ start: 0, end: 1440 }]), "Open 24 hours");

// Seven rows, always. A MISSING Saturday row and a Saturday row saying "Closed"
// look the same to a glancing eye and mean opposite things.
{
  const rows = weekRows(stored, clockAt("we", 600));
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((r) => r.day), [...DAY_CODES]);
  assert.equal(rows.find((r) => r.day === "sa")!.hours, "Closed");
  assert.equal(rows.filter((r) => r.isToday).length, 1);
  assert.equal(rows.find((r) => r.isToday)!.day, "we");
}
assert.deepEqual(weekRows(null, clockAt("mo", 600)), [], "no grid means no rows to render");

// ═══════════════════════════════════════════════════════════════════════════
// CRTC RULE 23. 9:00am-9:30pm weekdays, 10:00am-6:00pm weekends, in the
// RECIPIENT'S time zone. Up to $15,000 per call, and enforcement has landed at
// about $1,000 per call in practice (CRTC 2024-176).
// ═══════════════════════════════════════════════════════════════════════════

for (const d of ["mo", "tu", "we", "th", "fr"] as const) {
  assert.equal(CALL_WINDOW[d].start, 9 * 60, `${d} opens at 9:00am`);
  assert.equal(CALL_WINDOW[d].end, 21 * 60 + 30, `${d} closes at 9:30pm`);
}
for (const d of ["sa", "su"] as const) {
  assert.equal(CALL_WINDOW[d].start, 10 * 60, `${d} opens at 10:00am`);
  assert.equal(CALL_WINDOW[d].end, 18 * 60, `${d} closes at 6:00pm`);
}

assert.equal(callWindowState(clockAt("mo", 9 * 60)).allowed, true, "9:00am exactly is permitted");
assert.equal(callWindowState(clockAt("mo", 9 * 60 - 1)).allowed, false, "8:59am is not");
assert.equal(callWindowState(clockAt("mo", 21 * 60 + 29)).allowed, true, "9:29pm is permitted");
assert.equal(callWindowState(clockAt("mo", 21 * 60 + 30)).allowed, false, "9:30pm is the boundary");
assert.equal(callWindowState(clockAt("sa", 9 * 60 + 59)).allowed, false, "Saturday opens an hour later");
assert.equal(callWindowState(clockAt("sa", 10 * 60)).allowed, true);
assert.equal(callWindowState(clockAt("su", 18 * 60)).allowed, false, "Sunday shuts at 6:00pm, not 9:30pm");
assert.equal(callWindowState(clockAt("fr", 20 * 60)).allowed, true, "Friday 8pm is fine");
assert.equal(callWindowState(clockAt("sa", 20 * 60)).allowed, false, "Saturday 8pm is not");

// THE HEADLINE FAILURE THE RULE EXISTS FOR: a Toronto rep at 9:00am dialling
// Vancouver. It is 6:00am there, and that is a violation.
{
  const nineAmEastern = new Date("2026-07-15T13:00:00Z");
  const van = localClock(zoneForProvince("BC")!.tz, nineAmEastern)!;
  const tor = localClock(zoneForProvince("ON")!.tz, nineAmEastern)!;
  assert.equal(tor.label, "9:00 am");
  assert.equal(van.label, "6:00 am");
  assert.equal(callWindowState(tor).allowed, true, "legal for the rep's own city");
  assert.equal(callWindowState(van).allowed, false, "and illegal for the business they are dialling");
  const w = callWindowState(van) as { allowed: false; reason: string };
  assert.match(w.reason, /6:00 am/, "the caution must name the business's local time, not a rule number");
}

// No province means no clock, and that is NOT permission. A caution that
// appears only when we happen to know the province would train reps to read its
// absence as an all-clear.
{
  const unknown = callWindowState(null);
  assert.equal(unknown.allowed, null, "unknown is its own answer, never true and never false");
  assert.ok(/\w+\s\w+/.test(unknown.reason), "and it is a sentence");
}

// ═══════════════════════════════════════════════════════════════════════════
// leadHours: the one resolution point every surface renders from.
// ═══════════════════════════════════════════════════════════════════════════

const NOON_ET = new Date("2026-07-15T16:00:00Z");

{
  const h = leadHours({ province: "ON", openingHours: NINE_TO_FIVE, openingHoursRaw: "Mo-Fr 09:00-17:00; PH off" }, NOON_ET);
  assert.equal(h.state, "open");
  assert.equal(h.headline, "Open now");
  assert.match(h.detail, /closes at 5:00 pm/);
  assert.equal(h.week.length, 7);
  assert.equal(h.raw, "Mo-Fr 09:00-17:00; PH off", "the recorded string is carried verbatim");
  assert.ok(h.caveats.includes("Closed on public holidays."));
  assert.equal(h.call.allowed, true);
}

{
  // Same business, same instant, but in British Columbia: 9:00am there, and the
  // shop does not open until nine, so it is open -- while a Vancouver lead an
  // hour earlier would not be.
  const h = leadHours({ province: "BC", openingHours: NINE_TO_FIVE, openingHoursRaw: null }, NOON_ET);
  assert.equal(h.clock!.label, "9:00 am");
  assert.equal(h.state, "open");
  assert.ok(h.zoneAssumption, "BC spans zones, so the card must say what was assumed");
}

// EVERY unknown path produces a SENTENCE, never a blank and never "open".
{
  // NO GRID AT ALL. Nothing readable was stored, so there is nothing to show
  // and nothing to infer.
  const noGrid = [
    { label: "no hours at all", input: { province: "ON", openingHours: null, openingHoursRaw: null } },
    { label: "an absent marker", input: { province: "ON", openingHours: { v: 1, status: "absent" }, openingHoursRaw: null } },
    { label: "a string we could not read", input: { province: "ON", openingHours: { v: 1, status: "unparsed", reason: "seasonal" }, openingHoursRaw: "Apr-Oct Mo-Su 11:00-23:00" } },
    { label: "a future schema version", input: { province: "ON", openingHours: { v: 9, status: "parsed", week: { mo: [[0, 1440]] } }, openingHoursRaw: null } },
  ];
  for (const c of noGrid) {
    const h = leadHours(c.input as Parameters<typeof leadHours>[0], NOON_ET);
    assert.equal(h.state, "unknown", c.label);
    assert.equal(h.headline, "Hours unknown", c.label);
    assert.ok(h.detail.length > 20 && h.detail.trim().endsWith("."), `${c.label}: detail must be a sentence`);
    assert.deepEqual(h.week, [], `${c.label}: nothing readable means no week grid to render`);
  }
  // And the unparsed case keeps the raw string available to show instead.
  const unparsed = leadHours(noGrid[2].input as Parameters<typeof leadHours>[0], NOON_ET);
  assert.equal(unparsed.raw, "Apr-Oct Mo-Su 11:00-23:00");
  assert.match(unparsed.detail, /could not read them reliably/);

  // A GRID BUT NO CLOCK. Two separate facts, and only one of them is missing:
  // "Monday 9 to 5" is true whatever zone the business sits in, so the week is
  // still shown. What cannot be stated is whether they are open AT THIS MOMENT,
  // and that is exactly what the headline withholds. Rendering a week here is
  // not a hedge, it is the useful half of what we hold.
  {
    const h = leadHours({ province: null, openingHours: NINE_TO_FIVE, openingHoursRaw: "Mo-Fr 09:00-17:00" }, NOON_ET);
    assert.equal(h.state, "unknown", "no zone means no now-state");
    assert.equal(h.headline, "Hours unknown");
    assert.equal(h.week.length, 7, "the week is known even when the time zone is not");
    assert.match(h.detail, /No province on file/, "and the detail says which half is missing");
    assert.equal(h.call.allowed, null, "an unknown zone is not permission to dial");
  }
}

// Closed, with a next opening a rep can act on.
{
  const sundayNoon = new Date("2026-07-19T16:00:00Z");
  const h = leadHours({ province: "ON", openingHours: NINE_TO_FIVE, openingHoursRaw: null }, sundayNoon);
  assert.equal(h.state, "closed");
  assert.equal(h.headline, "Closed now");
  assert.match(h.detail, /Opens tomorrow at 9:00 am their time\./);
}

// Every headline is one of exactly three, in every configuration.
{
  const seen = new Set<string>();
  for (const prov of [null, "ON", "BC", "SK", "NL", "XX"]) {
    for (const hours of [null, NINE_TO_FIVE, { v: 1, status: "absent" }, { v: 1, status: "unparsed" }]) {
      for (const t of [new Date("2026-01-15T17:00:00Z"), new Date("2026-07-19T16:00:00Z"), new Date("2026-07-15T02:00:00Z")]) {
        const h = leadHours({ province: prov, openingHours: hours, openingHoursRaw: "x" }, t);
        seen.add(h.headline);
        assert.ok(h.detail.trim().length > 0, "detail is never empty");
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["Closed now", "Hours unknown", "Open now"]);
}

// ═══════════════════════════════════════════════════════════════════════════
// The wiring, pinned. These are the joins that break silently.
// ═══════════════════════════════════════════════════════════════════════════

{
  const data = read("lib/web-leads/data.ts");
  // The three keys JARVIS's crm-sink.js writes. If either side renames one, the
  // whole corpus quietly renders "Hours unknown" and nothing throws.
  for (const key of ["webdev_opening_hours_raw", "webdev_opening_hours", "webdev_opening_hours_checked_at"]) {
    assert.match(data, new RegExp(key), `toWebLead must read ${key} -- this is a cross-repo contract`);
  }
  // The raw string must not be normalised on the way in, the same rule
  // websiteCondition already lives under.
  assert.match(data, /openingHoursRaw: str\(d\.webdev_opening_hours_raw\)/);

  const hours = read("lib/web-leads/hours.ts");
  // Zones come from Intl, never from arithmetic. A hardcoded offset gets
  // Saskatchewan, Newfoundland and every DST transition wrong.
  assert.match(hours, /Intl\.DateTimeFormat/);
  assert.doesNotMatch(hours, /getTimezoneOffset/, "the viewer's own offset is never the business's");
  assert.match(hours, /hourCycle: "h23"/, "hour12:false renders midnight as 24 on some ICU builds");
  // Rule 23's numbers, present as numbers rather than as prose.
  assert.match(hours, /21 \* 60 \+ 30/, "the weekday window ends at 9:30pm");

  const ui = read("components/web-leads/OpeningHours.tsx");
  // The caution WARNS. A disabled dial button built on a derived time zone would
  // refuse legitimate calls in the regions whose zone we had to assume.
  assert.doesNotMatch(ui, /disabled=/, "the calling-hours caution must never gate a control");
  assert.match(ui, /Hours unknown|h\.headline/, "the unknown state reaches the screen");
}

console.log("web-leads-hours ok");
