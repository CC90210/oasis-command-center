import type { DaemonState, RetiredCronState } from "./daemon-backed-crons";

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
  // `unknown` is the third verdict lib/cron-empire-row.ts returns for a stored
  // result that cannot carry one (a truncated `}` tail). It must survive the
  // wire, because collapsing it into `success` is exactly the green tick the
  // row has not earned.
  // `skipped`: the scheduler did not run the slot (the PC was off). Not a verdict
  // on the job, so it must not collapse into `success` (a tick) or `error`.
  last_run_status: "success" | "error" | "unknown" | "skipped" | null;
  last_run_output: string | null;
  last_run_error: string | null;
  /** Plain-English line for a `skipped` result (lib/cron-empire-row.ts explainSkippedResult). */
  last_run_note?: string | null;
  /**
   * Empire rows: what the latest tick was when it was NOT a real run
   * (lib/cron-empire-row.ts attemptKindOf). Set even when unresolved failures
   * keep last_run_status at "error", because the card's colour follows the
   * latest tick and a skip never paints it red.
   */
  last_attempt_kind?: "missed" | "skipped" | "deferred" | null;
  /** Empire rows: the stored last_result verbatim, whatever the verdict. Shown only under Details. */
  last_result_text?: string | null;
  run_count: number;
  unresolved_failures?: number;
  created_at: string;
  updated_at: string;
  source: CronInventorySource;
  daemon?: DaemonState | null;
  /** A historical daemon-owned row that remains fenced but has no live control. */
  retired?: RetiredCronState | null;
  /**
   * O2: who this row belongs to. `null`/absent is a LEGACY row with no
   * recorded owner (a workspace that predates owner_user_id, or a non-OASIS
   * tenant row the migration's backfill could not resolve) — the GET route
   * treats it as everyone's to manage, same as before O2. An empire row
   * never carries this: house-lane ownership is the one workspace_agents_owner
   * row (lib/agents-owner.ts), not a per-row fact.
   */
  owner_user_id?: string | null;
  /** Set only on a `team` row (requirement A): the owner's display name, for
   *  "whose automation is this" — never anything an edit needs. */
  owner_name?: string | null;
};

export type AutomationInventoryMetadata = {
  lanes: {
    /** The caller's OWN rows ("yours"): owner_user_id = the caller, or a
     *  legacy row with no recorded owner. */
    tenant: { queried: true; count: number };
    /**
     * Everyone else's rows (requirement A's "team" list) — present only for
     * an owner/admin. `queried: false` with `count: 0` for anyone else, never
     * omitted, so a member who is not an owner/admin can tell "nothing to
     * show" apart from "the route didn't bother to ask".
     */
    team: { queried: boolean; count: number };
    empire: { queried: boolean; count: number };
  };
  total_count: number;
  distinct_source_id_count: number;
  /**
   * O2 (2026-10-11): was this session recognized as this workspace's AGENTS
   * OWNER, and therefore entitled to the Empire (house) lane at all? Renamed
   * in meaning, not in wire shape, from the pre-O2 "was this session the
   * platform operator" — every Empire guarantee in this file (the non-empty
   * requirement, the fail-loud 500) is armed by this ONE verdict, so an
   * identity it does not cover disarms all of them at once and the tab
   * returns a perfectly valid, perfectly plausible tenant-only 200. Adon is a
   * verified platform operator (PR #576) but is NOT CCPC's owner, so the old
   * `isOperator`-keyed predicate would have handed him the house lane the
   * instant he was promoted — the exact leak O2 exists to close. CC cannot
   * tell a withheld house lane apart from "every house schedule was deleted"
   * unless the verdict travels on the wire, which is what this field is for.
   */
  empire_included: boolean;
  /** Whether the `team` array was computed at all (an owner/admin session). */
  team_included: boolean;
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
  /** O2: everyone else's rows (requirement A's "team" list); [] when the
   *  caller is not an owner/admin, or there is nobody else's row to show. */
  teamJobs?: InventoryIdentity[];
  teamQueried?: boolean;
  empireJobs: InventoryIdentity[];
  empireQueried: boolean;
  requireEmpireRows: boolean;
  /** O2: is this session this workspace's agents owner? Drives
   *  `empire_included` — see that field's doc comment for why the name did
   *  not change on the wire even though what it answers did. */
  isAgentsOwner: boolean;
}): AutomationInventoryMetadata {
  if (input.requireEmpireRows && (!input.empireQueried || input.empireJobs.length === 0)) {
    throw new AutomationInventoryError(
      "incomplete_automation_inventory",
      503,
      "Operator inventory is incomplete because the Empire lane returned zero rows.",
    );
  }

  const teamJobs = input.teamJobs ?? [];
  const allJobs = [...input.tenantJobs, ...teamJobs, ...input.empireJobs];
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
      team: { queried: input.teamQueried ?? false, count: teamJobs.length },
      empire: { queried: input.empireQueried, count: input.empireJobs.length },
    },
    // total_count / distinct_source_id_count describe `jobs` on the wire
    // (tenant + empire) — team travels in its own array, counted by
    // lanes.team, so a client that ignores `team` entirely still sees a
    // total that matches `jobs.length` exactly. The duplicate check above
    // already ran across ALL three (tenant + team + empire), so by this line
    // distinctKeys.size equals allJobs.length and the two counts below are
    // equal by construction.
    total_count: input.tenantJobs.length + input.empireJobs.length,
    distinct_source_id_count: distinctKeys.size - teamJobs.length,
    empire_included: input.isAgentsOwner,
    team_included: input.teamQueried ?? false,
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
  const hasDaemon = value.daemon !== undefined && value.daemon !== null;
  const hasRetired = value.retired !== undefined && value.retired !== null;
  if (hasDaemon && !isDaemonState(value.daemon)) return false;
  if (hasRetired && !isRetiredCronState(value.retired)) return false;
  // Process-owned lifecycle is an Empire-only parked-row contract. Never let
  // a contradictory payload hide an armed schedule behind a retired badge.
  if ((hasDaemon || hasRetired) && (value.source !== "empire" || value.enabled !== false)) return false;
  if (hasDaemon && hasRetired) return false;
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
    (value.last_run_status === null || value.last_run_status === "success" ||
      value.last_run_status === "error" || value.last_run_status === "unknown" ||
      value.last_run_status === "skipped") &&
    isNullableString(value.last_run_output) &&
    isNullableString(value.last_run_error) &&
    (value.last_run_note === undefined || isNullableString(value.last_run_note)) &&
    (value.last_attempt_kind === undefined || value.last_attempt_kind === null ||
      value.last_attempt_kind === "missed" || value.last_attempt_kind === "skipped" ||
      value.last_attempt_kind === "deferred") &&
    (value.last_result_text === undefined || isNullableString(value.last_result_text)) &&
    typeof value.run_count === "number" && Number.isFinite(value.run_count) &&
    (value.unresolved_failures === undefined ||
      (typeof value.unresolved_failures === "number" &&
        Number.isInteger(value.unresolved_failures) &&
        value.unresolved_failures >= 0)) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string" &&
    (value.daemon === undefined || value.daemon === null || hasDaemon) &&
    (value.retired === undefined || value.retired === null || hasRetired) &&
    (value.owner_user_id === undefined || isNullableString(value.owner_user_id)) &&
    (value.owner_name === undefined || isNullableString(value.owner_name))
  );
}

