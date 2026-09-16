import type { DaemonState } from "./daemon-backed-crons";

export type CronInventorySource = "tenant" | "empire";

export type CronInventoryJob = {
  id: string;
  agent_key: string;
  name: string;
  description: string | null;
  schedule: string;
  action_type: string;
  action_payload: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at?: string | null;
  last_run_status: "success" | "error" | null;
  last_run_output: string | null;
  last_run_error: string | null;
  run_count: number;
  unresolved_failures?: number;
  created_at: string;
  updated_at: string;
  source: CronInventorySource;
  daemon?: DaemonState | null;
};

export type AutomationInventoryMetadata = {
  lanes: {
    tenant: { queried: true; count: number };
    empire: { queried: boolean; count: number };
  };
  total_count: number;
  distinct_source_id_count: number;
};

type InventoryIdentity = Pick<CronInventoryJob, "id" | "source">;
type OwnedInventoryIdentity = InventoryIdentity & Pick<CronInventoryJob, "agent_key">;

export class AutomationInventoryError extends Error {
  constructor(
    public readonly code: "duplicate_automation_inventory_key" | "incomplete_automation_inventory",
    public readonly status: 500 | 503,
    message: string,
  ) {
    super(message);
    this.name = "AutomationInventoryError";
  }
}

export function cronJobKey(job: InventoryIdentity): string {
  if ((job.source !== "tenant" && job.source !== "empire") || typeof job.id !== "string" || !job.id) {
    throw new Error("invalid_automation_identity");
  }
  return `${job.source}:${job.id}`;
}

/**
 * Build the server's inventory receipt. A plausible partial list is more
 * dangerous than an explicit outage, so operator reads require a non-empty
 * Empire lane and duplicate source:id identities fail closed.
 */
export function buildAutomationInventoryMetadata(input: {
  tenantJobs: InventoryIdentity[];
  empireJobs: InventoryIdentity[];
  empireQueried: boolean;
  requireEmpireRows: boolean;
}): AutomationInventoryMetadata {
  if (input.requireEmpireRows && (!input.empireQueried || input.empireJobs.length === 0)) {
    throw new AutomationInventoryError(
      "incomplete_automation_inventory",
      503,
      "Operator inventory is incomplete because the Empire lane returned zero rows.",
    );
  }

  const allJobs = [...input.tenantJobs, ...input.empireJobs];
  const keys = allJobs.map(cronJobKey);
  const distinctKeys = new Set(keys);
  if (distinctKeys.size !== keys.length) {
    const seen = new Set<string>();
    const duplicate = keys.find((key) => (seen.has(key) ? true : (seen.add(key), false)));
    throw new AutomationInventoryError(
      "duplicate_automation_inventory_key",
      500,
      `Inventory contains a duplicate row identity: ${duplicate ?? "unknown"}.`,
    );
  }

  return {
    lanes: {
      tenant: { queried: true, count: input.tenantJobs.length },
      empire: { queried: input.empireQueried, count: input.empireJobs.length },
    },
    total_count: allJobs.length,
    distinct_source_id_count: distinctKeys.size,
  };
}

export type OwnerPartition<T> = {
  key: string;
  jobs: T[];
};

/**
 * Partition by exact normalized owner. Prefix matching made `bravo-ops` also
 * appear under `bravo`; this helper guarantees every source:id lands once.
 */
export function partitionCronJobsByOwner<T extends OwnedInventoryIdentity>(
  jobs: T[],
  agentKeys: string[],
): OwnerPartition<T>[] {
  const seenRows = new Set<string>();
  for (const job of jobs) {
    const key = cronJobKey(job);
    if (seenRows.has(key)) throw new Error(`duplicate_automation_key:${key}`);
    seenRows.add(key);
  }

  const owners = [...new Set(agentKeys.map((key) => key.trim().toLowerCase()).filter(Boolean))];
  const knownOwners = new Set(owners);
  const groups = owners.map((key) => ({
    key,
    jobs: jobs.filter((job) => job.agent_key.trim().toLowerCase() === key),
  }));
  const other = jobs.filter((job) => !knownOwners.has(job.agent_key.trim().toLowerCase()));
  if (other.length > 0) groups.push({ key: "other", jobs: other });
  return groups;
}

export type DaemonConfirmationBaseline = {
  key: string;
  state: DaemonState["state"];
  last_ping_at: string | null;
};

/**
 * A supervisor command is only confirmed when the same source:id reports the
 * requested state on a heartbeat newer than the one visible before the click.
 * The command response itself is merely acceptance, not proof of runtime state.
 */
