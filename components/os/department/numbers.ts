/**
 * components/os/department/numbers.ts — the 3-4 KPI tiles on a department's
 * Overview panel, from the readers the rest of the app already trusts.
 *
 * UNKNOWN IS NOT ZERO. Every read returns `{ ok: false }` on failure and the
 * tile says "Couldn't load"; a source that is not wired says "Not connected".
 * Nothing here falls back to 0, because a confident zero on a department tab
 * reads as "nothing happened", which is the failure lib/goals and the Today
 * money cards were rebuilt to stop.
 *
 * SCOPE IS THE FETCH. A tile a viewer may not see is never computed, not
 * computed and hidden. Pipeline numbers follow /pipeline's own rule (an admin
 * sees the board, anyone else their own book); tickets follow
 * lib/delivery/access.ts; money is read only on the Finance tab, whose gate is
 * the Money gate (module finance + owner + OASIS).
 *
 * Reused, not re-derived:
 *   Sales/CoS  founderBoardSummary + listOasisPipelineWindow (OASIS board),
 *              listRecords (other workspaces' leads)
 *   Marketing  momentumMetrics (post_analytics), form_submissions
 *   Finance    loadOasisMoney (ledger + live Stripe)
 *   CS         listTickets / listProjects + slaStatus (lib/delivery)
 *   Ops        tenant_cron_jobs (+ OASIS's Empire rows), via ./routines.ts,
 *              summarised by routine-rules.ts routineHealth — the same
 *              numbers Today's Operations card prints
 *   CoS        Needs you: components/os/today/brief-load.ts, the SAME reads
 *              and the same count (model.ts needsYouTotal) as Today
 */

import "server-only";
import type { KpiTileProps } from "@/components/os/KpiTile";
import type { OsDepartment } from "@/lib/os/departments";
import { formatOperatorDate } from "@/lib/dates";
import { formatMoney } from "@/lib/fmt";
import { listRecords } from "@/lib/manifest/data";
import { momentumMetrics } from "@/lib/queries";
import { getServiceSupabase } from "@/lib/supabase-server";
import { founderBoardSummary } from "@/lib/oasis-board-summary";
import { summarizeBoardCounts, type BoardSummary } from "@/lib/oasis-board-summary-rules";
import { listOasisPipelineWindow } from "@/lib/oasis-pipeline-query";
import { oasisBoardProgramFilter, oasisBoardStages } from "@/lib/oasis-lead-create";
import { isOasisPipelineAdmin } from "@/lib/oasis-sales-pipeline-policy";
import { CURRENT_OASIS_PIPELINE_CYCLE } from "@/lib/pipeline-cycle";
import { loadOasisMoney } from "@/lib/goals/oasis-money";
import { isFinanceOwnerEmail } from "@/lib/founders-finances/access";
import { resolveDeliveryViewer } from "@/lib/delivery/access";
import { ACTIVE_PROJECT_STAGES, slaStatus } from "@/lib/delivery/rules";
import { getDeliveryDb } from "@/lib/delivery/session";
import { listProjects, listTickets } from "@/lib/delivery/store";
import { resolvePlatformOperatorForAuthUser } from "@/lib/platform-operator";
import {
  briefPlanFor,
  empireLaneFromCheck,
  empireRoutinesFor,
  loadNeedsYouReads,
  needsYouFrom,
  operatorDayAt,
} from "@/components/os/today/brief-load";
import { needsYouTotal } from "@/components/os/today/model";
import { stripeSyncLine } from "@/lib/founders-finances/stripe-sync-status";
import { tileCount } from "./count-rules";
import {
  empireReadFor,
  failedRoutinesHref,
  mergeRoutineReads,
  OPERATIONS_HREF,
  routineHealth,
  type EmpireLane,
  type RoutineHealth,
  type RoutineRow,
} from "./routine-rules";
import { loadEmpireRoutines, type Read } from "./routines";
import type { OsViewer } from "./viewer";

