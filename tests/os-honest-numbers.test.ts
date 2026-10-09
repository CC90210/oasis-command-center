/**
 * OASIS OS F1.1 — every number on Today and the department tabs means what it
 * says (tests/os-today.test.ts pins the money gate and "unknown is not zero";
 * this file pins the MEANINGS the 2026-09-29 audit found wrong).
 *
 * WHY THIS EXISTS. A replay of the page code against production reproduced
 * CC's Today to the cent. The arithmetic was right; the meanings were not:
 *
 *   - "Cash on hand −CA$1,788.23" was six September expenses from a chequing
 *     account with no opening balance, plus Stripe money never paid out in the
 *     books. Stripe's own balance was $0.
 *   - "15 follow-ups past due" were all promises from BEFORE the revenue cycle,
 *     "2 in founder meetings" were meetings weeks gone with no outcome, and 42
 *     open leads had no next step at all.
 *   - Chief of Staff said "1" on Today and "0" on its own tab.
 *   - "Within SLA" with zero tickets ever; "Bank lines to review: None" with no
 *     bank feed; "Meta Ads · Not connected" on a card that reads Zernio;
 *     Operations hardcoded "Not measured yet"; Google Calendar "Not connected"
 *     from a check that looked at one empty table and swallowed read errors;
 *     hot replies that turned a failed read into "none".
 *
 * Each block below is a golden fixture for one tile, with the case that was
 * wrong in production. The I/O blocks run the real readers against a local
 * libSQL file with TWO workspaces, so scoping is proven, not assumed.
 *
 * Run: node --conditions=react-server --import tsx tests/os-honest-numbers.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createElement, isValidElement, type ReactNode } from "react";

// ── Environment: a local libSQL file, never a remote database ──────────────
const dbFile = join(mkdtempSync(join(tmpdir(), "os-honest-numbers-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FOUNDERS_TENANT_IDS;
// Test-only key for the key store's ciphertexts (the Zernio key check reads one).
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "os-honest-numbers-field-key-long-enough-0001";
// The OASIS workspace calendar identity (fake values; nothing calls Google).
process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_ID = "test-client-id";
process.env.GOOGLE_SYSTEM_CALENDAR_CLIENT_SECRET = "test-client-secret";
process.env.GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN = "test-refresh-token";
process.env.GOOGLE_SYSTEM_CALENDAR_ADDRESS = "bookings@oasis.test";
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

// tsconfig keeps jsx:"preserve", so tsx compiles components with the classic runtime.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
// next/link needs the browser router; an anchor is all these tests read.
const linkPath = require.resolve("next/link");
require.cache[linkPath] = {
  id: linkPath,
  filename: linkPath,
  path: dirname(linkPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: ReactNode }) =>
      createElement("a", { href, ...rest }, children),
  },
} as unknown as NodeModule;

// next/navigation builds React contexts at import time, which react-server does
// not have; something on the loaders' import path touches it. Hooks only.
const navPath = require.resolve("next/navigation");
const hookOnly = () => {
  throw new Error("client hook called under react-server");
};
require.cache[navPath] = {
  id: navPath,
  filename: navPath,
  path: dirname(navPath),
  loaded: true,
  children: [],
  paths: [],
  exports: { __esModule: true, useRouter: hookOnly, usePathname: hookOnly, useSearchParams: hookOnly, notFound: hookOnly, redirect: hookOnly },
} as unknown as NodeModule;

const NOT_TEXT = new Set(["className", "id", "role", "style", "key", "href"]);
function textOf(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 80 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out, depth + 1);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    if (typeof node.type === "function") {
      const rendered = (node.type as (p: unknown) => unknown)(props);
      textOf(rendered, out, depth + 1);
      return out;
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") textOf(v as ReactNode, out, depth + 1);
      else if (typeof v === "string" && !NOT_TEXT.has(k)) out.push(v);
    }
  }
  return out;
}
const render = (el: unknown) => textOf(el).join(" ").replace(/\s+/g, " ");
const ROOT = join(__dirname, "..");
const code = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 5).join("\n        ")}`);
  }
}

const TENANT_A = "tenant-a-oasis";
const TENANT_B = "tenant-b-client";
const iso = (ms: number) => new Date(ms).toISOString();

async function main() {
  const model = await import("../components/os/today/model");
  const { KpiTile } = await import("../components/os/KpiTile");
  const { DepartmentCard } = await import("../components/os/today/DepartmentCard");
  const { CashGlance } = await import("../components/os/today/CashGlance");
  const { ScheduleGlance } = await import("../components/os/today/ScheduleGlance");
  const { NeedsYouList } = await import("../components/os/today/NeedsYouList");
  const cashCoverageMod = await import("../lib/founders-finances/cash-coverage");
  const { cashCoverage } = cashCoverageMod;
  const rules = await import("../components/os/department/routine-rules");
  const moneyModel = await import("../components/os/landings/money-model");
  const { formatCents } = await import("../lib/founders-finances/money");
  const { OS_DEPARTMENTS } = await import("../lib/os/departments");
  const dept = (key: string) => OS_DEPARTMENTS.filter((d) => d.key === key).map((d) => ({ key: d.key, label: d.label, href: d.href }));
  const when = () => "Sep 29, 4:16 PM";

  console.log("os-honest-numbers:");

  // ── 1. The fifth tile state: "no data yet" is words, never a 0 ────────────
  await check("KpiTile: no_data prints its words, never the value and never 0", () => {
    const tile = render(createElement(KpiTile, { label: "SLA breached", value: 0, status: "no_data", emptyText: "No tickets yet" }));
    assert.match(tile, /SLA breached No tickets yet/);
    assert.doesNotMatch(tile, /(^|\s)0(\s|$)|—/, `a no-data tile printed a number or a dash: ${tile}`);
    assert.match(render(createElement(KpiTile, { label: "Routines on", value: null, status: "no_data" })), /No data yet/, "a default phrase");
    const live = render(createElement(KpiTile, { label: "SLA breached", value: "0", status: "live" }));
    assert.match(live, /(^|\s)0(\s|$)/, "a live zero is still a zero");
  });

  // ── 2. Sales: overdue vs carried over vs no next step vs no outcome ───────
  // Production shape at 2026-09-29T19:36Z, cycle revenue-2026-09-23.
  const now = Date.parse("2026-09-29T19:36:00Z");
  const cycleStartedAt = "2026-09-23T06:00:00.000Z";
  const day = { startMs: Date.parse("2026-09-29T04:00:00Z"), endMs: Date.parse("2026-09-30T04:00:00Z") };
  const leads = [
    { id: "acoustic", data: { company: "Acoustic Tech", stage: "founder_meeting_booked", founder_meeting_at: "2026-09-04T15:30:00Z", next_action_at: "2026-09-04T15:30:00Z" } },
    { id: "broadway", data: { company: "Broadway Locksmith", stage: "founder_meeting_booked", founder_meeting_at: "2026-09-11T18:00:00Z" } },
    { id: "porsche", data: { company: "Porsche of Halifax", stage: "attempting_contact", next_action_at: "2026-09-09T19:00:00Z" } },
    { id: "common", data: { company: "Common Ground Power Services", stage: "connected", next_action_at: "2026-09-17T17:00:00Z" } },
    { id: "fresh", data: { company: "Fresh Roofing", stage: "connected", next_action_at: "2026-09-26T14:00:00Z" } },
    { id: "later", data: { company: "Later Co", stage: "qualified", next_action_at: "2026-10-02T14:00:00Z" } },
    { id: "bulk1", data: { company: "Bulk One", stage: "assigned" } },
    { id: "bulk2", data: { company: "Bulk Two", stage: "assigned" } },
    { id: "cancelled", data: { company: "Cancelled Co", stage: "founder_meeting_booked", founder_meeting_at: "2026-09-20T15:00:00Z", founder_meeting_status: "cancelled_by_client" } },
    { id: "upcoming", data: { company: "Upcoming Co", stage: "founder_meeting_booked", founder_meeting_at: "2026-10-01T15:00:00Z", next_action_at: "2026-10-01T15:00:00Z" } },
    { id: "won", data: { company: "Won Co", stage: "won", next_action_at: "2026-09-01T12:00:00Z" } },
    { id: "lost", data: { company: "Lost Co", stage: "lost" } },
  ];
  const summary = { onBoard: 11, qualified: 1, meetings: 4, won: 1, lost: 1, cycleStartedAt };
  const board = model.summarizeBoard({ rows: leads, summary, truncatedStages: [], nowMs: now, day });

  await check("sales buckets: pre-cycle promises are carried over, never fresh overdue", () => {
    assert.deepEqual(board.overdue.map((l) => l.id), ["fresh"], "only a next step dated inside the cycle is overdue");
    assert.deepEqual(board.carriedOver.map((l) => l.id), ["porsche", "common"], "dated before 2026-09-23: carried over, oldest first");
  });
  await check("sales buckets: a booked meeting whose time passed is 'no outcome', counted once", () => {
    assert.deepEqual(board.outcomeMissing.map((l) => l.id), ["acoustic", "broadway"]);
    // Acoustic Tech also has a pre-cycle next_action_at: it is a missing
    // outcome, NOT also a carried-over follow-up.
    const all = [...board.outcomeMissing, ...board.overdue, ...board.carriedOver, ...board.noNextStep].map((l) => l.id);
    assert.equal(new Set(all).size, all.length, `a lead was counted twice: ${all.join(", ")}`);
    assert.ok(!all.includes("upcoming"), "a meeting still ahead needs nothing");
    assert.ok(!all.includes("won") && !all.includes("lost"), "closed stages have nothing to follow up");
  });
  await check("sales buckets: open leads with no next step are named; a cancelled meeting is not a missing outcome", () => {
    assert.deepEqual(board.noNextStep.map((l) => l.id), ["bulk1", "bulk2", "cancelled"]);
  });
  await check("records source (no revenue cycle): nothing is carried over", () => {
    const records = model.summarizeRecords(leads, leads.length, now, day);
    assert.deepEqual(records.carriedOver, []);
    assert.deepEqual(records.overdue.map((l) => l.id), ["porsche", "common", "fresh"]);
  });

  // Review probe (2026-09-29): a meeting that started 10 minutes ago, with
  // next_action_at = the meeting time as app/api/website-sales/[leadId] writes
  // it, read "no outcome recorded" AND "booked today": one lead, 2 in the total.
  const minute = 60_000;
  const meetingLeads = [
    { id: "running", data: { company: "In Progress Co", stage: "founder_meeting_booked", founder_meeting_at: iso(now - 10 * minute), next_action_at: iso(now - 10 * minute), audit_duration_minutes: 15 } },
    // Ended 35 minutes ago: inside the hour allowed to write the outcome down.
    { id: "ended", data: { company: "Just Ended Co", stage: "founder_meeting_booked", founder_meeting_at: iso(now - 50 * minute), next_action_at: iso(now - 50 * minute) } },
    { id: "earlier", data: { company: "Morning Co", stage: "founder_meeting_booked", founder_meeting_at: iso(now - 3 * 60 * minute), next_action_at: iso(now - 3 * 60 * minute) } },
    { id: "tomorrow", data: { company: "Tomorrow Co", stage: "founder_meeting_booked", founder_meeting_at: "2026-09-30T15:00:00Z" } },
    { id: "prep", data: { company: "Prep Co", stage: "founder_meeting_booked", founder_meeting_at: "2026-09-30T15:00:00Z", next_action_at: "2026-09-28T15:00:00Z" } },
  ];
  await check("sales buckets: a meeting still running or just ended is not a missing outcome; a booked meeting ahead is the next step", () => {
    const b = model.salesBuckets(meetingLeads, now, Date.parse(cycleStartedAt));
    assert.deepEqual(b.outcomeMissing.map((l) => l.id), ["earlier"], "only a meeting that ended over an hour ago has a missing outcome");
    assert.deepEqual(b.noNextStep, [], "a booked meeting ahead IS the next step, even with no next_action_at");
    assert.deepEqual(b.overdue.map((l) => l.id), ["prep"], "a follow-up promised for BEFORE the meeting can still be late");
    assert.deepEqual(b.carriedOver, []);
  });
  await check("Needs you: a meeting with no outcome is counted once, never also as 'booked today'", () => {
    const snap = model.summarizeBoard({ rows: meetingLeads, summary: { ...summary, meetings: 5 }, truncatedStages: [], nowMs: now, day });
    assert.deepEqual(snap.meetingsToday.map((l) => l.id), ["earlier", "ended", "running"], "the schedule still lists the whole day");
    const list = model.buildNeedsYou({ sales: { ok: true, value: snap }, delivery: null, inbound: null, cash: null, nowMs: now, formatTime: () => "2:46 PM" });
    const byId = Object.fromEntries(list.items.map((i) => [i.id, i]));
    assert.equal(byId["meeting-outcomes"]?.count, 1);
    assert.deepEqual([byId["meetings-today"]?.count, byId["meetings-today"]?.title], [2, "2 meetings booked today"], "Morning Co is in the outcomes row, not here too");
    assert.equal(byId["meetings-today"]?.detail, "First at 2:46 PM with Just Ended Co");
    // 1 missing outcome + 1 late prep follow-up. Today's booked meetings are a
    // Review row (W2a: drawn, not counted as waiting on the viewer).
    assert.deepEqual(model.needsYouTotal(list), { total: 2, capped: false });
    const probe = model.buildNeedsYou({
      sales: { ok: true, value: model.summarizeBoard({ rows: meetingLeads.slice(0, 1), summary, truncatedStages: [], nowMs: now, day }) },
      delivery: null,
      inbound: null,
      cash: null,
      nowMs: now,
    });
    assert.deepEqual(probe.items.map((i) => i.id), ["meetings-today"], "a running meeting is on the schedule, not a missed close-out");
    assert.deepEqual(model.needsYouTotal(probe), { total: 0, capped: false }, "a meeting on the schedule is not waiting on anyone");
  });
  // Verify-fix probes (2026-09-29): the rows are right to name these leads
  // twice, and the shared total counted each of them twice.
  const hour = 60 * minute;
  const twoRowLeads = [
    // A meeting later today (5:36 PM Toronto) and a follow-up it promised for yesterday.
    { id: "prep-late", data: { company: "Prep Late Co", stage: "founder_meeting_booked", founder_meeting_at: iso(now + 2 * hour), next_action_at: iso(now - 20 * hour) } },
    // A meeting this morning, moved to demo_completed, no next step set since.
    { id: "held", data: { company: "Held Co", stage: "demo_completed", founder_meeting_at: iso(now - 5 * hour) } },
  ];
  await check("Needs you total: a lead in two rows is ONE thing waiting; the rows keep their own counts", () => {
    const listFor = (rows: typeof twoRowLeads) =>
      model.buildNeedsYou({ sales: { ok: true, value: model.summarizeRecords(rows, rows.length, now, day) }, delivery: null, inbound: null, cash: null, nowMs: now });
    for (const [lead, rows, total] of [
      [twoRowLeads[0], ["follow-ups", "meetings-today"], 1],
      // Both of its rows are Review rows (W2a): drawn, nothing counted.
      [twoRowLeads[1], ["no-next-step", "meetings-today"], 0],
    ] as const) {
      const list = listFor([lead]);
      assert.deepEqual(list.items.map((i) => [i.id, i.count]), rows.map((id) => [id, 1]), `${lead.id}: each row still says what is true of the lead`);
      assert.deepEqual(model.needsYouTotal(list), { total, capped: false }, `${lead.id}: one lead at most, however many rows name it`);
    }
    // Both leads, and a row that is not about leads: the late follow-up's lead
    // + 1 routine = 2. Held Co's rows are Review rows, and nothing is counted twice.
    const both = model.buildNeedsYou({
      sales: { ok: true, value: model.summarizeRecords(twoRowLeads, 2, now, day) },
      delivery: null,
      inbound: null,
      cash: null,
      routines: { ok: true, value: { total: 1, on: 1, failed24h: [{ id: "w9", agentKey: "x", name: "x", description: "", schedule: "", enabled: true, lastRunAt: iso(now - hour), lastRunStatus: "error", lane: "workspace" }], lastSuccessAt: null } },
      nowMs: now,
    });
    assert.deepEqual(model.needsYouTotal(both), { total: 2, capped: false });
    // No row claims more leads than exist: each lead row's number is its own
    // leads, every one of them real, and none exceeds the leads there are.
    for (const item of both.items.filter((i) => i.subjects)) {
      assert.equal(item.count, item.subjects?.length, `${item.id}: its count is its leads`);
      assert.ok((item.count ?? 0) <= twoRowLeads.length, `${item.id} claims ${item.count} leads of ${twoRowLeads.length}`);
      assert.match(item.title, new RegExp(`^${item.count} `), `${item.id}: ${item.title}`);
    }
    assert.equal(both.items.find((i) => i.id === "meetings-today")?.title, "2 meetings booked today");
    // The Chief of Staff card prints the same deduped total as the header.
    const cos = model.buildDepartmentCards({
      departments: dept("chief_of_staff"),
      needsYou: both,
      sales: null,
      delivery: null,
      content: null,
      goal: null,
      stripeConnected: null,
      routines: null,
      nowMs: now,
    })[0];
    assert.equal(cos.status, "2 waiting on you");
  });

  const needs = model.buildNeedsYou({
    sales: { ok: true, value: board },
    delivery: null,
    inbound: null,
    cash: null,
    approvals: { ok: true, value: { items: [], total: 2 } },
    routines: { ok: true, value: { total: 5, on: 3, failed24h: [{ id: "w1", agentKey: "x", name: "x", description: "", schedule: "", enabled: true, lastRunAt: iso(now - 3_600_000), lastRunStatus: "error", lane: "workspace" }], lastSuccessAt: iso(now - 600_000) } },
    nowMs: now,
    formatTime: () => "3:00 PM",
  });

  await check("Needs you: one row per bucket, each with its own words and count", () => {
    const byId = Object.fromEntries(needs.items.map((i) => [i.id, i]));
    assert.equal(byId["follow-ups"]?.title, "1 follow-up is past due");
    assert.equal(byId["meeting-outcomes"]?.title, "2 founder meetings have no outcome recorded");
    assert.match(byId["meeting-outcomes"]?.detail ?? "", /^Acoustic Tech, Broadway Locksmith · the meeting time has passed$/);
    assert.equal(byId["follow-ups-carried"]?.title, "2 follow-ups were due before this cycle began");
    assert.match(byId["follow-ups-carried"]?.detail ?? "", /^Carried over · Porsche of Halifax, Common Ground Power Services$/);
    assert.equal(byId["no-next-step"]?.title, "3 open leads have no next step");
    assert.equal(byId["routines-failed"]?.title, "1 routine failed in the last 24 hours");
    assert.equal(byId["routines-failed"]?.href, "/team/operations", "the Operations panel lists the workspace lane");
  });
  await check("Needs you: a failed Empire routine points at Automations, the one page that lists it", () => {
    const failedRow = { id: "e1", agentKey: "bravo", name: "Nightly Harness Eval", description: "", schedule: "", enabled: true, lastRunAt: iso(now - 3_600_000), lastRunStatus: "error" };
    const list = model.buildNeedsYou({
      sales: null,
      delivery: null,
      inbound: null,
      cash: null,
      routines: { ok: true, value: { total: 3, on: 3, failed24h: [{ ...failedRow, lane: "empire" as const }], lastSuccessAt: null } },
      nowMs: now,
    });
    assert.deepEqual(
      [list.items[0]?.href, list.items[0]?.detail],
      ["/automations", "Open Automations to see which, and what the last run said"],
      "the Operations panel cannot show an Empire row, so the link must not go there",
    );
    assert.equal(rules.failedRoutinesHref([{ lane: "workspace" }, { lane: "empire" }]), "/automations");
    assert.equal(rules.failedRoutinesHref([{ lane: "workspace" }]), "/team/operations");
  });

  // ── 3. Chief of Staff: ONE count, on Today and on its tab ─────────────────
  await check("Chief of Staff: Today's card, the Needs you header and the tab print the same THING count", () => {
    const { total, capped } = model.needsYouTotal(needs);
    // 1 overdue + 2 no-outcome + 1 routine + 2 approvals. The 2 carried over and
    // the 3 with no next step are Review rows (W2a): drawn, never counted.
    assert.deepEqual({ total, capped }, { total: 6, capped: false }, "things, not rows, and never the Review rows");
    const [cos] = model.buildDepartmentCards({
      departments: dept("chief_of_staff"),
      needsYou: needs,
      sales: null,
      delivery: null,
      content: null,
      goal: null,
      stripeConnected: null,
      routines: null,
    });
    assert.deepEqual([cos.metric.kind === "live" && cos.metric.value, cos.status], ["6", "6 waiting on you"]);
    const header = render(createElement(NeedsYouList, { needsYou: needs }));
    assert.match(header, /Needs you 6 items 6 /, `the Needs you header must print the same total: ${header.slice(0, 80)}`);
    // The tab (components/os/department/numbers.ts) carries needsYouTotal over
    // the SAME reads, and the page prints it: the three cannot drift.
    const numbers = code("components/os/department/numbers.ts");
    assert.match(numbers, /loadNeedsYouReads\(\{\s*viewer: viewer\.surface,\s*navInput: viewer\.navInput,\s*plan,\s*showFinancials,\s*day,/);
    assert.match(numbers, /const needs = needsYouFrom\(reads, day\.nowMs\);/);
    assert.match(numbers, /needsYou: needsYouTotal\(needs\),/);
    // Its lines are the rows the count is made of: no Review row is listed
    // under a header that does not count it (W2a).
    assert.match(numbers, /attention: needs\.items\.filter\(\(item\) => !isReviewItem\(item\)\)\.map\(/);
    assert.match(numbers, /const showFinancials = viewer\.surface\.capabilities\.canSeeCompanyFinancials && plan\.money;/, "the tab narrows money exactly as Today does");
    const page = code("app/team/[dept]/page.tsx");
    assert.match(page, /const needsYou = numbers\.needsYou\s*\?\s*numbers\.needsYou\.total/, "the tab header prints the shared total");
    assert.match(page, /department: dept\.key === "chief_of_staff" \? null : dept\.key/, "its approval cards are the ones its count includes");
    assert.match(code("components/today/FounderToday.tsx"), /const needsYou = needsYouFrom\(reads, day\.nowMs\);/, "Today builds the list from the same reads");
  });
  await check("Chief of Staff: an unread source with nothing found is unknown, not 'Nothing waiting · 0'", () => {
    const gap = model.buildNeedsYou({ sales: { ok: false }, delivery: null, inbound: null, cash: null, nowMs: now });
    const [cos] = model.buildDepartmentCards({
      departments: dept("chief_of_staff"),
      needsYou: gap,
      sales: null,
      delivery: null,
      content: null,
      goal: null,
      stripeConnected: null,
      routines: null,
    });
    assert.equal(cos.metric.kind, "error");
    assert.equal(cos.status, "Partly checked");
    // A failed approvals read is a floor too, on Today and on the tab alike.
    const noApprovals = model.buildNeedsYou({ sales: null, delivery: null, inbound: null, cash: null, approvals: { ok: false }, nowMs: now });
    assert.deepEqual(model.needsYouTotal(noApprovals), { total: 0, capped: true });
    assert.doesNotMatch(render(createElement(DepartmentCard, { card: cos })), /(^|\s)0(\s|$)/);
  });

  // ── 4. Sales card: the meetings line splits out missing outcomes ──────────
  await check("Sales card: status leads with the fresh miss; meetings with no outcome are said apart", () => {
    const [sales] = model.buildDepartmentCards({
      departments: dept("sales"),
      needsYou: needs,
      sales: { ok: true, value: board },
      delivery: null,
      content: null,
      goal: null,
      stripeConnected: null,
      routines: null,
    });
    assert.equal(sales.status, "1 follow-up past due");
    assert.equal(sales.detail, "1 qualified · 2 in founder meetings · 2 meetings with no outcome · 1 won");
    const carriedOnly = model.summarizeBoard({ rows: leads.filter((l) => ["porsche", "bulk1"].includes(l.id)), summary, truncatedStages: [], nowMs: now, day });
    const [c] = model.buildDepartmentCards({
      departments: dept("sales"),
      needsYou: needs,
      sales: { ok: true, value: carriedOnly },
      delivery: null,
      content: null,
      goal: null,
      stripeConnected: null,
      routines: null,
    });
    assert.deepEqual([c.status, c.tone], ["1 follow-up carried over", "attention"], "a carried-over date is never 'past due'");
  });

  // ── 5. Client Success: no ticket ever is "No tickets yet", not "Within SLA" ─
  const desk = (closedTicketsExist: boolean) =>
    model.summarizeDelivery({
      viewerKind: "founder",
      tickets: [],
      projects: [],
      ticketsTruncated: false,
      projectsTruncated: false,
      closedTicketsExist,
      now: new Date(now),
      todayKey: "2026-09-29",
    });
  const csCard = (closedTicketsExist: boolean) =>
    model.buildDepartmentCards({
      departments: dept("client_success"),
      needsYou: { items: [], unavailable: [] },
      sales: null,
      delivery: { ok: true, value: desk(closedTicketsExist) },
      content: null,
      goal: null,
      stripeConnected: null,
      routines: null,
    })[0];
  await check("Client Success: a desk with no ticket history says 'No tickets yet', never 'Within SLA'", () => {
    const empty = csCard(false);
    assert.deepEqual([empty.status, empty.metric.kind, empty.tone], ["No tickets yet", "no_data", "quiet"]);
    const text = render(createElement(DepartmentCard, { card: empty }));
    assert.doesNotMatch(text, /Within SLA|0 open tickets/, `an unused desk claimed health: ${text}`);
    assert.match(text, /The support desk has had no tickets yet/);
  });
  await check("Client Success: once any ticket existed, 0 open is a real 'Within SLA' (control)", () => {
    const used = csCard(true);
    assert.deepEqual([used.status, used.metric.kind === "live" && used.metric.value], ["Within SLA", "0"]);
  });
  await check("Needs you: a missed SLA on a CLIENT's request to OASIS is OASIS's miss, never the client's task", () => {
    const breachedDesk = (viewerKind: "founder" | "client") =>
      model.summarizeDelivery({
        viewerKind,
        tickets: [{ id: "t1", ticket_number: "T-0001", title: "Site down", status: "open", severity: "critical", sla_target: iso(now - 3_600_000), first_response_at: null, created_at: iso(now - 7_200_000) }],
        projects: [],
        ticketsTruncated: false,
        projectsTruncated: false,
        closedTicketsExist: false,
        now: new Date(now),
        todayKey: "2026-09-29",
      });
    const client = model.buildNeedsYou({ sales: null, delivery: { ok: true, value: breachedDesk("client") }, inbound: null, cash: null, nowMs: now });
    assert.deepEqual([client.items, model.needsYouTotal(client)], [[], { total: 0, capped: false }], "nothing is added to a client's count");
    const team = model.buildNeedsYou({ sales: null, delivery: { ok: true, value: breachedDesk("founder") }, inbound: null, cash: null, nowMs: now });
    assert.deepEqual(team.items.map((i) => i.id), ["sla-breached"], "the team that owes the reply is told (control)");
  });
  await check("Client Success card: a CLIENT of OASIS's desk sees their open requests, never 'past SLA'", () => {
    const deskFor = (viewerKind: "founder" | "client") =>
      model.summarizeDelivery({
        viewerKind,
        tickets: [{ id: "t1", ticket_number: "T-0001", title: "Site down", status: "open", severity: "critical", sla_target: iso(now - 3_600_000), first_response_at: null, created_at: iso(now - 7_200_000) }],
        projects: [],
        ticketsTruncated: false,
        projectsTruncated: false,
        closedTicketsExist: false,
        now: new Date(now),
        todayKey: "2026-09-29",
      });
    const cardFor = (viewerKind: "founder" | "client") =>
      model.buildDepartmentCards({
        departments: dept("client_success"),
        needsYou: { items: [], unavailable: [] },
        sales: null,
        delivery: { ok: true, value: deskFor(viewerKind) },
        content: null,
        goal: null,
        stripeConnected: null,
        routines: null,
        nowMs: now,
      })[0];
    const client = cardFor("client");
    const text = render(createElement(DepartmentCard, { card: client }));
    assert.doesNotMatch(text, /SLA/, `a client was shown OASIS's missed SLA: ${text}`);
    assert.notEqual(client.tone, "needs_you", "their request is not their task");
    assert.deepEqual([client.status, client.metric.kind === "live" && client.metric.value, client.metric.label], ["Requests open with OASIS", "1", "open request"]);
    const team = cardFor("founder");
    assert.deepEqual([team.tone, team.status], ["needs_you", "1 past SLA"], "the team that owes the reply is told (control)");
  });

  // ── 6. Marketing: the line names the source the number comes from ─────────
  const marketing = (content: Parameters<typeof model.buildDepartmentCards>[0]["content"]) =>
    model.buildDepartmentCards({
      departments: dept("marketing"),
      needsYou: { items: [], unavailable: [] },
      sales: null,
      delivery: null,
      content,
      goal: null,
      stripeConnected: null,
      routines: null,
      nowMs: now,
      formatWhen: when,
    })[0];
  await check("Marketing: 'Zernio post analytics · Last synced …', never a fixed 'Meta Ads · Not connected'", () => {
    const live = marketing({ ok: true, value: { published: 12, lastSyncedAt: "2026-09-29T20:22:00Z", zernioConnected: null } });
    assert.deepEqual(live.connection, { label: "Zernio post analytics", state: "live", note: "Last synced Sep 29, 4:16 PM", href: null });
    const text = render(createElement(DepartmentCard, { card: live }));
    assert.match(text, /12 pieces published in 7 days/);
    assert.match(text, /Zernio post analytics · Last synced Sep 29, 4:16 PM/);
    assert.doesNotMatch(text, /Meta|Not connected|Connect/, `the card claims an app it does not read: ${text}`);
  });
  await check("Marketing: a sync older than the week it counts is not a count ('too old'), never a live 0", () => {
    const at = (daysAgo: number) => iso(now - daysAgo * 86_400_000);
    const card = (lastSyncedAt: string) =>
      model.buildDepartmentCards({
        departments: dept("marketing"),
        needsYou: { items: [], unavailable: [] },
        sales: null,
        delivery: null,
        content: { ok: true, value: { published: 0, lastSyncedAt, zernioConnected: null } },
        goal: null,
        stripeConnected: null,
        routines: null,
        nowMs: now,
        formatWhen: when,
      })[0];
    const stale = card(at(9));
    assert.deepEqual(
      [stale.metric.kind, stale.status, stale.connection?.state, stale.connection?.note],
      ["error", "Sync stopped", "error", "Last synced Sep 29, 4:16 PM: too old to count this week"],
    );
    const text = render(createElement(DepartmentCard, { card: stale }));
    assert.doesNotMatch(text, /(^|\s)0(\s|$)|Nothing published/, `a stale sync printed a live zero: ${text}`);
    const fresh = card(at(1));
    assert.deepEqual([fresh.metric.kind, fresh.status], ["live", "Nothing published this week"], "a sync inside the week counts (control)");
  });
  await check("Marketing: nothing ever synced is 'no data', and a failed read is 'Couldn't check'", () => {
    const none = marketing({ ok: true, value: { published: 0, lastSyncedAt: null, zernioConnected: true } });
    assert.deepEqual([none.metric.kind, none.connection?.state, none.connection?.note], ["no_data", "no_data", "Nothing synced yet"]);
    assert.doesNotMatch(render(createElement(DepartmentCard, { card: none })), /(^|\s)0(\s|$)/, "never '0 published' for a source that never reported");
    const failed = marketing({ ok: false });
    assert.deepEqual([failed.metric.kind, failed.connection?.note], ["error", "Couldn't check"]);
  });
  await check("Marketing (W2a, U2-13): a workspace that never connected Zernio is told to connect a social account", () => {
    const fresh = marketing({ ok: true, value: { published: 0, lastSyncedAt: null, zernioConnected: false } });
    assert.deepEqual(
      [fresh.status, fresh.metric.kind, fresh.connection],
      ["Connect a social account", "no_data", { label: "Social posting", state: "not_connected", note: "Not connected", href: "/settings/connections" }],
    );
    const text = render(createElement(DepartmentCard, { card: fresh }));
    assert.doesNotMatch(text, /Zernio|Nothing synced|(^|\s)0(\s|$)/, `an unconnected tool read as a broken sync: ${text}`);
  });

  // ── 7. Operations: real routine health from both lanes ────────────────────
  const row = (over: Partial<Parameters<typeof rules.normalizeRoutineRow>[0]>) =>
    rules.normalizeRoutineRow({ id: "r", agent_key: "a", name: "n", description: "", schedule: "* * * * *", enabled: 1, last_run_at: null, last_run_status: null, ...over });
  await check("routineHealth: on, failed in 24h among routines that are on, newest clean run", () => {
    const h = rules.routineHealth(
      [
        row({ id: "ok-old", last_run_at: iso(now - 5 * 3_600_000), last_run_status: "success" }),
        row({ id: "ok-new", last_run_at: iso(now - 600_000), last_run_status: "success" }),
        row({ id: "failed", last_run_at: iso(now - 3_600_000), last_run_status: "error" }),
        row({ id: "failed-old", last_run_at: iso(now - 30 * 3_600_000), last_run_status: "error" }),
        row({ id: "off-failed", enabled: 0, last_run_at: iso(now - 60_000), last_run_status: "error" }),
        row({ id: "off-newest-ok", enabled: 0, last_run_at: iso(now - 1_000), last_run_status: "success" }),
      ],
      now,
    );
    assert.deepEqual(
      { total: h.total, on: h.on, failed: h.failed24h.map((r) => r.id), last: h.lastSuccessAt },
      { total: 6, on: 4, failed: ["failed"], last: iso(now - 600_000) },
    );
    assert.deepEqual(rules.mergeRoutineReads({ ok: true, value: [] }, { ok: false }), { ok: false }, "half the routines is not an answer");
  });
  const opsCard = (routines: Parameters<typeof model.buildDepartmentCards>[0]["routines"]) =>
    model.buildDepartmentCards({
      departments: dept("operations"),
      needsYou: { items: [], unavailable: [] },
      sales: null,
      delivery: null,
      content: null,
      goal: null,
      stripeConnected: null,
      routines,
      formatWhen: when,
    })[0];
  await check("Operations card: real routines, not a hardcoded 'Not measured yet'", () => {
    const healthy = opsCard({ ok: true, value: { total: 4, on: 1, failed24h: [], lastSuccessAt: "2026-09-29T20:16:00Z" } });
    assert.deepEqual(
      [healthy.status, healthy.metric.kind === "live" && healthy.metric.value, healthy.metric.kind === "live" && healthy.metric.label, healthy.detail, healthy.tone],
      ["No failures in 24h", "1", "of 4 routines on", "Last successful run Sep 29, 4:16 PM", "ok"],
    );
    const failing = opsCard({ ok: true, value: { total: 4, on: 2, failed24h: [row({ id: "x" })], lastSuccessAt: null } });
    assert.deepEqual([failing.status, failing.tone, failing.detail], ["1 failed in 24h", "needs_you", "No successful run recorded yet"]);
    const none = opsCard({ ok: true, value: { total: 0, on: 0, failed24h: [], lastSuccessAt: null } });
    assert.deepEqual([none.metric.kind, none.status], ["no_data", "No routines yet"]);
    assert.equal(opsCard({ ok: false }).metric.kind, "error");
    const text = render(createElement(DepartmentCard, { card: healthy }));
    assert.doesNotMatch(text, /Not measured/);
  });

  // ── 8. Cash: incomplete books are never "Cash on hand" ────────────────────
  // The production ledger, shape for shape (2026-09-29): chequing holds only
  // hand-entered September expenses (rent voided and re-entered), Stripe
  // clearing holds charges less fees and refunds, and no payout.
  const accounts = [
    { id: "B:1000", code: "1000", name: "Business chequing", type: "asset" as const, subtype: "bank" },
    { id: "B:1010", code: "1010", name: "Business savings", type: "asset" as const, subtype: "bank" },
    { id: "B:1050", code: "1050", name: "Stripe clearing", type: "asset" as const, subtype: "clearing" },
    { id: "B:1060", code: "1060", name: "Currency exchange clearing", type: "asset" as const, subtype: "clearing" },
    { id: "B:3900", code: "3900", name: "Retained earnings", type: "equity" as const, subtype: "retained_earnings" },
    { id: "B:4010", code: "4010", name: "Subscription revenue", type: "revenue" as const, subtype: "revenue" },
    { id: "B:5000", code: "5000", name: "Stripe fees", type: "expense" as const, subtype: "expense" },
    { id: "B:5650", code: "5650", name: "Rent & occupancy", type: "expense" as const, subtype: "expense" },
  ];
  let seq = 0;
  const entry = (date: string, source: string, legs: Array<[string, number, number]>, status = "posted") => {
    seq += 1;
    return legs.map(([accountId, d, c]) => ({ entryId: `e${seq}`, entryDate: date, accountId, cadDebitCents: d, cadCreditCents: c, memo: "", entryMemo: "", source, status }));
  };
  const NO_OPENING = "Business chequing has no opening balance (post it from the Wise card in Finances › Settings)";
  // The same gap while bank feed writes are off (production; this process never
  // sets FINANCE_WISE_FEED_WRITES): the Wise card's Post button is disabled.
  const NO_OPENING_OFF = "Business chequing has no opening balance (recording one is not yet possible from the app while bank feed writes are off)";
  // The business book with the Wise card able to post (the pure checks below).
  const BIZ = { book: "business" as const, wiseWritesEnabled: true };
  const productionLines = [
    ...entry("2026-09-01", "expense", [["B:5650", 275000, 0], ["B:1000", 0, 275000]], "reversed"),
    ...entry("2026-09-01", "reversal", [["B:1000", 275000, 0], ["B:5650", 0, 275000]]),
    ...entry("2026-09-02", "expense", [["B:5650", 269513, 0], ["B:1000", 0, 269513]]),
    ...entry("2026-09-25", "expense", [["B:5650", 73231, 0], ["B:1000", 0, 73231]]),
    ...entry("2026-01-20", "stripe_charge", [["B:1050", 205000, 0], ["B:4010", 0, 205000]]),
    ...entry("2026-01-20", "stripe_fee", [["B:5000", 11079, 0], ["B:1050", 0, 11079]]),
    ...entry("2026-09-05", "stripe_refund", [["B:4010", 30000, 0], ["B:1050", 0, 30000]]),
  ];
  const cov = cashCoverage({ accounts, lines: productionLines, bankLinesByAccount: {}, ...BIZ });
  const ledgerTotal = productionLines
    .filter((l) => ["B:1000", "B:1010", "B:1050", "B:1060"].includes(l.accountId))
    .reduce((s, l) => s + l.cadDebitCents - l.cadCreditCents, 0);

  await check("cash coverage: the production ledger is incomplete, and says exactly why", () => {
    assert.equal(ledgerTotal, -178823, "the fixture reproduces the −CA$1,788.23 on screen");
    assert.equal(cov.complete, false);
    assert.deepEqual(cov.gaps, [NO_OPENING, "Stripe payouts to the bank are not recorded"], "each gap says how it is fixed");
    assert.deepEqual(cov.accounts.map((a) => a.code), ["1000", "1050"], "savings and FX clearing hold nothing and are not listed");
    assert.equal(cov.accounts[0].covers, "4 entries from Sep 1 to Sep 25; no opening balance; no bank import");
    assert.match(cov.accounts[1].covers, /^Card charges less Stripe fees and refunds from Jan 20 to Sep 5; no payout to the bank is recorded/);
    assert.equal(cov.bankLines, 0);
  });
  await check("cash coverage: an opening balance and a payout INTO a bank account complete the books", () => {
    const opening = entry("2026-08-31", "opening_balance", [["B:1000", 500000, 0], ["B:3900", 0, 500000]]);
    const toFx = entry("2026-09-08", "bank_import", [["B:1060", 6585, 0], ["B:1050", 0, 6585]]);
    const half = cashCoverage({ accounts, lines: [...productionLines, ...opening, ...toFx], bankLinesByAccount: { "B:1000": 3 }, ...BIZ });
    assert.deepEqual(half.gaps, ["Stripe payouts to the bank are not recorded"], "money moved to a clearing account is not a payout to the bank");
    const payout = entry("2026-09-08", "bank_import", [["B:1000", 6585, 0], ["B:1050", 0, 6585]]);
    const whole = cashCoverage({ accounts, lines: [...productionLines, ...opening, ...payout], bankLinesByAccount: { "B:1000": 3 }, ...BIZ });
    assert.deepEqual([whole.complete, whole.gaps], [true, []]);
    assert.equal(whole.accounts[0].covers, "6 entries from Aug 31 to Sep 25; opening balance recorded; 3 bank lines imported");
  });
  await check("cash coverage: a REVERSED opening balance records no starting point; only one in force counts", () => {
    const payout = entry("2026-09-08", "bank_import", [["B:1000", 6585, 0], ["B:1050", 0, 6585]]);
    // Replaced or removed from the Wise card: the original is marked reversed
    // and a reversal entry cancels it (ledger-io buildReversal).
    const voided = entry("2026-08-31", "opening_balance", [["B:1000", 500000, 0], ["B:3900", 0, 500000]], "reversed");
    const reversal = entry("2026-08-31", "reversal", [["B:3900", 500000, 0], ["B:1000", 0, 500000]]);
    const gone = cashCoverage({ accounts, lines: [...productionLines, ...voided, ...reversal, ...payout], bankLinesByAccount: {}, ...BIZ });
    assert.deepEqual(gone.gaps, [NO_OPENING], "the raw ledger figure must not come back as 'Cash on hand'");
    assert.equal(gone.accounts[0].hasOpeningBalance, false);
    // An account with no feed says so instead of pointing at a button that does not exist.
    const savings = entry("2026-09-10", "bank_import", [["B:1010", 1000, 0], ["B:4010", 0, 1000]]);
    const withSavings = cashCoverage({ accounts, lines: [...productionLines, ...savings], bankLinesByAccount: {}, ...BIZ });
    assert.ok(withSavings.gaps.includes("Business savings has no opening balance (recording one for this account is not yet possible from the app)"), withSavings.gaps.join(" | "));
  });
  await check("cash coverage: a VOIDED payout is no payout; only one in force counts", () => {
    const opening = entry("2026-08-31", "opening_balance", [["B:1000", 500000, 0], ["B:3900", 0, 500000]]);
    // Booked as a Stripe payout, then voided: the original is marked reversed
    // and a reversal entry moves the money back to clearing.
    const voided = entry("2026-09-08", "bank_import", [["B:1000", 6585, 0], ["B:1050", 0, 6585]], "reversed");
    const reversal = entry("2026-09-08", "reversal", [["B:1050", 6585, 0], ["B:1000", 0, 6585]]);
    const gone = cashCoverage({ accounts, lines: [...productionLines, ...opening, ...voided, ...reversal], bankLinesByAccount: {}, ...BIZ });
    assert.deepEqual([gone.complete, gone.gaps], [false, ["Stripe payouts to the bank are not recorded"]], "a voided payout must not complete the books");
    assert.match(gone.accounts[1].covers, /no payout to the bank is recorded/);
    const rebooked = entry("2026-09-09", "bank_import", [["B:1000", 6585, 0], ["B:1050", 0, 6585]]);
    const whole = cashCoverage({ accounts, lines: [...productionLines, ...opening, ...voided, ...reversal, ...rebooked], bankLinesByAccount: {}, ...BIZ });
    assert.deepEqual([whole.complete, whole.gaps], [true, []]);
  });
  // Verify-fix (2026-09-29): the check was the Wise source string, so an
  // opening balance posted any other way never counted.
  await check("cash coverage: ANY posted opening balance counts, whatever wrote it; reversed ones and reversals never do", () => {
    const payout = entry("2026-09-08", "bank_import", [["B:1000", 6585, 0], ["B:1050", 0, 6585]]);
    // Posted by hand (not the Wise card): chequing against Retained earnings, the book's opening-balance account.
    const byHand = entry("2026-08-31", "manual_journal", [["B:1000", 500000, 0], ["B:3900", 0, 500000]]);
    const opened = cashCoverage({ accounts, lines: [...productionLines, ...byHand, ...payout], bankLinesByAccount: {}, ...BIZ });
    assert.deepEqual([opened.complete, opened.accounts[0].hasOpeningBalance, opened.gaps], [true, true, []], "a hand-posted opening balance is a starting point");
    // Voided: the original is marked reversed, and the reversal entry has the
    // same shape the other way round. Neither is a starting point.
    const voided = entry("2026-08-31", "manual_journal", [["B:1000", 500000, 0], ["B:3900", 0, 500000]], "reversed");
    const undo = entry("2026-08-31", "reversal", [["B:3900", 500000, 0], ["B:1000", 0, 500000]]);
    const undone = cashCoverage({ accounts, lines: [...productionLines, ...voided, ...undo, ...payout], bankLinesByAccount: {}, ...BIZ });
    assert.deepEqual([undone.accounts[0].hasOpeningBalance, undone.gaps], [false, [NO_OPENING]], "a voided opening balance and its reversal record nothing");
    // Not opening balances: a transfer between two bank accounts, an owner's
    // contribution (owner equity, not the opening-balance account), an expense.
    const withOwner = [...accounts, { id: "B:3000", code: "3000", name: "Owner equity — CC", type: "equity" as const, subtype: "owner_equity" }];
    const transfer = entry("2026-09-03", "bank_import", [["B:1000", 1000, 0], ["B:1010", 0, 1000]]);
    const contribution = entry("2026-09-04", "manual_journal", [["B:1000", 20000, 0], ["B:3000", 0, 20000]]);
    const notOpening = cashCoverage({ accounts: withOwner, lines: [...productionLines, ...transfer, ...contribution, ...payout], bankLinesByAccount: {}, ...BIZ });
    assert.equal(notOpening.accounts[0].hasOpeningBalance, false, "only the opening-balance account makes an entry an opening balance");
  });
  await check("cash coverage: a personal book's Chequing is never sent to the business Wise card; its own opening balance counts", () => {
    const personal = [
      { id: "P:1000", code: "1000", name: "Chequing", type: "asset" as const, subtype: "bank" },
      { id: "P:3000", code: "3000", name: "Net worth (opening balance)", type: "equity" as const, subtype: "owner_equity" },
      { id: "P:5100", code: "5100", name: "Groceries", type: "expense" as const, subtype: "expense" },
    ];
    const groceries = entry("2026-09-10", "bank_txn", [["P:5100", 8240, 0], ["P:1000", 0, 8240]]);
    const bare = cashCoverage({ accounts: personal, lines: groceries, bankLinesByAccount: {}, book: "personal", wiseWritesEnabled: true });
    assert.deepEqual(bare.gaps, ["Chequing has no opening balance (recording one for this account is not yet possible from the app)"]);
    assert.doesNotMatch(bare.gaps.join(" "), /Wise|Settings/, "the Wise card posts to the business book only");
    const start = entry("2026-08-31", "manual_journal", [["P:1000", 100000, 0], ["P:3000", 0, 100000]]);
    const opened = cashCoverage({ accounts: personal, lines: [...groceries, ...start], bankLinesByAccount: {}, book: "personal", wiseWritesEnabled: true });
    assert.deepEqual([opened.complete, opened.gaps], [true, []], "the personal book's Net worth (opening balance) is its opening-balance account");
  });
  await check("cash coverage: the gap never names a disabled control (bank feed writes off)", () => {
    const off = cashCoverage({ accounts, lines: productionLines, bankLinesByAccount: {}, book: "business", wiseWritesEnabled: false });
    assert.deepEqual(off.gaps, [NO_OPENING_OFF, "Stripe payouts to the bank are not recorded"]);
    assert.doesNotMatch(off.gaps.join(" "), /Wise card|Finances › Settings/, "the Post button is disabled while writes are off");
    assert.doesNotMatch([...off.gaps, NO_OPENING, NO_OPENING_OFF].join(" "), /Bravo|Maven|Atlas/, "no agent is named to a client");
    // The switch the gap reads is the one the Wise card's Post button reads.
    assert.match(code("lib/founders-finances/reports-io.ts"), /book: business \? "business" : "personal",\s*wiseWritesEnabled: WISE_FEED_WRITES_ENABLED,/);
    assert.match(code("components/founders/finances/WiseCard.tsx"), /disabled=\{!WISE_FEED_WRITES_ENABLED \|\| busy !== null \|\| !!opening\.blocked\}/);
  });
  await check("Finances Overview: incomplete books print 'Books incomplete', the ledger total only as a labelled detail", () => {
    const { incompleteBooksNote } = cashCoverageMod;
    assert.equal(incompleteBooksNote(cov), `Not a cash balance yet: ${NO_OPENING}; Stripe payouts to the bank are not recorded.`);
    assert.equal(incompleteBooksNote({ complete: true, gaps: [] }), null);
    // 2026-09-30: /founders/finances (where Today's "Books incomplete" links)
    // redirects to /money, the one Money overview. Its Cash on hand is the
    // money-model tile ("Books incomplete" unless complete, checked below),
    // and its Accounts card calls the ledger totals balances only when the
    // note is null.
    assert.match(code("app/founders/finances/(overview)/page.tsx"), /redirect\("\/money"\)/, "the Finances overview is the Money overview");
    const page = code("app/money/page.tsx");
    assert.match(page, /const booksNote = incompleteBooksNote\(ov\.coverage\);/);
    assert.match(page, /booksNote \? "Ledger totals, CAD: the books are incomplete, so these are not balances yet" : "Balances today, CAD"/);
    assert.doesNotMatch(page, /formatCents\(ov\.cashTotal/, "no Cash on hand figure outside the money-model tile");
  });

  const snapshot = (coverage: typeof cov) =>
    model.cashView({
      ok: true,
      value: { cashCadCents: ledgerTotal, hasCashActivity: true, overdueCount: 0, overdueLabel: null, unreviewed: 0, coverage },
    });
  await check("Cash glance: 'Books incomplete' with the reasons; the ledger total only as a labelled detail", () => {
    const view = snapshot(cov);
    assert.equal(view.kind, "incomplete");
    const text = render(createElement(CashGlance, { view }));
    assert.match(text, /Books incomplete/);
    assert.ok(text.includes(`Not a cash balance yet: ${NO_OPENING}; Stripe payouts to the bank are not recorded`), text);
    assert.match(text, /Ledger total, incomplete -CA\$1,788\.23/);
    assert.doesNotMatch(text, /Cash on hand/, `incomplete books were presented as cash on hand: ${text}`);
    assert.match(text, /Business chequing ?: 4 entries from Sep 1 to Sep 25; no opening balance; no bank import/, "each account says what it covers");
    assert.match(text, /Bank lines to review Bank not connected · Connect/, "no bank feed is not 'None to review'");
  });
  await check("Cash glance: complete books are Cash on hand, with the caption (control)", () => {
    const complete = { complete: true, gaps: [], bankLines: 4, accounts: [{ code: "1000", name: "Business chequing", subtype: "bank", balanceCents: 1, entries: 1, firstDate: null, lastDate: null, hasOpeningBalance: true, bankLines: 4, covers: "1 entry; opening balance recorded; 4 bank lines imported" }] };
    const text = render(createElement(CashGlance, { view: snapshot(complete) }));
    assert.match(text, /Cash on hand -CA\$1,788\.23/);
    assert.match(text, /Bank lines to review None/, "with a bank feed, nothing to review really is None");
  });
  await check("/money landing: incomplete books make Cash on hand 'Books incomplete', not a balance", () => {
    const input = {
      ov: { cashTotal: ledgerTotal, cashAccounts: [{ balanceCents: -342744 }], month: { inCents: 0, outCents: 0, netCents: 0 }, openAr: {}, overdueAr: {}, overdueCount: 0, unreviewed: 0, coverage: cov },
      collected: { cad_cents: 0, usd_cents: 0, payments: 0, fx_missing_days: [] },
      mrr: { mrr_cents: 0, currency: "CAD", active_subscriptions: 0, as_of: null },
      recent: [{}],
      stripePinned: true,
    };
    const tile = moneyModel.moneyTiles(input, formatCents).headline.find((t) => t.id === "cash");
    assert.deepEqual([tile?.status, tile?.emptyText, tile?.value], ["no_data", "Books incomplete", null]);
    assert.match(tile?.hint ?? "", /Ledger total, incomplete: -CA\$1,788\.23$/);
  });

  // ── 9. Calendar: the workspace calendar, and "Couldn't check" ─────────────
  await check("Schedule: the OASIS workspace calendar is reported, and a failed read says so", () => {
    const ok = render(
      createElement(ScheduleGlance, {
        meetings: null,
        partial: false,
        calendar: { ok: true, value: { personal: { connected: false, label: "Not connected", address: null }, workspace: { configured: true, address: "bookings@oasis.test" } } },
        connectHref: "/settings",
      }),
    );
    // The workspace calendar is the FALLBACK (google-calendar.ts: a host with
    // no usable personal login books on it), not where every meeting goes.
    assert.match(ok, /Workspace calendar \(bookings@oasis\.test\) · Set up: meetings book here when a host has no Google Calendar connected\./);
    assert.doesNotMatch(ok, /founder meetings are booked on it/, "true only while no host has connected a calendar");
    const notSet = render(
      createElement(ScheduleGlance, {
        meetings: null,
        partial: false,
        calendar: { ok: true, value: { personal: { connected: false, label: "Not connected", address: null }, workspace: { configured: false, address: null } } },
        connectHref: "/settings",
      }),
    );
    assert.match(notSet, /Workspace calendar · Not set up: a host without a connected calendar cannot be booked\./);
    assert.match(ok, /Your Google Calendar · Not connected Connect/);
    const failed = render(createElement(ScheduleGlance, { meetings: null, partial: false, calendar: { ok: false }, connectHref: "/settings" }));
    assert.match(failed, /Couldn.t check/);
    assert.doesNotMatch(failed, /Not connected/, "a failed check is not 'Not connected'");
  });

  // ── 9b. /analytics: "Not connected" only where it is true ─────────────────
  await check("/analytics: a workspace that could not be confirmed says 'Couldn't check', never 'Not connected'", async () => {
    const { analyticsMrrState, MRR_COPY } = await import("../app/analytics/mrr-state");
    const roles = await import("../lib/role-surfaces");
    const surface = (persona: "founder" | "worker", tenantSlug: string | null, degraded = false) => ({
      ok: true as const,
      degraded,
      tenantSlug,
      capabilities: roles.capabilitiesFor(persona, tenantSlug),
    });
    assert.equal(analyticsMrrState(surface("founder", "oasis-ai-cc")), "oasis");
    // A failed tenant lookup: resolveViewerSurface marks it degraded with no
    // slug, and capabilitiesFor drops company money for it.
    const degraded = surface("founder", null, true);
    assert.equal(degraded.capabilities.canSeeCompanyFinancials, false, "precondition: the degraded path loses money");
    assert.equal(analyticsMrrState(degraded), "unconfirmed");
    assert.equal(analyticsMrrState({ ok: false }), "unconfirmed");
    const said = Object.values(MRR_COPY.unconfirmed).join(" ");
    assert.match(said, /Couldn't check/);
    assert.doesNotMatch(said, /Not connected|none feeding/, "a failed read states no fact about the workspace");
    assert.equal(analyticsMrrState(surface("worker", "oasis-ai-cc")), "owner_only", "OASIS has a live source; it is not theirs to see");
    assert.equal(analyticsMrrState(surface("founder", "acme-roofing")), "not_connected", "only a confirmed non-OASIS workspace is 'Not connected'");
    const page = code("app/analytics/page.tsx");
    assert.match(page, /const mrrState = analyticsMrrState\(surface\);/);
    assert.match(page, /mrrState === "oasis" \? loadOasisMoney\(tenantId, "analytics"\) : Promise\.resolve\(null\)/);
    assert.match(page, /<Stat label="MRR \(Stripe\)" value=\{MRR_COPY\[noMoney\]\.value\} hint=\{MRR_COPY\[noMoney\]\.hint\} accent \/>/);
    assert.match(page, /<EmptyState message=\{MRR_COPY\[noMoney\]\.card\} \/>/);
    assert.doesNotMatch(page, /none feeding it|value="Not connected"/, "the page states no fact the state did not decide");
  });

  // ── 10. I/O against a local database, two workspaces ──────────────────────
  const { createClient } = await import("@libsql/client");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(`
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_key TEXT, name TEXT, description TEXT, schedule TEXT,
      enabled INTEGER, last_run_at TEXT, last_run_status TEXT, created_at TEXT);
    CREATE TABLE cron_jobs (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT, description TEXT, schedule TEXT, action_type TEXT,
      action_config TEXT, owner_agent_key TEXT, is_active INTEGER, last_run_at TEXT, last_result TEXT,
      next_run_at TEXT, run_count INTEGER, fail_count INTEGER, created_at TEXT);
    CREATE TABLE post_analytics (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, content_excerpt TEXT, published_at TEXT, last_synced_at TEXT);
  `);
  const t = Date.now();
  const at = (msAgo: number) => new Date(t - msAgo).toISOString();
  await raw.batch([
    { sql: "INSERT INTO tenant_cron_jobs VALUES ('a1', ?, 'atlas', 'Inbound Financial Email', '', '*/15 * * * *', 1, ?, 'success', '2026-09-01')", args: [TENANT_A, at(600_000)] },
    { sql: "INSERT INTO tenant_cron_jobs VALUES ('a2', ?, 'atlas', 'Monthly close', '', '0 9 1 * *', 0, NULL, NULL, '2026-09-01')", args: [TENANT_A] },
    { sql: "INSERT INTO tenant_cron_jobs VALUES ('b1', ?, 'x', 'B routine', '', '0 9 * * *', 1, ?, 'error', '2026-09-01')", args: [TENANT_B, at(60_000)] },
    // Empire rows: a JSON summary reporting its own errors is a failure (lib/cron-empire-row).
    { sql: "INSERT INTO cron_jobs VALUES ('e1', ?, 'Inbound Email Sweep', '', '*/5 * * * *', 'script_run', '{}', 'bravo', 1, ?, ?, NULL, 10, 0, '2026-09-01')", args: [TENANT_A, at(3_600_000), '{"errors": 3, "sent": 0}'] },
    { sql: "INSERT INTO cron_jobs VALUES ('e2', ?, 'Post Analytics Sync', '', '17 * * * *', 'script_run', '{}', 'maven', 1, ?, 'synced: 295 · failed: 0', NULL, 10, 0, '2026-09-01')", args: [TENANT_A, at(120_000)] },
    { sql: "INSERT INTO cron_jobs VALUES ('e3', ?, 'Parked', '', '0 * * * *', 'script_run', '{}', 'bravo', 0, NULL, NULL, NULL, 0, 0, '2026-09-01')", args: [TENANT_A] },
    { sql: "INSERT INTO cron_jobs VALUES ('e4', ?, 'B empire', '', '0 * * * *', 'script_run', '{}', 'bravo', 1, ?, 'ERROR boom', NULL, 1, 1, '2026-09-01')", args: [TENANT_B, at(60_000)] },
    // Stamped with A's workspace id but owned by an agent no department is
    // bound to (W2a, decision 17): it never counts on A's Today or tab.
    { sql: "INSERT INTO cron_jobs VALUES ('e5', ?, 'House errand', '', '0 * * * *', 'script_run', '{}', 'aura', 1, ?, 'ERROR unrelated', NULL, 4, 2, '2026-09-01')", args: [TENANT_A, at(60_000)] },
    { sql: "INSERT INTO post_analytics VALUES ('p1', ?, 'Twelve pieces', ?, '2026-09-29T20:22:00Z')", args: [TENANT_A, at(86_400_000)] },
    { sql: "INSERT INTO post_analytics VALUES ('p2', ?, 'Twelve pieces', ?, '2026-09-29T20:20:00Z')", args: [TENANT_A, at(86_400_000)] },
  ]);

  // The Connections tables in their real shape: the Marketing card asks
  // whether Zernio is connected, and the Operations tile counts the hub's own
  // statuses (bravo__187 + the live key-store DDL).
  await raw.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__187_os_connections.sql"), "utf8"));
  await raw.executeMultiple(`
    CREATE TABLE "tenant_integration_credentials" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "service" TEXT NOT NULL, "field_key" TEXT NOT NULL,
      "encrypted_value" TEXT NOT NULL, "last_tested_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
    CREATE TABLE integrations_health (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT, service TEXT,
      status TEXT, last_ping_at TEXT, metadata TEXT NOT NULL DEFAULT '{}');
  `);
  const connectionRow = (id: string, tenant: string, provider: string, status: string, verdict: string) => ({
    sql: `INSERT INTO tenant_connections (id, tenant_id, provider, auth_kind, status, last_health_at, last_health_verdict, created_at, updated_at)
          VALUES (?, ?, ?, 'api_key', ?, ?, ?, ?, ?)`,
    args: [id, tenant, provider, status, at(60_000), verdict, at(86_400_000), at(60_000)],
  });

  const loaders = await import("../components/os/today/loaders");
  await check("routines I/O: the workspace lane plus OASIS's Empire rows, and never another workspace's", async () => {
    const withEmpire = await loaders.loadRoutineHealth(TENANT_A, true, t);
    assert.ok(withEmpire.ok, "the read failed");
    if (withEmpire.ok) {
      assert.deepEqual(
        { total: withEmpire.value.total, on: withEmpire.value.on, failed: withEmpire.value.failed24h.map((r) => r.id) },
        { total: 5, on: 3, failed: ["e1"] },
        "{\"errors\": 3} is a failure; B's rows never appear",
      );
      assert.equal(withEmpire.value.lastSuccessAt, at(120_000), "the newest clean run across both lanes");
    }
    const workspaceOnly = await loaders.loadRoutineHealth(TENANT_A, false, t);
    assert.deepEqual(workspaceOnly.ok && { total: workspaceOnly.value.total, on: workspaceOnly.value.on }, { total: 2, on: 1 }, "no Empire rows unless asked");
    const b = await loaders.loadRoutineHealth(TENANT_B, false, t);
    assert.deepEqual(b.ok && b.value.failed24h.map((r) => r.id), ["b1"], "B sees its own failure and nothing of A's");
  });
  await check("content I/O: freshness comes from this workspace's post analytics only", async () => {
    const a = await loaders.loadContentWeek(TENANT_A);
    assert.deepEqual(
      a,
      { ok: true, value: { published: 1, lastSyncedAt: "2026-09-29T20:22:00Z", zernioConnected: null } },
      "posts that synced already name their source: nothing more is asked",
    );
    const b = await loaders.loadContentWeek(TENANT_B);
    assert.deepEqual(
      b,
      { ok: true, value: { published: 0, lastSyncedAt: null, zernioConnected: false } },
      "a workspace with nothing synced has no freshness, and no Zernio of its own",
    );
  });
  await check("content I/O (W2a, U2-13): Zernio is connected only by this workspace's own live zernio/late connection", async () => {
    const zernioOf = async (tenant: string) => {
      const r = await loaders.loadContentWeek(tenant);
      return r.ok ? r.value.zernioConnected : "failed";
    };
    await raw.batch([connectionRow("zc-a", TENANT_A, "zernio", "connected", "healthy")], "write");
    try {
      assert.equal(await zernioOf(TENANT_B), false, "another workspace's connection is not this one's");
      await raw.batch([connectionRow("zc-b", TENANT_B, "late", "pending", "unknown")], "write");
      assert.equal(await zernioOf(TENANT_B), true, "a live Late connection is Zernio");
      await raw.execute({ sql: "UPDATE tenant_connections SET revoked_at = ? WHERE id = 'zc-b'", args: [at(1_000)] });
      assert.equal(await zernioOf(TENANT_B), false, "a revoked connection is not a connection");
      // The check that could not run is not "not connected": the read fails.
      await raw.execute("ALTER TABLE tenant_connections RENAME TO tenant_connections_offline");
      try {
        assert.equal(await zernioOf(TENANT_B), "failed", "a failed connection read is 'Couldn't load', never 'Connect a social account'");
        assert.equal(await zernioOf(TENANT_A), null, "a workspace whose posts synced never asks");
      } finally {
        await raw.execute("ALTER TABLE tenant_connections_offline RENAME TO tenant_connections");
      }
    } finally {
      await raw.execute("DELETE FROM tenant_connections WHERE id IN ('zc-a', 'zc-b')");
    }
  });
  // W2a review (W2A-R4): the key check decrypted EVERY stored credential and
  // threw on any unreadable one, so another app's key (Twilio, Stripe) turned
  // the Marketing card into "Couldn't load".
  await check("content I/O (W2A-R4): only a Zernio/Late key answers 'is Zernio connected'; another app's unreadable key does not", async () => {
    const { encryptField } = await import("../lib/field-encryption");
    const zernioOf = async (tenant: string) => {
      const r = await loaders.loadContentWeek(tenant);
      return r.ok ? r.value.zernioConnected : "failed";
    };
    const keyRow = (id: string, service: string, field: string, value: string) => ({
      sql: "INSERT INTO tenant_integration_credentials (id, tenant_id, service, field_key, encrypted_value) VALUES (?, ?, ?, ?, ?)",
      args: [id, TENANT_B, service, field, value],
    });
    await raw.batch([keyRow("k-twilio", "twilio", "auth_token", "not-a-ciphertext")], "write");
    try {
      assert.equal(await zernioOf(TENANT_B), false, "a Twilio key nobody can read says nothing about Zernio");
      await raw.batch([keyRow("k-late", "late", "api_key", encryptField("late-test-key"))], "write");
      assert.equal(await zernioOf(TENANT_B), true, "a saved Late key is Zernio");
      await raw.execute("UPDATE tenant_integration_credentials SET encrypted_value = 'garbled' WHERE id = 'k-late'");
      assert.equal(await zernioOf(TENANT_B), "failed", "a Late key that will not decrypt is 'Couldn't load', never a guess");
    } finally {
      await raw.execute("DELETE FROM tenant_integration_credentials WHERE id IN ('k-twilio', 'k-late')");
    }
  });

  // Hot replies: lead_interactions does not exist yet, so the read FAILS.
  await check("inbound I/O: a failed lead_interactions read is 'Couldn't check', never 'no hot replies'", async () => {
    const { recentInbound } = await import("../lib/queries");
    await assert.rejects(recentInbound(TENANT_A), /lead_interactions read failed/);
    const hot = await loaders.loadHotReplies(TENANT_A, t);
    assert.deepEqual(hot, { ok: false });
    const list = model.buildNeedsYou({ sales: null, delivery: null, inbound: hot, cash: null, nowMs: t });
    assert.deepEqual(list.unavailable, ["inbound replies"]);
  });
  await check("inbound I/O: once readable, each workspace reads only its own inbound (control)", async () => {
    await raw.executeMultiple(`
      CREATE TABLE lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, type TEXT, subject TEXT, metadata TEXT, created_at TEXT);
    `);
    const hotMeta = JSON.stringify({ classification: { intent: "hot_lead" } });
    await raw.batch([
      { sql: "INSERT INTO lead_interactions VALUES ('i1', ?, NULL, 'email_received', 'Ready to sign', ?, ?)", args: [TENANT_A, hotMeta, at(3_600_000)] },
      { sql: "INSERT INTO lead_interactions VALUES ('i2', ?, NULL, 'email_received', 'B mail', ?, ?)", args: [TENANT_B, hotMeta, at(3_600_000)] },
    ]);
    const hot = await loaders.loadHotReplies(TENANT_A, t);
    assert.deepEqual(hot.ok && hot.value.map((r) => r.id), ["i1"]);
  });
  await check("inbound I/O (W2a): a hot reply answered on its own lead drops out; another workspace's send answers nothing", async () => {
    const hotMeta = JSON.stringify({ classification: { intent: "hot_lead" } });
    await raw.batch([
      // Answered: an email went out on its lead an hour after it arrived.
      { sql: "INSERT INTO lead_interactions VALUES ('i3', ?, 'lead-a3', 'email_reply', 'Answered', ?, ?)", args: [TENANT_A, hotMeta, at(3 * 3_600_000)] },
      { sql: "INSERT INTO lead_interactions VALUES ('o3', ?, 'lead-a3', 'email_sent', 'Re: Answered', NULL, ?)", args: [TENANT_A, at(2 * 3_600_000)] },
      // The only send on its lead is in ANOTHER workspace: not an answer here.
      { sql: "INSERT INTO lead_interactions VALUES ('i4', ?, 'lead-a4', 'email_reply', 'Still waiting', ?, ?)", args: [TENANT_A, hotMeta, at(2 * 3_600_000)] },
      { sql: "INSERT INTO lead_interactions VALUES ('o4', ?, 'lead-a4', 'email_sent', 'Elsewhere', NULL, ?)", args: [TENANT_B, at(3_600_000)] },
      // Queued is not sent.
      { sql: "INSERT INTO lead_interactions VALUES ('i5', ?, 'lead-a5', 'email_reply', 'Queued reply', ?, ?)", args: [TENANT_A, hotMeta, at(2.5 * 3_600_000)] },
      { sql: "INSERT INTO lead_interactions VALUES ('o5', ?, 'lead-a5', 'email_queued', 'Draft', NULL, ?)", args: [TENANT_A, at(3_600_000)] },
    ]);
    const hot = await loaders.loadHotReplies(TENANT_A, t);
    assert.deepEqual(hot.ok && hot.value.map((r) => r.id), ["i1", "i4", "i5"], "the answered reply is the only one gone");
  });

  // Calendar: user_integration_credentials does not exist yet, so the status
  // read FAILS; the send-path reader would have answered {} ("Not connected").
  await check("calendar I/O: a failed credential read is 'Couldn't check'; the old reader would have said 'Not connected'", async () => {
    const { getUserIntegrationBundle } = await import("../lib/user-integration-store");
    assert.deepEqual(await getUserIntegrationBundle(TENANT_A, "user-a", "gmail_oauth"), {}, "precondition: the swallowing reader hides the failure");
    assert.deepEqual(await loaders.loadCalendarStatus(TENANT_A, "user-a", true), { ok: false });
  });
  await check("calendar I/O: the workspace calendar is OASIS's alone; the personal login is read per viewer", async () => {
    // Your own Google account is read through lib/integrations/personal-google.ts,
    // which also reads your work email (a wrong account is "Wrong Google
    // account", never "Connected"): the profile table exists for this check only.
    await raw.executeMultiple(`
      CREATE TABLE user_integration_credentials (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, service TEXT, field_key TEXT, encrypted_value TEXT);
      CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT);
    `);
    try {
      assert.deepEqual(await loaders.loadCalendarStatus(TENANT_A, "user-a", true), {
        ok: true,
        value: { personal: { connected: false, label: "Not connected", address: null }, workspace: { configured: true, address: "bookings@oasis.test" } },
      });
      const client = await loaders.loadCalendarStatus(TENANT_B, "user-b", false);
      assert.deepEqual(client.ok && client.value.workspace, null, "a client workspace never sees OASIS's calendar identity");
    } finally {
      await raw.execute("DROP TABLE user_profiles");
    }
  });

  // The department tabs read the same rows the same way as Today's cards.
  const delivery = readFileSync(join(ROOT, "database/turso/183_delivery_and_support.turso.sql"), "utf8");
  const deliveryTables = delivery.match(
    /CREATE TABLE IF NOT EXISTS (?:delivery_projects|delivery_tasks|delivery_updates|support_tickets|ticket_comments) \([\s\S]*?\n\);/g,
  );
  assert.equal(deliveryTables?.length, 5, "the five delivery tables are in migration 183");
  await raw.executeMultiple(deliveryTables!.join("\n"));
  await raw.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__188_os_customers.sql"), "utf8"));
  await raw.executeMultiple(`CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);`);
  const TENANT_C = "tenant-c-used-desk";
  await raw.execute({
    sql: `INSERT INTO support_tickets (id, tenant_id, ticket_seq, ticket_number, title, status, sla_target) VALUES ('c-1', ?, 1, 'T-0001', 'Old', 'closed', ?)`,
    args: [TENANT_C, at(9 * 86_400_000)],
  });
  const { capabilitiesFor, isOasisSurfaceTenant } = await import("../lib/role-surfaces");
  const { resolveOsModules } = await import("../lib/os/modules");
  const numbersMod = await import("../components/os/department/numbers");
  const { loadTenantRoutines } = await import("../components/os/department/routines");
  const { OS_DEPARTMENTS: DEPTS } = await import("../lib/os/departments");
  // The session as components/os/department/viewer.ts shapes it, rail input included.
  const osViewer = (tenantId: string, oasis: boolean, who: { persona?: "founder" | "worker"; email?: string | null; authUserId?: string } = {}) => {
    const persona = who.persona ?? "founder";
    const tenantSlug = oasis ? "oasis-ai-cc" : "acme-roofing";
    const capabilities = capabilitiesFor(persona, tenantSlug);
    return {
      ok: true,
      surface: {
        ok: true,
        persona,
        capabilities,
        userId: `${persona}-${tenantId}`,
        tenantId,
        tenantSlug,
        teamRole: persona === "founder" ? "owner" : "member",
        degraded: false,
      },
      navInput: {
        persona,
        capabilities,
        isOperator: false,
        tenantSlug,
        isOasisTenant: isOasisSurfaceTenant(tenantSlug),
        modules: resolveOsModules({ tenantSlug, provisioned: true }),
        provisioned: true,
        founders: null,
      },
      oasis,
      provisioned: true,
      manifest: {},
      email: who.email ?? null,
      authUserId: who.authUserId ?? `${persona}-${tenantId}`,
    } as unknown as Parameters<typeof numbersMod.loadDepartmentNumbers>[1];
  };
  const deptOf = (key: string) => DEPTS.find((d) => d.key === key)!;
  const tile = (tiles: Array<{ label: string; status: string; value: unknown; emptyText?: string }>, label: string) =>
    tiles.find((x) => x.label === label);

  await check("Client Success tab I/O: a desk with no ticket ever says 'No tickets yet' on every ticket tile", async () => {
    const b = await numbersMod.loadDepartmentNumbers(deptOf("client_success"), osViewer(TENANT_B, false), { ok: true, value: [] });
    for (const label of ["Open tickets", "SLA breached", "At risk"]) {
      assert.deepEqual([tile(b.tiles, label)?.status, tile(b.tiles, label)?.emptyText], ["no_data", "No tickets yet"], label);
    }
    const c = await numbersMod.loadDepartmentNumbers(deptOf("client_success"), osViewer(TENANT_C, false), { ok: true, value: [] });
    assert.deepEqual([tile(c.tiles, "SLA breached")?.status, tile(c.tiles, "SLA breached")?.value], ["live", "0"], "a desk with history has a real 0");
    const todayB = await loaders.loadDelivery({ persona: "founder", tenantId: TENANT_B, userId: "owner-b", canAct: true, day: { nowMs: t, startMs: t - 1, endMs: t + 1, todayKey: "2026-09-29" } });
    const todayC = await loaders.loadDelivery({ persona: "founder", tenantId: TENANT_C, userId: "owner-c", canAct: true, day: { nowMs: t, startMs: t - 1, endMs: t + 1, todayKey: "2026-09-29" } });
    assert.deepEqual([todayB.ok && todayB.value.ticketHistory, todayC.ok && todayC.value.ticketHistory], [false, true], "Today's card reads the same history");
  });
  // The platform operator: an operator alias AND an owner row in the OASIS
  // workspace, read by auth user id (lib/platform-operator.ts).
  const { OASIS_OPERATOR_TENANT_ID } = await import("../lib/platform-operator");
  await raw.executeMultiple(`
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT, team_role TEXT, is_owner INTEGER,
      admin_access INTEGER, onboarding_completed_at TEXT, updated_at TEXT, deactivated_at TEXT);
  `);
  await raw.execute({
    sql: "INSERT INTO user_profiles VALUES ('p-cc', 'auth-cc', 'conaugh@oasisai.work', ?, 'owner', 1, 0, '2026-01-01', '2026-09-01', NULL)",
    args: [OASIS_OPERATOR_TENANT_ID],
  });
  const operatorViewer = () => osViewer(TENANT_A, true, { email: "conaugh@oasisai.work", authUserId: "auth-cc" });
  // The co-owner: an owner of the OASIS workspace, not the platform operator.
  const coOwnerViewer = () => osViewer(TENANT_A, true, { email: "adon@oasis.test", authUserId: "auth-adon" });

  await check("Operations tab I/O: Empire rows count only for the platform operator, and their failure links to Automations", async () => {
    const a = await numbersMod.loadDepartmentNumbers(deptOf("operations"), operatorViewer(), await loadTenantRoutines(TENANT_A));
    assert.deepEqual([tile(a.tiles, "Routines on")?.value, tile(a.tiles, "Failed in 24h")?.value], ["3 of 5", "1"]);
    const today = await loaders.loadRoutineHealth(TENANT_A, true, Date.now());
    assert.ok(today.ok && today.value.on === 3 && today.value.total === 5 && today.value.failed24h.length === 1, "Today's card counts the same rows");
    assert.deepEqual(
      a.attention.map((x) => [x.id, x.href]),
      [["routines-failed", "/automations"]],
      "the panel below lists tenant_cron_jobs only: an Empire failure is seen in Automations",
    );
    // The co-owner has no page that lists the Empire lane, so it is not counted for them.
    const coOwner = await numbersMod.loadDepartmentNumbers(deptOf("operations"), coOwnerViewer(), await loadTenantRoutines(TENANT_A));
    assert.deepEqual([tile(coOwner.tiles, "Routines on")?.value, tile(coOwner.tiles, "Failed in 24h")?.value], ["1 of 2", "0"]);
    assert.deepEqual(coOwner.attention, [], "never a failure they cannot look up");
    // Today's rule is the same function (brief-load.ts empireRoutinesFor).
    const { empireRoutinesFor } = await import("../components/os/today/brief-load");
    let asked = 0;
    const ask = (answer: boolean) => async () => {
      asked += 1;
      return answer;
    };
    assert.equal(await empireRoutinesFor({ persona: "founder", tenantSlug: "acme-roofing" }, ask(true)), false, "never outside OASIS");
    assert.equal(await empireRoutinesFor({ persona: "legacy", tenantSlug: "oasis-ai-cc" }, ask(true)), false, "never below owner");
    assert.equal(asked, 0, "the operator lookup is not even made for them");
    assert.equal(await empireRoutinesFor({ persona: "founder", tenantSlug: "oasis-ai-cc" }, ask(false)), false, "an OASIS owner who is not the operator");
    assert.equal(await empireRoutinesFor({ persona: "founder", tenantSlug: "oasis-ai-cc" }, ask(true)), true);
    const failing = async (): Promise<boolean> => {
      throw new Error("profile read failed");
    };
    assert.equal(await empireRoutinesFor({ persona: "founder", tenantSlug: "oasis-ai-cc" }, failing), "unknown", "a failed check is unknown, never a rejection and never 'no'");
    const b = await numbersMod.loadDepartmentNumbers(deptOf("operations"), osViewer(TENANT_B, false), await loadTenantRoutines(TENANT_B));
    assert.deepEqual([tile(b.tiles, "Routines on")?.value, tile(b.tiles, "Failed in 24h")?.value], ["1 of 1", "1"], "a client workspace: its own lane only");
    const none = await numbersMod.loadDepartmentNumbers(deptOf("operations"), osViewer(TENANT_C, false), await loadTenantRoutines(TENANT_C));
    assert.deepEqual([tile(none.tiles, "Routines on")?.status, tile(none.tiles, "Failed in 24h")?.status], ["no_data", "no_data"], "no routine set up is not '0 failed'");
  });
  // A's shared Google mailbox passed its Test a minute ago (2026-10-08: a
  // card is proven by its own Test, never by a heartbeat).
  const gwsPassedRows = async (tenant: string) => {
    const { encryptField } = await import("../lib/field-encryption");
    return ["app_password", "from_address"].map((field) => ({
      sql: "INSERT INTO tenant_integration_credentials (id, tenant_id, service, field_key, encrypted_value, last_tested_at, last_test_ok) VALUES (?, ?, 'gws', ?, ?, ?, 1)",
      args: [`gws-${tenant}-${field}`, tenant, field, encryptField(field === "from_address" ? "team@a.test" : "abcdabcdabcdabcd"), at(60_000)],
    }));
  };
  await check("Operations tab I/O (W2a): the connection tile counts the hub's own statuses, never 'not measured'", async () => {
    // A's Google mailbox passed its Test a minute ago; Stripe refused A's key.
    await raw.batch([...(await gwsPassedRows(TENANT_A)), connectionRow("st-a", TENANT_A, "stripe", "expired", "down")], "write");
    try {
      const connTile = (tiles: Parameters<typeof tile>[0]) =>
        tile(tiles, "Connections needing attention") as { status: string; value: unknown; hint?: string; emptyText?: string } | undefined;
      const a = connTile((await numbersMod.loadDepartmentNumbers(deptOf("operations"), operatorViewer(), await loadTenantRoutines(TENANT_A))).tiles);
      assert.deepEqual([a?.status, a?.value, a?.hint], ["live", "1", "Of 2 apps set up"], "Stripe needs the owner; Google is proven");
      const b = connTile((await numbersMod.loadDepartmentNumbers(deptOf("operations"), osViewer(TENANT_B, false), await loadTenantRoutines(TENANT_B))).tiles);
      assert.deepEqual([b?.status, b?.emptyText], ["no_data", "No apps connected yet"], "nothing set up is words, never 0");
      assert.doesNotMatch(JSON.stringify([a, b]), /not measured/i);
    } finally {
      await raw.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE tenant_id = ?", args: [TENANT_A] });
      await raw.execute("DELETE FROM tenant_connections WHERE id = 'st-a'");
    }
  });
  // W2a review (W2A-R5): the tile dropped the old tile's link to the hub, and
  // it counted the viewer's own Google link, so two people in one workspace
  // could read two different workspace numbers.
  await check("Operations tab I/O (W2A-R5): an owner gets the link to fix a non-zero count; the count is the workspace's, whoever looks", async () => {
    await raw.batch([...(await gwsPassedRows(TENANT_A)), connectionRow("st-a", TENANT_A, "stripe", "expired", "down")], "write");
    // The personal-link read needs the table's real columns; B's owner links their own Google.
    await raw.executeMultiple(`
      ALTER TABLE user_integration_credentials ADD COLUMN last_tested_at TEXT;
      ALTER TABLE user_integration_credentials ADD COLUMN last_test_ok INTEGER;
      ALTER TABLE user_integration_credentials ADD COLUMN last_test_error TEXT;
      ALTER TABLE user_integration_credentials ADD COLUMN updated_at TEXT;
    `);
    await raw.execute({
      sql: "INSERT INTO user_integration_credentials (id, tenant_id, user_id, service, field_key, encrypted_value) VALUES ('g-b', ?, ?, 'gmail_oauth', 'refresh_token', 'stored')",
      args: [TENANT_B, osViewer(TENANT_B, false).surface.userId],
    });
    try {
      type ConnTile = { status: string; value: unknown; hint?: string; emptyText?: string; action?: { label: string; href: string } };
      const connTile = async (viewer: ReturnType<typeof osViewer>, tenant: string) =>
        tile((await numbersMod.loadDepartmentNumbers(deptOf("operations"), viewer, await loadTenantRoutines(tenant))).tiles, "Connections needing attention") as
          | ConnTile
          | undefined;
      const owner = await connTile(operatorViewer(), TENANT_A);
      assert.deepEqual([owner?.value, owner?.action], ["1", { label: "Open Connections", href: "/settings/connections" }], "the owner can fix it from the tile");
      const worker = await connTile(osViewer(TENANT_A, true, { persona: "worker" }), TENANT_A);
      assert.deepEqual([worker?.value, worker?.action], ["1", undefined], "the same number; only an owner or admin manages connections");
      const { KpiTile } = await import("../components/os/KpiTile");
      assert.match(render(createElement(KpiTile, owner as never)), /Connections needing attention 1 Of 2 apps set up Open Connections/);
      // B's owner has their own Google linked; B has set up nothing. The hub
      // card reports that account beside the workspace's state, which stays
      // "No shared mailbox": the workspace has no app set up.
      const b = await connTile(osViewer(TENANT_B, false), TENANT_B);
      assert.deepEqual([b?.status, b?.emptyText, b?.action], ["no_data", "No apps connected yet", undefined], "a personal link is not the workspace's app");
    } finally {
      await raw.execute({ sql: "DELETE FROM tenant_integration_credentials WHERE tenant_id = ?", args: [TENANT_A] });
      await raw.execute("DELETE FROM tenant_connections WHERE id = 'st-a'");
      await raw.execute("DELETE FROM user_integration_credentials WHERE id = 'g-b'");
    }
  });
  // Verify-fix (2026-09-29): a failed operator lookup answered "not the
  // operator", so CC's Empire failures vanished behind a clean workspace lane.
  await check("Operations + Needs you I/O: a FAILED operator lookup is 'Couldn't check', never the workspace lane alone", async () => {
    const { resolvePlatformOperatorForAuthUser } = await import("../lib/platform-operator");
    const { empireRoutinesFor, empireLaneFromCheck } = await import("../components/os/today/brief-load");
    const oasisOwner = { persona: "founder" as const, tenantSlug: "oasis-ai-cc" };
    const lane = async (authUserId: string, email: string) =>
      empireRoutinesFor(oasisOwner, async () => empireLaneFromCheck(await resolvePlatformOperatorForAuthUser(authUserId, email)));
    assert.equal(await lane("auth-cc", "conaugh@oasisai.work"), true, "control: the lookup answers, the operator gets the Empire lane");
    // The profile read behind the verified check fails for the length of this check.
    await raw.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
    try {
      assert.deepEqual(
        await resolvePlatformOperatorForAuthUser("auth-cc", "conaugh@oasisai.work"),
        { operator: false, reason: "lookup_failed" },
        "precondition: the lookup itself failed",
      );
      assert.equal(await lane("auth-cc", "conaugh@oasisai.work"), "unknown", "a failed lookup is unknown, not 'not the operator'");
      assert.equal(await lane("auth-adon", "adon@oasis.test"), false, "a true non-operator is still a plain no (no lookup needed)");
      // Operations tab: the operator's tiles say the read failed.
      const ops = await numbersMod.loadDepartmentNumbers(deptOf("operations"), operatorViewer(), await loadTenantRoutines(TENANT_A));
      assert.deepEqual(
        [tile(ops.tiles, "Routines on")?.status, tile(ops.tiles, "Failed in 24h")?.status],
        ["error", "error"],
        "never '1 of 2 on, 0 failed' from the workspace lane alone",
      );
      assert.deepEqual(ops.attention, []);
      // Chief of Staff (Today's reads): the routines source is named as unread and the total is a floor.
      const cos = await numbersMod.loadDepartmentNumbers(deptOf("chief_of_staff"), operatorViewer(), await loadTenantRoutines(TENANT_A));
      assert.equal(tile(cos.tiles, "Routines on")?.status, "error");
      assert.equal(cos.needsYou?.capped, true, "the total is at least, not exact");
      // Today's card and Needs you, from the same loader.
      const today = await loaders.loadRoutineHealth(TENANT_A, "unknown", Date.now());
      assert.equal(today.ok, false, "Today's Operations card: Couldn't load");
      const list = model.buildNeedsYou({ sales: null, delivery: null, inbound: null, cash: null, routines: today, nowMs: now });
      assert.deepEqual([list.unavailable, model.needsYouTotal(list)], [["routine runs"], { total: 0, capped: true }]);
      // A true non-operator keeps their workspace lane as a real answer, even now.
      const coOwner = await numbersMod.loadDepartmentNumbers(deptOf("operations"), coOwnerViewer(), await loadTenantRoutines(TENANT_A));
      assert.deepEqual([tile(coOwner.tiles, "Routines on")?.value, tile(coOwner.tiles, "Failed in 24h")?.value], ["1 of 2", "0"]);
    } finally {
      await raw.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");
    }
  });
  await check("Chief of Staff tab I/O: a worker in a client workspace is never handed OASIS's missed SLA", async () => {
    // One open request TENANT_B filed on OASIS's desk from its own session, past
    // its first-response target.
    const { DELIVERY_TENANT_ID } = await import("../lib/delivery/rules");
    await raw.execute({
      sql: `INSERT INTO support_tickets (id, tenant_id, ticket_seq, ticket_number, title, status, severity, client_tenant_id, client_match, sla_target, created_at)
            VALUES ('o-1', ?, 1, 'T-0001', 'Site down', 'open', 'critical', ?, 'session', ?, ?)`,
      args: [DELIVERY_TENANT_ID, TENANT_B, at(3_600_000), at(7_200_000)],
    });
    const worker = await numbersMod.loadDepartmentNumbers(deptOf("chief_of_staff"), osViewer(TENANT_B, false, { persona: "worker" }), await loadTenantRoutines(TENANT_B));
    assert.equal(tile(worker.tiles, "Open requests")?.value, "1", "precondition: the worker reads OASIS's desk as its client");
    assert.deepEqual(worker.attention.filter((x) => x.id.startsWith("sla-")), [], "a vendor's miss is not the client's task");
    assert.equal(worker.needsYou?.total, 0, "and it is not in their Needs you count");
    // The team that owes the reply is still told, on the same tab (control).
    const team = await numbersMod.loadDepartmentNumbers(deptOf("chief_of_staff"), osViewer(DELIVERY_TENANT_ID, true), await loadTenantRoutines(DELIVERY_TENANT_ID));
    assert.deepEqual(team.attention.filter((x) => x.id.startsWith("sla-")).map((x) => x.id), ["sla-breached"]);
  });

  // Finances: overview().coverage per book, with a real ledger.
  await raw.executeMultiple(readFileSync(join(ROOT, "database/turso/180_founders_finances.turso.sql"), "utf8"));
  // Stripe ingest writes the Business Ledger in its own batches (bravo__190); the books read Stripe payouts and the payout account (bravo__193).
  await raw.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__190_ledger_core.sql"), "utf8"));
  await raw.executeMultiple(readFileSync(join(ROOT, "database/turso/bravo__193_stripe_payouts.sql"), "utf8"));
  const { ensureFinanceSeed } = await import("../lib/founders-finances/seed-io");
  const ledgerIo = await import("../lib/founders-finances/ledger-io");
  const reportsIo = await import("../lib/founders-finances/reports-io");
  const txns = await import("../lib/founders-finances/transactions-io");
  const { accountId, categoryId, SYS, BUSINESS_ENTITY_ID: B } = await import("../lib/founders-finances/chart");
  const cc = { kind: "founder" as const, ownerKey: "cc" as const, email: "conaugh@oasisai.work", userId: "u-cc" };
  await ensureFinanceSeed();
  const post = (ref: string, date: string, source: string, lines: Array<[string, number, number]>) =>
    ledgerIo.postJournalEntry({
      entityId: B,
      entryDate: date,
      memo: ref,
      source,
      sourceRef: ref,
      createdBy: "test",
      lines: lines.map(([code, d, c]) => ({ accountId: accountId(B, code), currency: "CAD", ...(d ? { debitCents: d } : { creditCents: c }) })),
    });
  await check("overview I/O: the business book's coverage, scoped to its own bank lines", async () => {
    await post("rent", "2026-09-02", "expense", [["5650", 269513, 0], [SYS.chequing, 0, 269513]]);
    await post("charge", "2026-09-05", "stripe_charge", [[SYS.stripeClearing, 20000, 0], [SYS.subscriptionRevenue, 0, 20000]]);
    await post("fee", "2026-09-05", "stripe_fee", [[SYS.stripeFees, 610, 0], [SYS.stripeClearing, 0, 610]]);
    // A bank line in CC's PERSONAL book must not count as the business's bank feed.
    await txns.createManualTransaction(cc, "cc-personal", { date: "2026-09-10", description: "Groceries", amount: "-82.40", category_id: categoryId("fin_ent_cc", "5100"), account_id: accountId("fin_ent_cc", "1000") });
    const ov = await reportsIo.overview(cc, "oasis", { sweep: "deferred" });
    assert.equal(ov.cashTotal, -269513 + 19390, "cashTotal itself is unchanged: presentation only");
    assert.deepEqual(ov.coverage.gaps, [NO_OPENING_OFF, "Stripe payouts to the bank are not recorded"]);
    assert.equal(ov.coverage.bankLines, 0, "the personal book's bank line is not the business's");
    const personal = await reportsIo.overview(cc, "cc-personal", { sweep: "deferred" });
    assert.equal(personal.coverage.bankLines, 1);
    assert.equal(personal.unreviewed + ov.unreviewed, personal.unreviewed, "unreviewed stays per book");
  });
  // The CFO agent's summary carries the same verdict, so an agent never
  // reports the ledger sum as a balance either.
  process.env.FINANCE_AGENT_TOKEN = "atlas-test-token-0123456789abcdef";
  const summaryRoute = await import("../app/api/internal/finance/summary/route");
  const agentSummary = async () => {
    const res = await summaryRoute.GET(
      new Request("http://localhost/api/internal/finance/summary", { headers: { authorization: `Bearer ${process.env.FINANCE_AGENT_TOKEN}` } }),
    );
    assert.equal(res.status, 200, `summary failed: ${await res.clone().text()}`);
    return (await res.json()) as { cash_total_cad_cents: number; cash_coverage?: { complete: boolean; gaps: string[] } };
  };
  await check("summary I/O: the agent's cash total comes with cash_coverage, so it is never read as a balance", async () => {
    const body = await agentSummary();
    assert.equal(body.cash_total_cad_cents, -269513 + 19390);
    assert.deepEqual(body.cash_coverage, { complete: false, gaps: [NO_OPENING_OFF, "Stripe payouts to the bank are not recorded"] });
  });
  let openingId = "";
  await check("overview I/O: an opening balance and a booked payout make the business book complete", async () => {
    openingId = (await post("opening", "2026-08-31", "opening_balance", [[SYS.chequing, 500000, 0], [SYS.retained, 0, 500000]])).entryId;
    await post("payout", "2026-09-08", "bank_import", [[SYS.chequing, 19390, 0], [SYS.stripeClearing, 0, 19390]]);
    const ov = await reportsIo.overview(cc, "oasis", { sweep: "deferred" });
    assert.deepEqual([ov.coverage.complete, ov.coverage.gaps], [true, []]);
    assert.deepEqual((await agentSummary()).cash_coverage, { complete: true, gaps: [] });
  });
  await check("overview I/O: reversing the opening balance (as the Wise card does) makes the books incomplete again", async () => {
    const rev = await ledgerIo.buildReversal({ entityId: B, entryId: openingId, date: "2026-08-31", memo: "Opening balance removed", createdBy: "test" });
    await raw.batch(rev.statements);
    const ov = await reportsIo.overview(cc, "oasis", { sweep: "deferred" });
    assert.deepEqual([ov.coverage.complete, ov.coverage.gaps], [false, [NO_OPENING_OFF]], "a reversed opening balance is not a starting point");
  });

  if (failures > 0) {
    console.log(`os-honest-numbers: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("os-honest-numbers: OK — no data is not 0, cash is not a ledger gap, one Needs-you count, every source named");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
