/**
 * OASIS OS Today — the owner's morning brief (components/os/today).
 *
 * WHY THIS EXISTS. Today is the page every persona opens first, and it is the
 * one that used to render company revenue to a commission-only contractor
 * (lib/role-surfaces.ts header, 2026-08-19). The brief now adds more money to
 * that page — goal pace, cash, overdue invoices — so two properties have to be
 * pinned, not trusted:
 *
 *   1. MONEY IS NOT FETCHED for a viewer without the capability. Not "fetched
 *      and hidden": the plan refuses the block and the loader is never called,
 *      so nothing reaches the RSC payload. Checked on the plan for every
 *      persona in and out of OASIS, and on the source of the only file that
 *      calls the money readers.
 *   2. UNKNOWN IS NOT ZERO. A disconnected source renders "Not connected" with a
 *      Connect link, a failed read renders "Couldn't load", and neither can
 *      print $0 or CA$0. A real zero from a live source still prints 0.
 *
 * It also pins the builders' arithmetic (overdue follow-ups, meetings, SLA,
 * hot replies, goal pace) against hand-made rows, and that the brief's own
 * files keep prefetch off and carry no gradient/glow/perpetual animation.
 *
 * Renders the presentational components by walking their element trees (no
 * react-dom: it refuses to load under react-server), with next/link stubbed to
 * a plain anchor, the same technique as tests/delivery-pages.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/os-today.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createElement, isValidElement, type ReactNode } from "react";
import { SURFACE_CAPABILITIES, capabilitiesFor, type Persona } from "../lib/role-surfaces";
import { OS_DEPARTMENTS } from "../lib/os/departments";
import { resolveOsModules } from "../lib/os/modules";
import { mayOpenOsHref, type BuildOsNavInput } from "../lib/os/nav";
import type { DepartmentKey } from "../lib/os/types";
import {
  buildDepartmentCards,
  buildNeedsYou,
  cashView,
  goalPaceView,
  meetingsBetween,
  pickHotReplies,
  salesBuckets,
  summarizeBoard,
  summarizeDelivery,
  todayBriefPlan,
  type CashSnapshot,
  type DeliverySnapshot,
  type GoalPaceView,
  type Read,
  type SalesSnapshot,
} from "../components/os/today/model";
import { askPrefillHref, ASK_PREFILL_PARAM } from "../components/os/today/ask";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Code only: a comment that NAMES a reader it deliberately does not call is not a call. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

// tsconfig.json keeps jsx:"preserve" for Next, so tsx compiles the components
// with the classic runtime, which expects a global React.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

// next/link loads the browser router context, which does not exist under
// react-server. The brief only needs it as an anchor.
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

// next/navigation builds React contexts at import time, which react-server
// does not have. Only the Ask composer (a client component) touches it, and the
// walker below never runs a client component's hooks, so throwing stubs do.
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
  exports: { __esModule: true, useRouter: hookOnly, usePathname: hookOnly, useSearchParams: hookOnly },
} as unknown as NodeModule;

/** Every string reachable in an element tree. Client components (hooks) fall back to their props. */
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
      try {
        const rendered = (node.type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) {
          textOf(rendered, out, depth + 1);
          return out;
        }
      } catch {
        /* a client component: its props are what would ship */
      }
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") textOf(v as ReactNode, out, depth + 1);
      // Styling and wiring are not text: a class like `min-w-0` is not a zero.
      else if (typeof v === "string" && !NOT_TEXT.has(k)) out.push(v);
    }
    return out;
  }
  return out;
}
const NOT_TEXT = new Set(["className", "id", "role", "style", "key", "href"]);
const render = (el: unknown) => textOf(el).join(" ").replace(/\s+/g, " ");
/** $0, CA$0, US$0, $0.00 — a zero amount of money, however formatted. */
const ZERO_MONEY = /(?:CA|US)?\$0(?:\.00)?(?![\d,.])/;