export type AttentionItem = {
  id: string;
  label: string;
  href: string | null;
  /** How many things this line stands for; the header's "Needs you" sums them. */
  count: number;
  /** The count came from a capped read, so it is a floor (and so is any sum that includes it). */
  capped?: boolean;
};

export type DepartmentNumbers = {
  tiles: KpiTileProps[];
  /** Real things needing a person now. Drives the header's "Needs you". */
  attention: AttentionItem[];
  /**
   * The header's "Needs you" total when this department owns the whole-
   * workspace answer (Chief of Staff: model.ts needsYouTotal, approvals
   * included). Absent: the page sums `attention` and this department's
   * approvals itself.
   */
  needsYou?: { total: number; capped: boolean };
};

const CONNECTIONS_HREF = "/settings/connections";
const WEEK_MS = 7 * 86_400_000;

async function read<T>(label: string, fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    // Loud: a tile that says "Couldn't load" must have a log line behind it.
    console.error(`[os.department.${label}]`, err);
    return { ok: false };
  }
}

const n = (v: number) => v.toLocaleString("en-US");
const dollars = (cents: number) => formatMoney(cents / 100);
const failed = (label: string, hint?: string): KpiTileProps => ({ label, value: null, status: "error", hint });

// ── Pipeline (Sales, Chief of Staff) ──────────────────────────────────────

type PipelineFigures =
  | { kind: "board"; own: boolean; summary: BoardSummary }
  | { kind: "records"; own: boolean; total: number; new7d: number; capped: boolean };

const RECENT_LEAD_WINDOW = 500;

/** Null: this viewer has no pipeline scope at all, so no pipeline tile is drawn. */
async function loadPipeline(viewer: OsViewer): Promise<Read<PipelineFigures> | null> {
  const { surface } = viewer;
  const tenantId = surface.tenantId;
  if (viewer.oasis) {
    // /pipeline's own split: an admin reads the board, everyone else reads
    // their own book through the same windowed query the board runs for them.
    const admin = surface.persona === "founder" || isOasisPipelineAdmin(surface.teamRole);
    if (admin) {
      return read("pipeline.board", async () => ({
        kind: "board" as const,
        own: false,
        summary: await founderBoardSummary(tenantId, surface.tenantSlug),
      }));
    }
    return read("pipeline.own", async () => {
      const filter = oasisBoardProgramFilter(surface.tenantSlug);
      const window = await listOasisPipelineWindow({
        tenantId,
        stageKeys: oasisBoardStages({ teamRole: surface.teamRole }).map((s) => s.key),
        salesProgram: filter.salesProgram,
        salesMotion: filter.salesMotion,
        viewerUserId: surface.userId,
        fulfillmentOwnerId: surface.teamRole.trim().toLowerCase() === "builder" ? surface.userId : null,
        cycle: CURRENT_OASIS_PIPELINE_CYCLE,
      });
      return {
        kind: "board" as const,
        own: true,
        summary: summarizeBoardCounts(window.stageCounts, CURRENT_OASIS_PIPELINE_CYCLE.startedAt),
      };
    });
  }
  // Any other workspace: its own lead records. A viewer who may not read the
  // whole pipeline is scoped in the query, not after it.
  const own = !surface.capabilities.canSeeAllPipeline;
  if (own && !surface.capabilities.canSeeOwnPipelineOnly) return null;
  return read("pipeline.records", async () => {
    const where = own ? { assigned_to: surface.userId.toLowerCase() } : undefined;
    const [all, recent] = await Promise.all([
      listRecords({ tenant_id: tenantId, entity: "lead", limit: 1, ...(where ? { where } : {}) }),
      listRecords({
        tenant_id: tenantId,
        entity: "lead",
        sort: "-created_at",
        limit: RECENT_LEAD_WINDOW,
        ...(where ? { where } : {}),
      }),
    ]);
    const since = Date.now() - WEEK_MS;
    const new7d = recent.rows.filter((r) => Date.parse(r.created_at) >= since).length;
    return {
      kind: "records" as const,
      own,
      total: all.total,
      new7d,
      // Every row in the window is from this week, so the true count may be higher.
      capped: new7d === RECENT_LEAD_WINDOW,
    };
  });
}

