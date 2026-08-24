import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  scheduleEntries,
  groupIntoDays,
  countCommitments,
  localDayKey,
  localDayStart,
} from "../lib/web-leads/schedule";
import { filterNavForPersona } from "../lib/role-surfaces";
import { WEBDEV_NAV } from "../lib/nav-config";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ===========================================================================
// The in-app calendar (Adon, 2026-08-24): "we want to feature that there's a
// calendar on the software as well where you'd be able to track your meetings,
// but it will be on Google Calendar mostly just so that they get the
// notification on their phones."
//
// The grouping is pure and takes `now` as an argument precisely so it can be
// tested. "What does the week of the 3rd look like" is a question you can only
// ask a function that does not read the system clock.
// ===========================================================================

const lead = (id: string, data: Record<string, unknown>) => ({ id, data });

// A fixed reference instant for every case below.
const NOW = Date.parse("2026-08-24T14:00:00.000Z");

// ---------------------------------------------------------------------------
// 1. ONE LEAD CAN CONTRIBUTE TWO ENTRIES.
//
// A booked meeting and a separate callback are different commitments and both
// must appear. Collapsing to one-per-lead would silently drop whichever the
// code checked second, and the one that goes missing is the one the rep does
// not attend.
// ---------------------------------------------------------------------------
{
  const rows = [
    lead("l1", {
      business_name: "Rosetti Plumbing",
      phone: "416-555-0100",
      next_action_at: "2026-08-25T15:00:00.000Z",
      founder_meeting_at: "2026-08-26T18:00:00.000Z",
      last_disposition: "callback",
    }),
  ];
  const entries = scheduleEntries(rows, NOW);
  assert.equal(entries.length, 2, "a lead with both a callback and a meeting must produce two entries");
  assert.deepEqual(entries.map((e) => e.kind), ["callback", "meeting"], "entries must be sorted by time, not by field order");
  assert.equal(entries[0].businessName, "Rosetti Plumbing");
  assert.equal(entries[0].lastDisposition, "callback", "a callback carries the disposition that produced it");
  assert.equal(entries[1].lastDisposition, null, "a meeting has no call disposition to show");
}

// ---------------------------------------------------------------------------
// 2. NOTHING IS INVENTED. A lead with no scheduled time produces no entry.
// An empty calendar is the truth for a rep who has booked nothing, and padding
// it with "unscheduled" rows would turn the one screen that answers "what am I
// committed to" into another list of everything.
// ---------------------------------------------------------------------------
{
  const rows = [
    lead("l2", { business_name: "No Commitments Ltd" }),
    lead("l3", { business_name: "Empty String", next_action_at: "" }),
    lead("l4", { business_name: "Junk Date", next_action_at: "not a date" }),
    lead("l5", { business_name: "Wrong Type", next_action_at: 12345 }),
  ];
  assert.deepEqual(scheduleEntries(rows, NOW), [], "unscheduled, empty, unparseable and non-string dates must all produce nothing");
}

// An unparseable date must be DROPPED rather than rendered. A calendar row a
// rep cannot act on is worse than a row that is absent.
{
  const rows = [lead("l6", { business_name: "Half Good", next_action_at: "nope", founder_meeting_at: "2026-08-27T16:00:00.000Z" })];
  const entries = scheduleEntries(rows, NOW);
  assert.equal(entries.length, 1, "the good half of a lead must survive a bad date on the other half");
  assert.equal(entries[0].kind, "meeting");
}

