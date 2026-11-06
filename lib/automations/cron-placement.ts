export type CronPlacementDestination = "cloud" | "vps" | "retired" | "off";

export type CronPlacementPhase = "moving" | "recommended" | "deferred";

export type CronPlacementState = Readonly<{
  destination: CronPlacementDestination;
  phase: CronPlacementPhase;
  label: string;
  detail: string;
}>;

export type CronPlacementDefinition = CronPlacementState & Readonly<{ name: string }>;

const PRESENTATION: Readonly<Record<CronPlacementDestination, Omit<CronPlacementState, "destination">>> = {
  cloud: {
    phase: "moving",
    label: "Moving to Cloudflare",
    detail:
      "This computer-era schedule is moving to Cloudflare. Its stored run state is historical during cutover.",
  },
  vps: {
    phase: "moving",
    label: "Moving to daemon VPS",
    detail:
      "This computer-era schedule is moving to the daemon VPS. Its stored run state is historical during cutover.",
  },
  retired: {
    phase: "recommended",
    label: "Retirement recommended",
    detail:
      "Retirement is recommended and awaits CC's decision. This legacy card cannot be restarted here.",
  },
  off: {
    phase: "deferred",
    label: "Off / deferred",
    detail:
      "This automation is off or deferred by the migration plan. This legacy card cannot be restarted here.",
  },
};

function placement(
  name: string,
  destination: CronPlacementDestination,
): CronPlacementDefinition {
  return Object.freeze({ name, destination, ...PRESENTATION[destination] });
}

/**
 * The operator-approved reconciliation of every OASIS `cron_jobs` row that
 * existed on 2026-10-30. This is display/control metadata only: it does not
 * mutate a schedule or claim that a proposed retirement has been approved.
 */
export const OASIS_CRON_PLACEMENTS: readonly CronPlacementDefinition[] = Object.freeze([
  placement("Bravo — Hourly Cron Health Check", "cloud"),
  placement("Bravo — Nightly Harness Eval", "cloud"),
  placement("Daily Automation Register", "cloud"),
  placement("Daily Bravo Brief", "cloud"),
  placement("Library Post Linker", "cloud"),
  placement("Library Reviews Sync", "cloud"),
  placement("Marketing Publish Drain", "cloud"),
  placement("Monthly Inventory Sync", "cloud"),
  placement("Post Analytics Sync", "cloud"),
  placement("Service Checks (Connections)", "cloud"),
  placement("Weekly Eval Suites", "cloud"),
  placement("Weekly Event Bus Retention", "cloud"),

  placement("Content Tools Runner", "vps"),
  placement("Daily Log Rotation Audit", "vps"),
  placement("Daily State DB Backup", "vps"),
  placement("Event Bus Offline Drain", "vps"),
  placement("Inbound Email Sweep", "vps"),
  placement("Weekly Receipts Reconciliation", "vps"),
  placement("Weekly tmp/ Hygiene", "vps"),

  placement("Booking Reminders", "retired"),
  placement("Bravo — Cross-Agent Review Scan", "retired"),
  placement("Daily Briefing Snapshot", "retired"),
  placement("Daily Client Alerts Snapshot", "retired"),
  placement("Funnel Fast-Poll", "retired"),
  placement("Loud Failures Weekly Probe", "retired"),
  placement("Nurture Sequence Check", "retired"),
  placement("Weekly Full-Truth Health Digest", "retired"),
  placement("Weekly Pipeline Review", "retired"),

  placement("Bravo — Review Harvest", "off"),
  placement("Bravo — Sleep Agent (Memory Consolidation)", "off"),
  placement("Break-Glass Drill (quarterly)", "off"),
  placement("Carousel Media Retention", "off"),
  placement("Cross-Agent Self-Improvement Sweep", "off"),
  placement("Daily MRR Auto-Sync", "off"),
  placement("Daily Memory Index Rebuild", "off"),
  placement("Daily Pulse Mechanical Refresh", "off"),
  placement("Frontier Radar Weekly Sweep", "off"),
  placement("LanceDB Compaction (weekly)", "off"),
  placement("Maven — Carousel Post", "off"),
  placement("OASIS Auto-Score Leads", "off"),
  placement("Training Corpus Ingest", "off"),
]);

function placementKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

const placementByName = new Map<string, CronPlacementState>();
for (const { name, ...state } of OASIS_CRON_PLACEMENTS) {
  const key = placementKey(name);
  if (placementByName.has(key)) {
    throw new Error(`duplicate_cron_placement:${name}`);
  }
  placementByName.set(key, Object.freeze(state));
}

export function cronPlacementForName(name: string): CronPlacementState | null {
  return placementByName.get(placementKey(name)) ?? null;
}

export function isCronPlacementState(value: unknown): value is CronPlacementState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const pairIsValid =
    ((state.destination === "cloud" || state.destination === "vps") && state.phase === "moving") ||
    (state.destination === "retired" && state.phase === "recommended") ||
    (state.destination === "off" && state.phase === "deferred");
  return (
    pairIsValid &&
    typeof state.label === "string" &&
    state.label.trim().length > 0 &&
    typeof state.detail === "string" &&
    state.detail.trim().length > 0
  );
}