function cycleHint(): string {
  const started = formatOperatorDate({ month: "short", day: "numeric" }, new Date(CURRENT_OASIS_PIPELINE_CYCLE.startedAt));
  return `This cycle, since ${started}`;
}

function pipelineTiles(p: Read<PipelineFigures> | null, compact: boolean): KpiTileProps[] {
  if (p === null) return [];
  if (!p.ok) return [failed("Pipeline", "Lead read failed")];
  const v = p.value;
  if (v.kind === "board") {
    const s = v.summary;
    const first: KpiTileProps = {
      label: v.own ? "Your board" : "On the board",
      value: n(s.onBoard),
      status: "live",
      hint: cycleHint(),
    };
    if (compact) return [first];
    return [
      first,
      { label: "Qualified", value: n(s.qualified), status: "live", hint: v.own ? "Your leads" : "Across the team" },
      { label: "Meetings", value: n(s.meetings), status: "live", hint: "Booked or held" },
      { label: "Won", value: n(s.won), status: "live", hint: "This cycle" },
    ];
  }
  const first: KpiTileProps = {
    label: v.own ? "Your leads" : "Leads",
    value: n(v.total),
    status: "live",
    hint: "Open records",
  };
  if (compact) return [first];
  return [
    first,
    {
      label: v.own ? "Your new leads 7d" : "New leads 7d",
      value: tileCount(v.new7d, v.capped),
      status: "live",
      hint: "Created in the last 7 days",
    },
  ];
}

// ── Client Success (tickets + projects) ───────────────────────────────────

/**
 * Every workspace runs its own desk (lib/delivery/access.ts, relation "desk").
 * Its team (owners and admins) sees THEIR customers' tickets and their own
 * projects. A member below that in another workspace still sees only the
 * requests their workspace filed with OASIS and the projects OASIS runs for
 * them (relation "vendor"), so their tiles say so rather than presenting a
 * vendor's queue as their own customers'.
 */
type DeliveryFigures = {
  kind: "founder" | "client";
  open: number;
  /**
   * The desk has ever held a ticket (open or closed). With none, the ticket
   * tiles say "No tickets yet": "0 breached" over a desk nobody has used is a
   * health verdict with nothing behind it.
   */
  ticketHistory: boolean;
  breached: number;
  atRisk: number;
  activeProjects: number;
  /** The open-ticket read hit its ceiling: every ticket-derived count is a floor. */
  truncated: boolean;
  /** The project read hit its ceiling: the active-project count is a floor. */
  projectsTruncated: boolean;
};

/** lib/delivery/access.ts, asked with the session this page already resolved: own desk first, then vendor. */
function deliveryViewerFor(viewer: OsViewer) {
  const s = viewer.surface;
  const input = {
    ok: true as const,
    persona: s.persona,
    tenantId: s.tenantId,
    userId: s.userId,
    canAct: s.capabilities.canAct,
  };
  const desk = resolveDeliveryViewer(input, { relation: "desk" });
  return desk.ok ? desk : resolveDeliveryViewer(input);
}