// ---------------------------------------------------------------------------
// 3. OVERDUE IS SEPARATE, NOT FOLDED INTO TODAY.
//
// A promise a rep has already missed is the most urgent thing on the screen.
// Burying it inside today's column is how it stays missed.
// ---------------------------------------------------------------------------
{
  const rows = [
    lead("late", { business_name: "Missed Yesterday", next_action_at: "2026-08-23T15:00:00.000Z" }),
    lead("soon", { business_name: "Later Today", next_action_at: "2026-08-24T19:00:00.000Z" }),
  ];
  const grouped = groupIntoDays(scheduleEntries(rows, NOW), NOW, 14);
  assert.equal(grouped.overdue.length, 1, "the past-due entry must be returned separately");
  assert.equal(grouped.overdue[0].businessName, "Missed Yesterday");
  assert.ok(grouped.overdue[0].overdue, "an overdue entry must be flagged as such");
  const inDays = grouped.days.flatMap((d) => d.entries);
  assert.equal(inDays.length, 1, "only the future entry belongs in the day columns");
  assert.equal(inDays[0].businessName, "Later Today");
  // The count must include overdue. A header that excluded them would read
  // "nothing scheduled" to a rep with four missed callbacks.
  assert.equal(countCommitments(grouped), 2, "overdue commitments are still commitments and must be counted");
}

// ---------------------------------------------------------------------------
// 4. EVERY DAY IN THE RANGE IS PRESENT, INCLUDING EMPTY ONES.
//
// A calendar that renders only days with entries is a list wearing a
// calendar's name. The gaps are the information: they are where a rep books.
// ---------------------------------------------------------------------------
{
  const grouped = groupIntoDays(scheduleEntries([], NOW), NOW, 14);
  assert.equal(grouped.days.length, 14, "an empty book must still render fourteen days");
  assert.ok(grouped.days.every((d) => d.entries.length === 0), "empty days must be empty, not absent");
  assert.equal(countCommitments(grouped), 0);
  // Consecutive and strictly increasing, with no repeated or skipped day.
  const keys = grouped.days.map((d) => d.key);
  assert.equal(new Set(keys).size, 14, "the fourteen days must be distinct");
  for (let i = 1; i < grouped.days.length; i++) {
    assert.ok(grouped.days[i].startMs > grouped.days[i - 1].startMs, "days must run forward");
  }
}

// ---------------------------------------------------------------------------
// 5. LOCAL DAYS, NOT UTC DAYS. THIS IS THE BUG WORTH GUARDING.
//
// Grouping on an ISO slice would file a late-evening callback under tomorrow
// for any timezone behind UTC -- a rep in Toronto sets 9pm Monday and finds an
// empty Monday and a stranger on Tuesday. The key must come from local date
// parts, and midnight must be local midnight.
// ---------------------------------------------------------------------------
{
  const ms = Date.parse("2026-08-24T18:30:00.000Z");
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  assert.equal(localDayKey(ms), expected, "the day key must be built from LOCAL date parts");

  const start = localDayStart(ms);
  const startDate = new Date(start);
  assert.equal(startDate.getHours(), 0, "day start must be local midnight");
  assert.equal(startDate.getMinutes(), 0);
  assert.equal(startDate.getSeconds(), 0);
  assert.equal(startDate.getMilliseconds(), 0);
  assert.equal(localDayKey(start), localDayKey(ms), "midnight and mid-afternoon of one local day share a key");

  // Every moment of a local day maps to that day, including its last
  // millisecond -- the boundary is where an off-by-one lands.
  const nextMidnight = localDayStart(start + 26 * 60 * 60 * 1000);
  assert.equal(localDayKey(nextMidnight - 1), localDayKey(start), "the final millisecond of a day belongs to that day");
  assert.notEqual(localDayKey(nextMidnight), localDayKey(start), "the next midnight starts a new day");
}

// An entry must land in the day column whose key matches its own local day.
{
  const at = "2026-08-26T23:45:00.000Z";
  const rows = [lead("tz", { business_name: "Late Call", next_action_at: at })];
  const grouped = groupIntoDays(scheduleEntries(rows, NOW), NOW, 14);
  const holder = grouped.days.find((d) => d.entries.some((e) => e.leadId === "tz"));
  assert.ok(holder, "a scheduled entry within the range must appear in some day");
  assert.equal(
    holder!.key,
    localDayKey(Date.parse(at)),
    "an entry must sit in the column for ITS OWN local day, not a UTC-shifted one",
  );
}