async function main() {
  const PERSONAS = Object.keys(SURFACE_CAPABILITIES) as Persona[];
  const OASIS = "oasis-ai-cc";
  const CLIENT = "acme-roofing";

  const departmentsFor = (persona: Persona, slug: string): Set<DepartmentKey> => {
    const input: BuildOsNavInput = {
      persona,
      capabilities: capabilitiesFor(persona, slug),
      isOperator: false,
      tenantSlug: slug,
      isOasisTenant: slug === OASIS,
      modules: resolveOsModules({ tenantSlug: slug, provisioned: true }),
      provisioned: true,
      founders: null,
    };
    return new Set(OS_DEPARTMENTS.filter((d) => mayOpenOsHref(input, d.href)).map((d) => d.key));
  };
  const planFor = (persona: Persona, slug: string) =>
    todayBriefPlan({
      persona,
      capabilities: capabilitiesFor(persona, slug),
      websiteSalesBoard: slug === OASIS,
      departments: departmentsFor(persona, slug),
    });

  // ── 1. The plan: money only for an owner standing in OASIS ────────────────
  for (const persona of PERSONAS) {
    for (const slug of [OASIS, CLIENT, ""]) {
      const plan = planFor(persona, slug);
      const owner = persona === "founder" && slug === OASIS;
      assert.equal(plan.money, owner, `${persona}@${slug || "unknown"}: money plan must be ${owner}`);
      assert.equal(plan.cash, owner, `${persona}@${slug || "unknown"}: cash plan must be ${owner}`);
    }
  }
  // Deliberately wrong input: capabilities that claim company money for a rep.
  // The plan still refuses, because money is an owner's block.
  const forged = todayBriefPlan({
    persona: "sales",
    capabilities: { ...SURFACE_CAPABILITIES.founder },
    websiteSalesBoard: true,
    departments: new Set<DepartmentKey>(["finance", "client_success"]),
  });
  assert.equal(forged.money, false, "a rep handed founder capabilities still gets no money block");
  // The legacy persona inherits the founder money flag; Today must not.
  assert.equal(
    todayBriefPlan({
      persona: "legacy",
      capabilities: { ...SURFACE_CAPABILITIES.legacy, canSeeCompanyFinancials: true },
      websiteSalesBoard: true,
      departments: departmentsFor("legacy", OASIS),
    }).money,
    false,
    "legacy never reads OASIS money on Today",
  );
  // Delivery needs the capability AND the department.
  assert.equal(planFor("founder", OASIS).delivery, true, "an OASIS owner reads the support queue");
  assert.equal(
    todayBriefPlan({
      persona: "founder",
      capabilities: capabilitiesFor("founder", OASIS),
      websiteSalesBoard: true,
      departments: new Set<DepartmentKey>(),
    }).delivery,
    false,
    "no Client Success department on the rail → no delivery read",
  );
  assert.equal(planFor("founder", OASIS).pipeline, "board", "OASIS reads the /pipeline board query");
  assert.equal(planFor("founder", CLIENT).pipeline, "records", "a client workspace reads its own lead records");
  assert.equal(planFor("founder", CLIENT).money, false, "a client owner never reads OASIS money");

  // ── 2. Source: the money readers are called behind the gate, and only here ─
  // The Needs-you reads (pipeline, support, inbound, cash, approvals,
  // connections, routines) moved to components/os/today/brief-load.ts so the
  // Chief of Staff tab makes the SAME reads (one Needs-you model). The gate
  // moved with them: FounderToday narrows showFinancials by the plan and hands
  // it in, and brief-load reads cash only behind it.
  const founder = code("components/today/FounderToday.tsx");
  const brief = code("components/os/today/brief-load.ts");
  assert.match(founder, /const showFinancials = financialsAllowed && plan\.money;/, "the dispatcher's flag is narrowed by the plan");
  assert.match(founder, /showFinancials \? await loadOasisMoney\(tenantId, "today"\) : null/, "money read only behind showFinancials");
  assert.match(founder, /loadNeedsYouReads\(\{ viewer, navInput, plan, showFinancials,/, "the shared reads get the narrowed flag, never the raw capability");
  assert.match(brief, /input\.showFinancials && plan\.cash \? loadCash\(\) : Promise\.resolve\(null\)/, "cash read only behind the money gate");
  assert.equal((founder.match(/loadOasisMoney\(/g) || []).length, 1, "one money read");
  assert.equal((founder.match(/loadCash\(/g) || []).length, 0, "FounderToday reads cash only through brief-load");
  assert.equal((brief.match(/loadCash\(/g) || []).length, 1, "one cash read");
  assert.equal((brief.match(/loadOasisMoney\(/g) || []).length, 0, "the shared Needs-you reads never touch the revenue goal");
  for (const [src, file, flag, loader] of [
    [brief, "brief-load.ts", "plan.pipeline", "loadSales"],
    [brief, "brief-load.ts", "plan.delivery", "loadDelivery"],
    [brief, "brief-load.ts", "plan.inbound", "loadHotReplies"],
    [brief, "brief-load.ts", "plan.connections", "loadConnectionAlerts"],
    [brief, "brief-load.ts", "plan.routines", "loadRoutineHealth"],
    [founder, "FounderToday.tsx", "plan.content", "loadContentWeek"],
  ] as const) {
    assert.match(src, new RegExp(`${flag.replace(".", "\\.")}\\s*\\?\\s*${loader}\\(`), `${file}: ${loader} runs only behind ${flag}`);
    assert.equal((src.match(new RegExp(`${loader}\\(`, "g")) || []).length, 1, `${file}: ${loader} is called once`);
  }
  const dispatcher = code("app/page.tsx");
  assert.match(dispatcher, /showFinancials=\{surface\.capabilities\.canSeeCompanyFinancials\}/);

  const MONEY_READERS = [
    "loadOasisMoney",
    "oasis-money",
    "founders-finances",
    "loadCash",
    "components/os/today/loaders",
    "components/os/today/brief-load",
    "GoalCountdownCard",
    "TodayBrief",
  ];
  for (const file of [
    "app/page.tsx",
    "components/today/RepToday.tsx",
    "components/today/ManagerToday.tsx",
    "components/today/MarketingToday.tsx",
    "components/today/DeliveryToday.tsx",
  ]) {
    const src = code(file);
    assert.ok(src.length > 1000, `${file} did not load — the scan below proves nothing`);
    for (const reader of MONEY_READERS) {
      assert.equal(src.includes(reader), false, `${file} names ${reader}: the owner's money can run on this path`);
    }
  }

  // The brief's presentational files read nothing: every value is handed in.
  const todayDir = join(ROOT, "components", "os", "today");
  const briefFiles = readdirSync(todayDir).filter((f) => f.endsWith(".tsx"));
  assert.ok(briefFiles.length >= 8, `expected the brief's components, found ${briefFiles.join(", ")}`);
  for (const name of briefFiles) {
    const src = code(`components/os/today/${name}`);
    for (const reader of ["/loaders", "@/lib/queries", "oasis-money", "reports-io", "supabase", "turso", "getServiceSupabase"]) {
      assert.equal(src.includes(reader), false, `components/os/today/${name} imports ${reader} — presentational files never read`);
    }
    // Rail discipline: every in-view link keeps prefetch off (tests/os-nav.test.ts §11).
    const links = (src.match(/<Link\s/g) || []).length;
    const off = (src.match(/prefetch=\{false\}/g) || []).length;
    assert.equal(off, links, `components/os/today/${name}: ${links} <Link> but ${off} prefetch={false}`);
    assert.ok(
      !/bg-gradient|from-accent|blur-|shadow-glow|animate-pulse|animate-spin|drop-shadow|linearGradient|uppercase/.test(src),
      `components/os/today/${name} carries a gradient, glow, perpetual animation or uppercase label`,
    );
  }
  // The unprovisioned page is decided before any session or tenant read.
  const provisionAt = dispatcher.indexOf("isUnprovisionedManifest(manifest)");
  const surfaceAt = dispatcher.indexOf("await resolveViewerSurface()");
  assert.ok(provisionAt > -1 && surfaceAt > provisionAt, "an unprovisioned workspace returns before the session is resolved");
  assert.equal(/import[^;]+@\/lib\//.test(code("components/os/today/WorkspaceSetupPending.tsx")), false, "the set-up page imports no reader");

  // ── 3. Builders ────────────────────────────────────────────────────────────
  const now = Date.parse("2026-09-28T15:00:00Z");
  const day = { startMs: Date.parse("2026-09-28T04:00:00Z"), endMs: Date.parse("2026-09-29T04:00:00Z") };
  const rows = [
    { id: "a", data: { company: "Acme", stage: "contacted", next_action_at: "2026-09-27T12:00:00Z" } },
    { id: "b", data: { name: "Bea", stage: "qualified", next_action_at: "2026-09-29T12:00:00Z" } },
    { id: "c", data: { company: "Won Co", stage: "won", next_action_at: "2026-09-01T12:00:00Z" } },
    { id: "d", data: { company: "Lost Co", stage: "lost", next_action_at: "2026-09-01T12:00:00Z" } },
    { id: "e", data: { company: "Early", stage: "assigned", next_action_at: "2026-09-20T12:00:00Z" } },
    { id: "m1", data: { company: "Meet Co", stage: "founder_meeting_booked", founder_meeting_at: "2026-09-28T18:00:00Z" } },
    { id: "m2", data: { company: "Gone Co", stage: "founder_meeting_booked", founder_meeting_at: "2026-09-28T17:00:00Z", founder_meeting_status: "cancelled_by_client" } },
    { id: "m3", data: { company: "Tomorrow", stage: "founder_meeting_booked", founder_meeting_at: "2026-09-29T15:00:00Z" } },
  ];
  // Past-due next steps, split at the cycle start (2026-09-24 here): "a" is a
  // fresh miss, "e" a promise carried over from before the cycle. Closed
  // stages have nothing to follow up; m1/m2/m3 have no next step recorded.
  const buckets = salesBuckets(rows, now, Date.parse("2026-09-24T00:00:00Z"));
  assert.deepEqual(buckets.overdue.map((r) => r.id), ["a"], "open + past due inside the cycle only");
  assert.deepEqual(buckets.carriedOver.map((r) => r.id), ["e"], "dated before the cycle: carried over, not fresh");
  assert.deepEqual(buckets.noNextStep.map((r) => r.id), ["m2", "m1", "m3"], "open with no next step, by name");
  assert.deepEqual(buckets.outcomeMissing, [], "no booked meeting is in the past");
  assert.deepEqual(meetingsBetween(rows, day.startMs, day.endMs).map((r) => r.id), ["m1"], "today only, cancelled excluded");
  const board = summarizeBoard({
    rows,
    summary: { onBoard: 9, qualified: 2, meetings: 3, won: 1, lost: 1, cycleStartedAt: "2026-09-24" },
    truncatedStages: ["won"],
    nowMs: now,
    day,
  });
  assert.equal(board.partial, false, "a won column past its window cannot hide a follow-up");
  assert.equal(board.openLeads, 8);
  assert.equal(
    summarizeBoard({ rows, summary: board.summary!, truncatedStages: ["contacted"], nowMs: now, day }).partial,
    true,
    "an open stage past its window makes the follow-up count a floor",
  );

  const delivery = summarizeDelivery({
    tickets: [
      { id: "t1", ticket_number: "T-0001", title: "Site down", status: "open", severity: "critical", sla_target: "2026-09-28T14:00:00Z", first_response_at: null, created_at: "2026-09-28T13:00:00Z" },
      { id: "t2", ticket_number: "T-0002", title: "Copy change", status: "open", severity: "high", sla_target: "2026-09-28T15:30:00Z", first_response_at: null, created_at: "2026-09-28T11:30:00Z" },
      { id: "t3", ticket_number: "T-0003", title: "Answered", status: "in_progress", severity: "critical", sla_target: "2026-09-28T14:00:00Z", first_response_at: "2026-09-28T13:10:00Z", created_at: "2026-09-28T13:00:00Z" },
      { id: "t4", ticket_number: "T-0004", title: "Closed", status: "resolved", severity: "critical", sla_target: "2026-09-27T14:00:00Z", first_response_at: null, created_at: "2026-09-27T13:00:00Z" },
    ],
    projects: [
      { stage: "building", due_date: "2026-09-20" },
      { stage: "review", due_date: null },
      { stage: "live", due_date: "2026-09-01" },
    ],
    ticketsTruncated: false,
    projectsTruncated: false,
    closedTicketsExist: false,
    now: new Date(now),
    todayKey: "2026-09-28",
  });
  assert.deepEqual(delivery.breached.map((t) => t.id), ["t1"], "unanswered past target");
  assert.deepEqual(delivery.atRisk.map((t) => t.id), ["t2"], "unanswered in the last quarter of the window");
  assert.equal(delivery.openTickets, 3, "resolved is not open");
  assert.equal(delivery.activeProjects, 2);
  assert.equal(delivery.overdueProjects, 1);

  const replies = pickHotReplies(
    [
      { id: "r1", subject: "Ready to sign", created_at: "2026-09-28T13:00:00Z", metadata: { classification: { intent: "hot_lead" } } },
      { id: "r2", subject: "Newsletter", created_at: "2026-09-28T13:00:00Z", metadata: {} },
      { id: "r3", subject: "Old hot", created_at: "2026-09-26T13:00:00Z", metadata: { classification: { intent: "hot_lead" } } },
      { id: "r4", subject: "Invoice wrong", created_at: "2026-09-28T14:00:00Z", metadata: { classification: { priority: "urgent", intent: "question" } } },
    ],
    now,
  );
  assert.deepEqual(replies.map((r) => r.id), ["r4", "r1"], "classified hot, last 24h, newest first — the unclassified fallback is not hot");

  assert.equal(askPrefillHref("/team/chief-of-staff", "  "), "/team/chief-of-staff", "empty asks open the channel bare");
  assert.equal(
    askPrefillHref("/team/chief-of-staff", " Call Acme & send the proposal? "),
    `/team/chief-of-staff?${ASK_PREFILL_PARAM}=Call%20Acme%20%26%20send%20the%20proposal%3F`,
  );
  // The receiving side reads the SAME constant, so a rename cannot leave the
  // composer handing off a brief the department page never picks up.
  assert.match(read("app/team/[dept]/page.tsx"), /sp\[ASK_PREFILL_PARAM\]/, "the department page must read ASK_PREFILL_PARAM");

  // Needs you: failed sources are named, never read as "all clear".
  const failed: Read<never> = { ok: false };
  const gaps = buildNeedsYou({ sales: failed, delivery: failed, inbound: failed, cash: null, nowMs: now, formatTime: () => "10:00 AM" });
  assert.deepEqual(gaps.items, []);
  assert.deepEqual(gaps.unavailable, ["support tickets", "pipeline follow-ups", "inbound replies"]);
  const sales: Read<SalesSnapshot> = { ok: true, value: board };
  const deliveryRead: Read<DeliverySnapshot> = { ok: true, value: delivery };
  const cashLive: Read<CashSnapshot> = {
    ok: true,
    value: {
      cashCadCents: 1_250_000,
      hasCashActivity: true,
      overdueCount: 2,
      overdueLabel: "CA$1,200.00",
      unreviewed: 4,
      coverage: { complete: true, gaps: [], bankLines: 12, accounts: [{ name: "Business chequing", covers: "12 entries; opening balance recorded" }] },
    },
  };
  const full = buildNeedsYou({
    sales,
    delivery: deliveryRead,
    inbound: { ok: true, value: replies },
    cash: cashLive,
    nowMs: now,
    formatTime: () => "2:00 PM",
  });
  assert.deepEqual(
    full.items.map((i) => i.tone),
    [...full.items.map((i) => i.tone)].sort((a, b) => ["urgent", "attention", "info"].indexOf(a) - ["urgent", "attention", "info"].indexOf(b)),
    "urgent first, then attention, then info",
  );
  const ids = full.items.map((i) => i.id);
  for (const id of ["sla-breached", "sla-at-risk", "follow-ups", "meetings-today", "reply-r1", "reply-r4", "invoices-overdue", "bank-review"]) {
    assert.ok(ids.includes(id), `Needs you carries ${id}`);
  }
  assert.equal(full.items.find((i) => i.id === "sla-breached")?.href, "/tickets?sla=breached");
  assert.equal(full.unavailable.length, 0);

  // Goal pace: a failed collected read is an error, never an empty bar.
  const goalRow = { label: "October sprint", target_cents: 600_000, period_end: "2026-10-24" };
  assert.deepEqual(goalPaceView({ goal: null, progress: null, paceSeries: [], stripeConnected: true, collected: null }), { kind: "no_goal" });
  assert.equal(goalPaceView({ goal: goalRow, progress: null, paceSeries: [], stripeConnected: true, collected: null }).kind, "error");
  const live = goalPaceView({
    goal: goalRow,
    progress: { collected_cents: 120_000, remaining_cents: 480_000, pct: 20, days_left: 27, daily_need_cents: 17_778, status: "behind" },
    paceSeries: [
      { collected: 0, pace: 193.55 },
      { collected: 1200, pace: 967.74 },
      { collected: null, pace: 1161.29 },
    ],
    stripeConnected: false,
    collected: { fx_missing_days: ["2026-09-27"] },
  });
  assert.equal(live.kind, "live");
  if (live.kind === "live") {
    assert.equal(live.statusLabel, "Behind pace", "same words as GoalCountdownCard");
    assert.ok(live.pacePct !== null && Math.abs(live.pacePct - 16.129) < 0.01, `pace mark at today's line (${live.pacePct})`);
    assert.equal(live.caveats.length, 2, "Stripe off and a missing FX day are both said");
  }

  // Cash: no bank activity is "Not connected", never CA$0.
  const complete = { complete: true, gaps: [], bankLines: 3, accounts: [] };
  assert.deepEqual(
    cashView({ ok: true, value: { cashCadCents: 0, hasCashActivity: false, overdueCount: 0, overdueLabel: null, unreviewed: 0, coverage: complete } }),
    { kind: "not_connected" },
  );
  assert.deepEqual(cashView({ ok: false }), { kind: "error" });
  assert.equal(cashView({ ok: true, value: { cashCadCents: 0, hasCashActivity: true, overdueCount: 0, overdueLabel: null, unreviewed: 0, coverage: complete } }).kind, "live", "a real zero balance is live");

  // ── 4. Rendered: unknown never prints as zero; a live zero does ───────────
  const { CashGlance } = await import("../components/os/today/CashGlance");
  const { GoalPaceGlance } = await import("../components/os/today/GoalPaceGlance");
  const { DepartmentCard } = await import("../components/os/today/DepartmentCard");
  const { NeedsYouList } = await import("../components/os/today/NeedsYouList");
  const { TodayBrief } = await import("../components/os/today/TodayBrief");

  const cashOff = render(createElement(CashGlance, { view: { kind: "not_connected" } }));
  assert.match(cashOff, /Not connected/);
  assert.match(cashOff, /Connect/);
  assert.doesNotMatch(cashOff, ZERO_MONEY, `a disconnected bank printed money: ${cashOff}`);
  const cashErr = render(createElement(CashGlance, { view: { kind: "error" } }));
  assert.match(cashErr, /Couldn.t load/);
  assert.doesNotMatch(cashErr, ZERO_MONEY);
  const cashOn = render(createElement(CashGlance, { view: cashView(cashLive) }));
  assert.match(cashOn, /CA\$12,500\.00/, "a live balance prints");

  const goalErr = render(createElement(GoalPaceGlance, { view: { kind: "error", label: "October sprint" } as GoalPaceView, detailHref: "#g" }));
  assert.match(goalErr, /not \$0 collected/);
  assert.doesNotMatch(goalErr.replace("not $0 collected", ""), ZERO_MONEY);
  const goalLive = render(createElement(GoalPaceGlance, { view: live, detailHref: "#g" }));
  assert.match(goalLive, /\$1,200/);
  assert.match(goalLive, /of \$6,000 USD/);
  assert.match(goalLive, /Behind pace/);

  const cards = buildDepartmentCards({
    departments: OS_DEPARTMENTS.map((d) => ({ key: d.key, label: d.label, href: d.href })),
    needsYou: gaps,
    sales: failed,
    delivery: deliveryRead,
    content: { ok: true, value: { published: 0, lastSyncedAt: "2026-09-28T14:00:00Z" } },
    goal: { kind: "error", label: "October sprint" },
    stripeConnected: false,
    routines: failed,
    formatWhen: () => "Sep 28, 10:00 AM",
  });
  assert.deepEqual(cards.map((c) => c.key), OS_DEPARTMENTS.map((d) => d.key), "one card per department, in rail order");
  const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));
  assert.equal(byKey.sales.metric.kind, "error", "a failed pipeline read is an error, not 0 leads");
  assert.equal(byKey.finance.metric.kind, "error", "a failed revenue read is an error, not $0");
  assert.equal(byKey.operations.metric.kind, "error", "a failed routine read is an error, not 'no failures'");
  assert.equal(byKey.chief_of_staff.status, "Partly checked", "failed sources are not 'Nothing waiting'");
  for (const card of cards) {
    const text = render(createElement(DepartmentCard, { card }));
    assert.doesNotMatch(text, ZERO_MONEY, `${card.key} printed a zero amount of money: ${text}`);
    if (card.metric.kind === "error" || card.metric.kind === "unmeasured") {
      assert.match(text, /—/, `${card.key}: an unknown number is an em dash`);
      assert.doesNotMatch(text, /(^|\s)0(\s|$)/, `${card.key}: an unknown number printed 0: ${text}`);
    }
  }
  const marketing = render(createElement(DepartmentCard, { card: byKey.marketing }));
  assert.match(marketing, /(^|\s)0(\s|$)/, "a live zero from a live source is a real zero");
  // The line under the number names the source the number comes from, with
  // its freshness — never a fixed "Not connected" for an app it does not read.
  assert.match(marketing, /Zernio post analytics · Last synced Sep 28, 10:00 AM/, "the card names its real source");
  assert.doesNotMatch(marketing, /Meta|Not connected|Connect/, `the Marketing card claims a connection it does not read: ${marketing}`);
  assert.match(render(createElement(DepartmentCard, { card: byKey.finance })), /Stripe .*Not connected .*Connect/);
  const nc = render(
    createElement(DepartmentCard, {
      card: { ...byKey.sales, metric: { kind: "not_connected", label: "Meta Ads", connectHref: "/settings/connections" } },
    }),
  );
  assert.match(nc, /Not connected Connect/);
  assert.doesNotMatch(nc, /(^|\s)0(\s|$)/);

  // "Within SLA" is a claim about every open ticket. A capped read with nothing
  // breached in the rows it DID see cannot make it (CodeRabbit #469).
  const quietDelivery = { ...delivery, breached: [], atRisk: [] };
  const slaCard = (ticketsTruncated: boolean, projectsTruncated = false) =>
    buildDepartmentCards({
      departments: OS_DEPARTMENTS.filter((d) => d.key === "client_success").map((d) => ({ key: d.key, label: d.label, href: d.href })),
      needsYou: { items: [], unavailable: [] },
      sales: failed,
      delivery: { ok: true, value: { ...quietDelivery, ticketsTruncated, projectsTruncated } },
      content: { ok: true, value: { published: 0, lastSyncedAt: null } },
      goal: null,
      stripeConnected: null,
      routines: null,
    })[0];
  assert.equal(slaCard(false).status, "Within SLA");
  assert.equal(slaCard(false).tone, "ok");
  assert.equal(slaCard(false).detail, "2 active projects · 1 past due");
  assert.equal(slaCard(true).status, "SLA not fully checked", "a capped ticket read never says Within SLA");
  assert.equal(slaCard(true).tone, "attention");
  assert.equal(slaCard(true).metric.kind === "live" && slaCard(true).metric.value, "3+", "the open count is a floor too");
  // Each read carries its own cap (CodeRabbit #469, second pass): a capped
  // PROJECT list leaves a complete ticket read complete, and floors only the
  // project line.
  const projectsCapped = slaCard(false, true);
  assert.equal(projectsCapped.status, "Within SLA", "a capped project read says nothing about the tickets");
  assert.equal(projectsCapped.tone, "ok");
  assert.equal(projectsCapped.metric.kind === "live" && projectsCapped.metric.value, "3");
  assert.equal(projectsCapped.detail, "2+ active projects · 1+ past due");

  // A breach found in a capped ticket read is a floor in the Needs-you list
  // too: "At least" in the title and "1+" on the pill.
  const cappedNeeds = buildNeedsYou({
    sales: null,
    delivery: { ok: true, value: { ...delivery, ticketsTruncated: true } },
    inbound: null,
    cash: null,
    nowMs: now,
    formatTime: () => "10:00 AM",
  });
  const breachItem = cappedNeeds.items.find((i) => i.id === "sla-breached");
  assert.ok(breachItem && breachItem.capped === true);
  assert.match(breachItem.title, /^At least 1 ticket is past/);
  assert.match(render(createElement(NeedsYouList, { needsYou: cappedNeeds })), /Site down 1\+ /, "the pill prints the floor");
  const exactNeeds = buildNeedsYou({ sales: null, delivery: deliveryRead, inbound: null, cash: null, nowMs: now, formatTime: () => "10:00 AM" });
  assert.equal(exactNeeds.items.find((i) => i.id === "sla-breached")?.capped, false);
  assert.doesNotMatch(render(createElement(NeedsYouList, { needsYou: exactNeeds })), /\d\+/, "an exact read prints exact counts");
  const needsYouSrc = code("components/os/today/NeedsYouList.tsx");
  assert.match(needsYouSrc, /from "@\/lib\/os\/count"/, "the pill floors through the shell's one rule");
  assert.doesNotMatch(needsYouSrc, /`\$\{\w+\}\+`/, "NeedsYouList hand-rolls a floor marker instead of floorCount");

  const gapsList = render(createElement(NeedsYouList, { needsYou: gaps }));
  assert.match(gapsList, /Couldn.t check support tickets, pipeline follow-ups, inbound replies/);
  assert.doesNotMatch(gapsList, /Nothing needs you right now/, "an unread source is not 'all clear'");

  // A viewer without company money: no goal, no cash, no finance card → no money on the page at all.
  const noMoney = render(
    createElement(TodayBrief, {
      greeting: "Good morning, Sam",
      subtitle: "Monday",
      askHref: "/team/chief-of-staff",
      needsYou: { items: [], unavailable: [] },
      departments: buildDepartmentCards({
        departments: OS_DEPARTMENTS.filter((d) => departmentsFor("founder", CLIENT).has(d.key)),
        needsYou: { items: [], unavailable: [] },
        sales: { ok: true, value: { ...board, source: "records", summary: null, openLeads: 0, overdue: [], meetingsToday: [], partial: false } },
        delivery: deliveryRead,
        content: { ok: true, value: { published: 3, lastSyncedAt: "2026-09-28T14:00:00Z" } },
        goal: null,
        stripeConnected: null,
        routines: { ok: true, value: { total: 0, on: 0, failed24h: [], lastSuccessAt: null } },
      }),
      schedule: {
        meetings: null,
        partial: false,
        calendar: { ok: true, value: { personal: { connected: false, address: null }, workspace: null } },
        connectHref: "/settings",
      },
      goal: null,
      cash: null,
      financialsNote: null,
      goalCard: null,
    }),
  );
  assert.doesNotMatch(noMoney, /\$/, `a viewer without company money saw a money figure: ${noMoney}`);
  assert.doesNotMatch(noMoney, /Goal pace|Cash on hand|Finance/, "no money blocks are drawn");
  assert.match(noMoney, /Needs you/);
  assert.match(noMoney, /Google Calendar · Not connected Connect/);
  assert.equal(departmentsFor("founder", CLIENT).has("finance"), false, "a client owner has no Finance department");

  console.log(
    `os-today: OK — money plan closed for ${PERSONAS.length * 3 - 1} of ${PERSONAS.length * 3} persona×workspace cases, ` +
      `${briefFiles.length} brief components read nothing, unknown never renders as $0`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