async function loadDelivery(viewer: OsViewer, withProjects: boolean): Promise<Read<DeliveryFigures> | null> {
  const access = deliveryViewerFor(viewer);
  // Denied (a non-founder inside OASIS): the tile is not drawn at all.
  if (!access.ok) return null;
  const db = getDeliveryDb();
  if (!db) return { ok: false };
  return read("delivery", async () => {
    const [tickets, projects] = await Promise.all([
      listTickets(db, access.viewer, { status: "open" }),
      withProjects ? listProjects(db, access.viewer, { includeArchived: false }) : Promise.resolve(null),
    ]);
    const now = new Date();
    const states = tickets.rows.map((t) => slaStatus(t, now).state);
    // Only asked when nothing is open: same viewer, same scope.
    const ticketHistory =
      tickets.rows.length > 0 || (await listTickets(db, access.viewer, { status: "closed" })).rows.length > 0;
    return {
      kind: access.viewer.kind,
      open: tickets.rows.length,
      ticketHistory,
      breached: states.filter((s) => s === "breached").length,
      atRisk: states.filter((s) => s === "at_risk").length,
      activeProjects: projects
        ? projects.rows.filter((p) => (ACTIVE_PROJECT_STAGES as readonly string[]).includes(p.stage)).length
        : 0,
      truncated: tickets.truncated,
      projectsTruncated: projects ? projects.truncated : false,
    };
  });
}

/** A desk with no ticket ever: a ticket tile says so instead of a 0. */
function noTickets(label: string, hint: string): KpiTileProps {
  return { label, value: null, status: "no_data", emptyText: "No tickets yet", hint };
}

function breachAttention(d: DeliveryFigures): AttentionItem[] {
  // A breach on a client's request is the vendor's miss, not the client's
  // task; only the team that owes the reply is told it needs them.
  if (d.kind !== "founder" || d.breached === 0) return [];
  return [
    {
      id: "sla-breached",
      count: d.breached,
      capped: d.truncated,
      label: `${tileCount(d.breached, d.truncated)} ticket${d.breached === 1 && !d.truncated ? "" : "s"} past the first-response target`,
      href: "/tickets?sla=breached",
    },
  ];
}

// ── Routines (Operations, Chief of Staff) ─────────────────────────────────

/**
 * The verified platform-operator check for this viewer's session
 * (lib/platform-operator.ts), as an Empire lane: a failed lookup is "unknown",
 * never a quiet "no" (brief-load.ts empireLaneFromCheck).
 */
function operatorCheck(viewer: OsViewer): () => Promise<EmpireLane> {
  return async () => empireLaneFromCheck(await resolvePlatformOperatorForAuthUser(viewer.authUserId, viewer.email));
}

/**
 * The routines this viewer's health numbers cover: the workspace's own, plus —
 * for the platform operator standing in OASIS — the Empire scheduler's rows
 * carrying the OASIS workspace id (routines.ts loadEmpireRoutines). The same
 * rule Today's Operations card reads by (brief-load.ts empireRoutinesFor).
 */
async function routineHealthFor(viewer: OsViewer, workspace: Read<RoutineRow[]>): Promise<Read<RoutineHealth>> {
  // "unknown" (the operator check failed) is a failed Empire read, so the
  // tiles say "Couldn't check" rather than the workspace lane alone.
  const lane = await empireRoutinesFor(viewer.surface, operatorCheck(viewer));
  const empire = await empireReadFor(lane, () => loadEmpireRoutines(viewer.surface.tenantId));
  const merged = mergeRoutineReads(workspace, empire);
  return merged.ok ? { ok: true, value: routineHealth(merged.value, Date.now()) } : { ok: false };
}

function routineTiles(r: Read<RoutineHealth>): KpiTileProps[] {
  if (!r.ok) return [failed("Routines on", "Routine read failed")];
  const h = r.value;
  // No routine set up is not "0 of 0 on": there is nothing to be on.
  if (h.total === 0) return [{ label: "Routines on", value: null, status: "no_data", emptyText: "None set up yet" }];
  return [{ label: "Routines on", value: `${n(h.on)} of ${n(h.total)}`, status: "live", hint: "Scheduled for this workspace" }];
}

function failureAttention(h: RoutineHealth): AttentionItem[] {
  if (h.failed24h.length === 0) return [];
  const href = failedRoutinesHref(h.failed24h);
  return [
    {
      id: "routines-failed",
      count: h.failed24h.length,
      label: `${n(h.failed24h.length)} routine${h.failed24h.length === 1 ? "" : "s"} failed in the last 24 hours`,
      // The panel below lists the workspace lane: no link needed. An Empire
      // failure is listed only in Automations, so the line goes there.
      href: href === OPERATIONS_HREF ? null : href,
    },
  ];
}