function isRetiredCronState(value: unknown): value is RetiredCronState {
  return isRecord(value) && typeof value.label === "string" && typeof value.reason === "string";
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
  const team = value.lanes.team;
  const empire = value.lanes.empire;
  if (!isRecord(tenant) || !isRecord(team) || !isRecord(empire)) return null;
  if (tenant.queried !== true || typeof tenant.count !== "number" || !Number.isInteger(tenant.count) || tenant.count < 0) return null;
  if (typeof team.queried !== "boolean" || typeof team.count !== "number" || !Number.isInteger(team.count) || team.count < 0) return null;
  if (typeof empire.queried !== "boolean" || typeof empire.count !== "number" || !Number.isInteger(empire.count) || empire.count < 0) return null;
  if (typeof value.total_count !== "number" || !Number.isInteger(value.total_count) || value.total_count < 0) return null;
  if (typeof value.distinct_source_id_count !== "number" || !Number.isInteger(value.distinct_source_id_count) || value.distinct_source_id_count < 0) return null;
  // Required, not optional-with-a-default. A missing field defaulted to `true`
  // would re-create the silence; defaulted to `false` it would cry operator on
  // every tenant. An older server that does not send it is a server whose
  // Empire verdict this client cannot state, so the read fails and says so.
  if (typeof value.empire_included !== "boolean") return null;
  if (typeof value.team_included !== "boolean") return null;
  return value as AutomationInventoryMetadata;
}

export function parseAutomationInventorySuccess(value: unknown):
  | { ok: true; jobs: CronInventoryJob[]; team: CronInventoryJob[]; inventory: AutomationInventoryMetadata }
  | { ok: false; error: string } {
  if (!isRecord(value) || value.ok !== true) {
    return { ok: false, error: "response did not declare ok:true" };
  }
  if (!Array.isArray(value.jobs) || !value.jobs.every(isCronInventoryJob)) {
    return { ok: false, error: "jobs is missing or contains an invalid row" };
  }
  // `team` (requirement A) travels as its OWN array, not folded into `jobs`,
  // so a client that groups `jobs` by agent never has to first strip out rows
  // it must only ever let the owner switch off. Missing entirely reads as
  // "not an owner/admin" (team_included says so explicitly below), never as
  // an invalid response — an older server that never sends it is not this.
  const rawTeam = (value as { team?: unknown }).team;
  const team = rawTeam === undefined ? [] : rawTeam;
  if (!Array.isArray(team) || !team.every(isCronInventoryJob)) {
    return { ok: false, error: "team is present but contains an invalid row" };
  }
  const inventory = parseInventoryMetadata(value.inventory);
  if (!inventory) return { ok: false, error: "inventory metadata is missing or invalid" };

  const allKeys = [...value.jobs, ...team].map(cronJobKey);
  const distinctCount = new Set(allKeys).size;
  const tenantCount = value.jobs.filter((job) => job.source === "tenant").length;
  const empireCount = value.jobs.filter((job) => job.source === "empire").length;
  if (
    distinctCount !== allKeys.length ||
    inventory.total_count !== value.jobs.length ||
    inventory.distinct_source_id_count !== value.jobs.length ||
    inventory.lanes.tenant.count !== tenantCount ||
    inventory.lanes.team.count !== team.length ||
    inventory.lanes.empire.count !== empireCount ||
    (!inventory.lanes.team.queried && team.length !== 0) ||
    (!inventory.team_included && team.length !== 0) ||
    (!inventory.lanes.empire.queried && empireCount !== 0) ||
    // Empire rows arriving under a non-owner verdict is incoherent in either
    // direction: either the route leaked rows the caller is not entitled to, or
    // it mislabeled a caller who is. Both are the kind of contradiction that
    // should stop the render, not decorate it.
    (!inventory.empire_included && empireCount !== 0)
  ) {
    return { ok: false, error: "inventory metadata does not match the returned rows" };
  }
  return { ok: true, jobs: value.jobs, team, inventory };
}