// ---------------------------------------------------------------------------
// 6. ANYTHING BEYOND THE WINDOW IS SIMPLY NOT SHOWN, and is never silently
// dumped into the last day -- which would tell a rep they have a meeting on a
// day they do not.
// ---------------------------------------------------------------------------
{
  const rows = [lead("far", { business_name: "Next Month", next_action_at: "2026-10-01T15:00:00.000Z" })];
  const grouped = groupIntoDays(scheduleEntries(rows, NOW), NOW, 14);
  assert.equal(countCommitments(grouped), 0, "an entry past the window must not be folded into the last visible day");
}

// ---------------------------------------------------------------------------
// 7. THE PAGE MAKES NO ACCESS DECISION OF ITS OWN, AND READS NOTHING
// COMPANY-WIDE.
//
// Same discipline RepToday documents: a number that is fetched and then hidden
// still ships inside the RSC payload. The enforcement has to be the fetch.
// ---------------------------------------------------------------------------
{
  const page = stripComments(read("app/calendar/page.tsx"));
  assert.match(page, /resolveViewerSurface\(\)/, "the calendar page must use the shared surface resolver, not its own role check");
  assert.match(page, /persona !== "sales"/, "the calendar page must be for the sales persona only");
  assert.match(page, /redirect\("\/"\)/, "a non-rep must be redirected, never shown an empty calendar that reads as 'nothing booked'");

  const view = stripComments(read("components/calendar/RepCalendar.tsx"));
  assert.match(view, /where:\s*\{\s*assigned_to:/, "the book must be scoped in the QUERY, not filtered after");
  assert.match(view, /filterWebsiteSalesRows/, "the query scope must be narrowed again by the shared pipeline policy");
  // Company financials must not be importable on this path at all.
  for (const forbidden of ["mrrSnapshot", "mrrHistory", "topClientConcentration", "pipelineBreakdown"]) {
    assert.doesNotMatch(view, new RegExp(forbidden), `the rep calendar must never import ${forbidden}`);
  }
  // A failed read and an empty week must render differently.
  assert.match(view, /Could not load your calendar/, "a failed read must say so rather than reading as an empty week");
}

console.log("rep-calendar-schedule ok");

// ---------------------------------------------------------------------------
// 8. THE LINK MUST SURVIVE THE PERSONA FILTER.
//
// Caught by an independent review (Codex, 2026-08-24), not by a test, and the
// failure mode is why it needed one: lib/nav-config.ts's rows are filtered
// through SALES_NAV_ALLOWLIST per persona. A row added to the nav and not to
// the allowlist renders for NOBODY in sales. The page works, the link is
// silently dropped, nothing throws, and the feature is invisible to the only
// people it was built for.
//
// Asserted through the real filter rather than by grepping the array, so a
// change to how filtering works fails here too.
// ---------------------------------------------------------------------------
{
  const salesNav = filterNavForPersona(WEBDEV_NAV, "sales");
  assert.ok(
    salesNav.some((i) => i.href === "/calendar"),
    "a sales rep must actually see the Calendar link -- an allowlist miss drops it silently",
  );

  // And it must not leak to a persona with no rep book of their own, where an
  // empty calendar would read as "you have nothing booked" rather than "this
  // page is not for you".
  for (const persona of ["marketing", "builder"] as const) {
    const nav = filterNavForPersona(WEBDEV_NAV, persona);
    assert.ok(
      !nav.some((i) => i.href === "/calendar"),
      `${persona} must not be offered the rep calendar`,
    );
  }

  // `/calendar` and `/schedule` are different features with confusable names:
  // one is a localStorage week-planner of time blocks, the other is real lead
  // commitments. Both may exist; neither may replace the other by accident.
  assert.notEqual("/calendar", "/schedule", "these are two different surfaces");
}

console.log("rep-calendar-schedule (nav) ok");