// ── Per department ────────────────────────────────────────────────────────

async function salesNumbers(viewer: OsViewer): Promise<DepartmentNumbers> {
  return { tiles: pipelineTiles(await loadPipeline(viewer), false), attention: [] };
}

type FormFigures = { submissions: number; capped: boolean };
const FORM_WINDOW = 2000;

async function loadFormSubmissions(tenantId: string): Promise<Read<FormFigures>> {
  return read("marketing.forms", async () => {
    const since = new Date(Date.now() - WEEK_MS).toISOString();
    const res = await getServiceSupabase()
      .from("form_submissions")
      .select("id, form_id, lead_id")
      .eq("tenant_id", tenantId)
      .gte("submitted_at", since)
      .limit(FORM_WINDOW);
    if (res.error) throw new Error(res.error.message);
    const rows = (res.data || []) as Array<{ id: string; form_id: string | null; lead_id: string | null }>;
    // A multi-step form writes one row per step; a person filling one form
    // is one submission.
    const people = new Set(rows.map((r) => `${r.form_id ?? ""}:${r.lead_id ?? r.id}`));
    return { submissions: people.size, capped: rows.length >= FORM_WINDOW };
  });
}

async function marketingNumbers(viewer: OsViewer): Promise<DepartmentNumbers> {
  const tenantId = viewer.surface.tenantId;
  const [forms, momentum] = await Promise.all([
    loadFormSubmissions(tenantId),
    read("marketing.momentum", () => momentumMetrics(tenantId)),
  ]);
  const owner = viewer.surface.persona === "founder";
  const published = momentum.ok ? momentum.value.contentPublished7d : null;
  const sends = momentum.ok ? momentum.value.contentSends7d : null;
  return {
    tiles: [
      forms.ok
        ? {
            label: "Form submissions 7d",
            value: tileCount(forms.value.submissions, forms.value.capped),
            status: "live",
            hint: "People who submitted a form",
          }
        : failed("Form submissions 7d", "Form read failed"),
      // momentumMetrics answers null (not 0) when post_analytics cannot be read.
      published === null
        ? failed("Content published 7d", "Content read failed")
        : {
            label: "Content published 7d",
            value: n(published),
            status: "live",
            hint: sends === null ? undefined : `${n(sends)} platform send${sends === 1 ? "" : "s"}`,
          },
      {
        label: "Ad spend 7d",
        value: null,
        status: "not_connected",
        hint: "Meta Ads",
        ...(owner ? { connectHref: CONNECTIONS_HREF } : {}),
      },
    ],
    attention: [],
  };
}

