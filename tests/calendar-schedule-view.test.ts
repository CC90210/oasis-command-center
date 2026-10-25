/**
 * The phone agenda must leave room for the event name. At 390px the former
 * day/time columns left about 70px, cutting even short routine names off.
 * Render the real component and retain the responsive layout contract alongside
 * its native button actions, recurrence, colour, and multi-day labels.
 * Run: node --conditions=react-server --import tsx tests/calendar-schedule-view.test.ts
 */
import assert from "node:assert/strict";
import * as ReactNS from "react";
import { isValidElement } from "react";
import type { EventRecord, Occurrence } from "../lib/calendar/types";

process.env.TZ = "America/Toronto";
// Match the lightweight client-component renderer used by calendar-routine-card.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const R = require("react") as Record<string, unknown>;
R.useMemo = (fn: () => unknown) => fn();
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    const el = node as unknown as El;
    out.push(el);
    elements(el.props.children, out);
  }
  return out;
}
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement(node) ? text((node.props as Record<string, unknown>).children) : "";
}
const classes = (el: El) => String(el.props.className ?? "").split(/\s+/);
const event: EventRecord = {
  id: "fixture", calendarId: "personal", title: "Read and practise a difficult conversation with someone you trust",
  description: "", location: "Library", allDay: false,
  start: "2026-10-26T13:00:00Z", end: "2026-10-26T13:45:00Z", timeZone: "America/Toronto",
  recurrence: { freq: "WEEKLY", interval: 1, byWeekday: [1] }, exdates: [],
  recurringEventId: null, originalStart: null, color: "moss", reminders: [], guests: [], busy: true,
  createdAt: "", updatedAt: "",
};
const occurrence: Occurrence = {
  key: "fixture@2026-10-26", event, master: event, start: new Date(event.start), end: new Date(event.end),
  allDay: false, originalStart: event.start,
};

async function main() {
  const { ScheduleView } = await import("../components/calendar/ScheduleView");
  let opened: [Occurrence, HTMLElement] | undefined;
  let picked: Date | undefined;
  const props = {
    occurrences: [occurrence], calendars: new Map(), now: new Date("2026-10-26T12:00:00Z"),
    selectedKey: occurrence.key, onOpen: (o: Occurrence, el: HTMLElement) => { opened = [o, el]; },
    onPickDay: (day: Date) => { picked = day; }, emptyText: "Nothing planned.",
  };
  const tree = ScheduleView(props);
  const all = elements(tree);
  const row = all.find((el) => el.type === "button" && classes(el).includes("dotline"))!;
  const title = all.find((el) => el.type === "span" && el.props.children === event.title)!;
  const day = all.find((el) => el.type === "li" && classes(el).includes("grid"))!;
  assert.ok(classes(day).includes("grid-cols-1"), "phone date is a heading rather than a fixed left column");
  assert.ok(classes(row).includes("grid-cols-[12px_minmax(0,1fr)]"), "phone event has no fixed time column");
  assert.ok(classes(title).includes("break-words"), "long names can wrap");
  assert.ok(!classes(title).includes("truncate"), "full mobile title must not be ellipsised");
  assert.equal(text(title), event.title);
  console.log("ok phone agenda gives the full title a wrapping line");

  const time = all.find((el) => el.type === "span" && classes(el).includes("row-start-2"))!;
  assert.ok(classes(time).includes("sm:row-start-1"));
  assert.ok(classes(row).includes("sm:grid-cols-[12px_128px_minmax(0,1fr)]"));
  assert.ok(classes(day).includes("sm:grid-cols-[120px_minmax(0,1fr)]"));
  assert.ok(classes(title).includes("sm:truncate"));
  assert.match(text(time), /9.*9:45am/);
  console.log("ok time is secondary on phones and desktop keeps aligned columns");

  assert.equal(row.props.type, "button", "native keyboard activation stays available");
  const anchor = {} as HTMLElement;
  (row.props.onClick as (e: { currentTarget: HTMLElement }) => void)({ currentTarget: anchor });
  assert.deepEqual(opened, [occurrence, anchor]);
  const dayButton = all.find((el) => el.type === "button" && !classes(el).includes("dotline"))!;
  assert.equal(dayButton.props.type, "button");
  (dayButton.props.onClick as () => void)();
  assert.equal(picked?.getDate(), 26);
  assert.equal(row.props["data-hue"], "moss");
  assert.equal(row.props["data-selected"], true);
  assert.ok(all.some((el) => el.props["aria-label"] === "Repeats"));
  console.log("ok keyboard buttons, detail anchor, day navigation, colours and recurrence remain intact");

  const allDay = { ...occurrence, start: new Date("2026-10-26T00:00:00"), end: new Date("2026-10-27T00:00:00"), allDay: true };
  assert.match(text(ScheduleView({ ...props, occurrences: [allDay] })), /All day/);
  const multiDay = { ...occurrence, end: new Date("2026-10-28T10:00:00") };
  const multiText = text(ScheduleView({ ...props, occurrences: [multiDay] }));
  assert.match(multiText, /From 9am/);
  assert.match(multiText, /All day/);
  assert.match(multiText, /Until 10am/);
  console.log("ok all-day and multi-day labels survive the layout change");

  const empty = ScheduleView({ ...props, occurrences: [], heading: "Search results" });
  assert.equal(elements(empty).filter((el) => el.type === "button").length, 0);
  assert.match(text(empty), /Search resultsNothing planned\./);
  console.log("ok empty and search states remain readable");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