export function isDaemonTransitionConfirmed(
  job: CronInventoryJob,
  requestedState: "running" | "stopped",
  baseline: DaemonConfirmationBaseline,
): boolean {
  if (cronJobKey(job) !== baseline.key || !job.daemon) return false;
  if (job.daemon.state !== requestedState || job.daemon.state === baseline.state) return false;
  const readbackPing = job.daemon.last_ping_at;
  if (!readbackPing) return false;
  const readbackTime = Date.parse(readbackPing);
  if (!Number.isFinite(readbackTime)) return false;
  if (!baseline.last_ping_at) return true;
  const baselineTime = Date.parse(baseline.last_ping_at);
  return Number.isFinite(baselineTime)
    ? readbackTime > baselineTime
    : readbackPing !== baseline.last_ping_at;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCronInventoryJob(value: unknown): value is CronInventoryJob {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" && value.id.length > 0 &&
    (value.source === "tenant" || value.source === "empire") &&
    typeof value.agent_key === "string" && value.agent_key.length > 0 &&
    typeof value.name === "string" &&
    isNullableString(value.description) &&
    typeof value.schedule === "string" &&
    typeof value.action_type === "string" &&
    isRecord(value.action_payload) &&
    typeof value.enabled === "boolean" &&
    isNullableString(value.last_run_at) &&
    (value.next_run_at === undefined || isNullableString(value.next_run_at)) &&
    (value.last_run_status === null || value.last_run_status === "success" || value.last_run_status === "error") &&
    isNullableString(value.last_run_output) &&
    isNullableString(value.last_run_error) &&
    typeof value.run_count === "number" && Number.isFinite(value.run_count) &&
    (value.unresolved_failures === undefined ||
      (typeof value.unresolved_failures === "number" &&
        Number.isInteger(value.unresolved_failures) &&
        value.unresolved_failures >= 0)) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (value.daemon === undefined || value.daemon === null || isDaemonState(value.daemon))
  );
}

function isDaemonState(value: unknown): value is DaemonState {
  if (!isRecord(value)) return false;
  return (
    typeof value.service === "string" &&
    typeof value.process_name === "string" &&
    typeof value.label === "string" &&
    typeof value.why === "string" &&
    typeof value.stop_warning === "string" &&
    (value.state === "running" || value.state === "stopped" || value.state === "degraded" || value.state === "unknown") &&
    isNullableString(value.reported_status) &&
    isNullableString(value.last_ping_at) &&
    typeof value.stale === "boolean"
  );
}

function parseInventoryMetadata(value: unknown): AutomationInventoryMetadata | null {
  if (!isRecord(value) || !isRecord(value.lanes)) return null;
  const tenant = value.lanes.tenant;
  const empire = value.lanes.empire;
  if (!isRecord(tenant) || !isRecord(empire)) return null;
  if (tenant.queried !== true || typeof tenant.count !== "number" || !Number.isInteger(tenant.count) || tenant.count < 0) return null;
  if (typeof empire.queried !== "boolean" || typeof empire.count !== "number" || !Number.isInteger(empire.count) || empire.count < 0) return null;
  if (typeof value.total_count !== "number" || !Number.isInteger(value.total_count) || value.total_count < 0) return null;
  if (typeof value.distinct_source_id_count !== "number" || !Number.isInteger(value.distinct_source_id_count) || value.distinct_source_id_count < 0) return null;
  return value as AutomationInventoryMetadata;
}

export function parseAutomationInventorySuccess(value: unknown):
  | { ok: true; jobs: CronInventoryJob[]; inventory: AutomationInventoryMetadata }
  | { ok: false; error: string } {
  if (!isRecord(value) || value.ok !== true) {
    return { ok: false, error: "response did not declare ok:true" };
  }
  if (!Array.isArray(value.jobs) || !value.jobs.every(isCronInventoryJob)) {
    return { ok: false, error: "jobs is missing or contains an invalid row" };
  }
  const inventory = parseInventoryMetadata(value.inventory);
  if (!inventory) return { ok: false, error: "inventory metadata is missing or invalid" };

  const keys = value.jobs.map(cronJobKey);
  const distinctCount = new Set(keys).size;
  const tenantCount = value.jobs.filter((job) => job.source === "tenant").length;
  const empireCount = value.jobs.filter((job) => job.source === "empire").length;
  if (
    distinctCount !== value.jobs.length ||
    inventory.total_count !== value.jobs.length ||
    inventory.distinct_source_id_count !== distinctCount ||
    inventory.lanes.tenant.count !== tenantCount ||
    inventory.lanes.empire.count !== empireCount ||
    (!inventory.lanes.empire.queried && empireCount !== 0)
  ) {
    return { ok: false, error: "inventory metadata does not match the returned rows" };
  }
  return { ok: true, jobs: value.jobs, inventory };
}