async function financeNumbers(viewer: OsViewer): Promise<DepartmentNumbers> {
  // The gate already required company financials (module finance + owner +
  // OASIS); this is the second lock, so a future gate change cannot turn this
  // into a read of OASIS's ledger for someone else.
  if (!viewer.oasis || !viewer.surface.capabilities.canSeeCompanyFinancials) {
    return { tiles: [], attention: [] };
  }
  const money = await loadOasisMoney(viewer.surface.tenantId, "os.department.finance");
  // Only the finance owners can open Finances › Settings, where Stripe is pinned.
  const stripeHref = isFinanceOwnerEmail(viewer.email) ? "/founders/finances/settings" : undefined;
  const goal = money.goal;
  const progress = money.progress;
  return {
    tiles: [
      money.last7
        ? {
            label: "Collected 7d",
            value: dollars(money.last7.usd_cents),
            status: "live",
            hint: `${n(money.last7.payments)} payment${money.last7.payments === 1 ? "" : "s"}, USD`,
          }
        : failed("Collected 7d", "Ledger unavailable"),
      !goal
        ? { label: "Collected toward goal", value: null, status: "live", hint: "No active revenue goal" }
        : money.collected
          ? {
              label: "Collected toward goal",
              value: dollars(money.collected.usd_cents),
              status: "live",
              hint: `of ${dollars(goal.target_cents)} by ${goal.period_end}`,
            }
          : failed("Collected toward goal", "Ledger unavailable"),
      money.stripeConnected === false
        ? { label: "MRR", value: null, status: "not_connected", hint: "Stripe", ...(stripeHref ? { connectHref: stripeHref } : {}) }
        : money.mrr
          ? {
              label: "MRR",
              value: `${money.mrr.currency.toUpperCase() === "CAD" ? "CA" : ""}${dollars(money.mrr.mrr_cents)}`,
              status: "live",
              // A pinned account is not a synced one: say when Stripe last reached the books.
              hint: `${n(money.mrr.active_subscriptions)} live Stripe subscription${money.mrr.active_subscriptions === 1 ? "" : "s"} · ${
                money.stripeSync.ok ? stripeSyncLine(money.stripeSync.lastSyncAt, Date.now()).note : "Stripe sync: couldn't check"
              }`,
            }
          : failed("MRR", "Stripe unavailable"),
      !goal
        ? { label: "Goal pace", value: null, status: "live", hint: "No active revenue goal" }
        : progress
          ? {
              label: "Goal pace",
              value: `${Math.round(progress.pct)}%`,
              status: "live",
              hint: `${progress.status.replace("_", " ")}, ${n(progress.days_left)} day${progress.days_left === 1 ? "" : "s"} left`,
            }
          : failed("Goal pace", "Ledger unavailable"),
    ],
    attention: [],
  };
}

async function clientSuccessNumbers(viewer: OsViewer): Promise<DepartmentNumbers> {
  const delivery = await loadDelivery(viewer, true);
  if (delivery === null) return { tiles: [], attention: [] };
  if (!delivery.ok) {
    return {
      tiles: [failed("Open tickets", "Ticket read failed"), failed("Active projects", "Project read failed")],
      attention: [],
    };
  }
  const d = delivery.value;
  const open = tileCount(d.open, d.truncated);
  if (d.kind === "client") {
    return {
      tiles: [
        d.ticketHistory
          ? { label: "Open requests", value: open, status: "live", hint: "Support requests your team filed" }
          : noTickets("Open requests", "Support requests your team filed"),
        { label: "Active projects", value: tileCount(d.activeProjects, d.projectsTruncated), status: "live", hint: "In discovery, building or review" },
      ],
      attention: [],
    };
  }
  // Breached and at-risk are counted from the same capped ticket read as
  // "Open", so they are floors whenever it is (never an exact-looking total).
  return {
    tiles: [
      ...(d.ticketHistory
        ? ([
            { label: "Open tickets", value: open, status: "live", hint: "Open, in progress or waiting" },
            { label: "SLA breached", value: tileCount(d.breached, d.truncated), status: "live", hint: "Unanswered past target" },
            { label: "At risk", value: tileCount(d.atRisk, d.truncated), status: "live", hint: "Last quarter of the window" },
          ] satisfies KpiTileProps[])
        : [
            noTickets("Open tickets", "Open, in progress or waiting"),
            noTickets("SLA breached", "Unanswered past target"),
            noTickets("At risk", "Last quarter of the window"),
          ]),
      { label: "Active projects", value: tileCount(d.activeProjects, d.projectsTruncated), status: "live", hint: "Discovery, building or review" },
    ],
    attention: breachAttention(d),
  };
}

async function operationsNumbers(viewer: OsViewer, routines: Read<RoutineRow[]>): Promise<DepartmentNumbers> {
  const owner = viewer.surface.persona === "founder";
  const health = await routineHealthFor(viewer, routines);
  return {
    tiles: [
      ...routineTiles(health),
      !health.ok
        ? failed("Failed in 24h", "Routine read failed")
        : health.value.total === 0
          ? { label: "Failed in 24h", value: null, status: "no_data", emptyText: "No routines yet" }
          : {
              label: "Failed in 24h",
              value: n(health.value.failed24h.length),
              status: "live",
              hint: health.value.lastSuccessAt
                ? `Last clean run ${formatOperatorDate({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }, new Date(health.value.lastSuccessAt))}`
                : "No clean run recorded yet",
            },
      {
        label: "Connection health",
        value: null,
        status: "not_connected",
        hint: "Health checks are not measured yet",
        ...(owner ? { connectHref: CONNECTIONS_HREF } : {}),
      },
    ],
    attention: health.ok ? failureAttention(health.value) : [],
  };
}

/**
 * Chief of Staff's "Needs you" IS Today's: the same reads
 * (components/os/today/brief-load.ts loadNeedsYouReads, planned from this
 * viewer's own capabilities and rail), the same list (buildNeedsYou) and the
 * same count (needsYouTotal, approvals included). Its lines are the list's
 * rows; the tiles stay this tab's own glance at the pipeline, the desk and
 * the routines.
 */
async function chiefOfStaffNumbers(viewer: OsViewer, routines: Read<RoutineRow[]>): Promise<DepartmentNumbers> {
  const day = operatorDayAt(new Date());
  const { plan } = briefPlanFor(viewer.surface, viewer.navInput);
  const showFinancials = viewer.surface.capabilities.canSeeCompanyFinancials && plan.money;
  const [pipeline, delivery, reads] = await Promise.all([
    loadPipeline(viewer),
    loadDelivery(viewer, false),
    loadNeedsYouReads({
      viewer: viewer.surface,
      navInput: viewer.navInput,
      plan,
      showFinancials,
      day,
      approvalsLimit: 1,
      isPlatformOperator: operatorCheck(viewer),
    }),
  ]);
  const needs = needsYouFrom(reads, day.nowMs);
  const tiles: KpiTileProps[] = [...pipelineTiles(pipeline, true)];
  if (delivery !== null) {
    if (delivery.ok) {
      const d = delivery.value;
      const open = tileCount(d.open, d.truncated);
      tiles.push(
        !d.ticketHistory
          ? noTickets(d.kind === "founder" ? "Open tickets" : "Open requests", d.kind === "founder" ? "Across every client" : "Support requests your team filed")
          : d.kind === "founder"
            ? { label: "Open tickets", value: open, status: "live", hint: "Across every client" }
            : { label: "Open requests", value: open, status: "live", hint: "Support requests your team filed" },
      );
    } else {
      tiles.push(failed("Open tickets", "Ticket read failed"));
    }
  }
  // The routines tile reads the same health as the list below it when the
  // brief read routines for this viewer; otherwise the workspace's own lane.
  tiles.push(...routineTiles(reads.routines ?? (await routineHealthFor(viewer, routines))));
  return {
    tiles,
    attention: needs.items.map((item) => ({
      id: item.id,
      label: item.title,
      href: item.href,
      count: item.count ?? 1,
      capped: item.capped === true,
    })),
    needsYou: needsYouTotal(needs),
  };
}

export async function loadDepartmentNumbers(
  dept: OsDepartment,
  viewer: OsViewer,
  routines: Read<RoutineRow[]>,
): Promise<DepartmentNumbers> {
  switch (dept.key) {
    case "chief_of_staff":
      return chiefOfStaffNumbers(viewer, routines);
    case "sales":
      return salesNumbers(viewer);
    case "marketing":
      return marketingNumbers(viewer);
    case "client_success":
      return clientSuccessNumbers(viewer);
    case "finance":
      return financeNumbers(viewer);
    case "operations":
      return operationsNumbers(viewer, routines);
    default: {
      const unhandled: never = dept.key;
      void unhandled;
      return { tiles: [], attention: [] };
    }
  }
}
