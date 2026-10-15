/** Execute one stored guided automation against its owner's current rights. */
import "server-only";

import { createHash, randomUUID } from "crypto";
import type { Client } from "@libsql/client";
import { departmentChannelFor } from "@/components/os/department/config";
import { departmentGate } from "@/components/os/department/gate";
import { loadWorkspaceConnectorStatus } from "@/components/os/connections/connector-facts";
import { resolveOsViewerFor, type OsViewer } from "@/components/os/department/viewer";
import { hasUsableKey, readWorkspaceAiAccount, type UsableAiAccount } from "@/lib/ai/workspace-account";
import { isApiEngineProvider, type ApiEngineProvider } from "@/lib/ai/agent-engine";
import { requiredConnectors, taskMessageFor, validateGuidedPayload } from "@/lib/automations/guided/validate";
import type { GuidedPayload } from "@/lib/automations/guided/types";
import { decryptField } from "@/lib/field-encryption";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { deskToolAvailability } from "@/lib/os/desk/tools";
import { liveSeat } from "@/lib/os/seat";
import { redactAll } from "@/lib/secret-redaction";
import { record_tenant_cron_run } from "@/lib/turso-rpc-shim";
import { driveAutomationRun } from "./executor";
import { startAutomationTurn, type WouldDraft } from "./automation-turn";
import {
  enqueueRun,
  ensureAutomationConversation,
  getAutomationRunForSlot,
  getRun,
  readEvents,
  recordTerminalAutomationRun,
  type Run,
  type RunScope,
} from "./store";
import type { RunSession } from "./session";
import type { RunEvent, RunStatus } from "./types";

export type GuidedAutomationRow = {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  agent_key: string;
  name: string;
  action_type: string;
  action_payload: unknown;
  enabled: unknown;
  last_scheduled_for?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type GuidedReceipt = {
  runId: string;
  automationId: string;
  scheduledFor: string | null;
  status: RunStatus;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  events: RunEvent[];
};

export type GuidedRunResult = {
  runId: string;
  status: RunStatus | "already_claimed";
  finalText: string | null;
  wouldDraft: WouldDraft[];
  receipt: GuidedReceipt | null;
};

function stableMissedRunId(automationId: string, scheduledFor: Date): string {
  const hex = createHash("sha256").update(`guided-missed:${automationId}:${scheduledFor.toISOString()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type GuidedRunDeps = {
  seat: typeof liveSeat;
  viewer: typeof resolveOsViewerFor;
  connector: typeof loadWorkspaceConnectorStatus;
  account: typeof readWorkspaceAiAccount;
  decrypt: typeof decryptField;
  drive: typeof driveAutomationRun;
  startTurn: typeof startAutomationTurn;
  recordCron: typeof record_tenant_cron_run;
};

const DEFAULT_DEPS: GuidedRunDeps = {
  seat: liveSeat,
  viewer: resolveOsViewerFor,
  connector: loadWorkspaceConnectorStatus,
  account: readWorkspaceAiAccount,
  decrypt: decryptField,
  drive: driveAutomationRun,
  startTurn: startAutomationTurn,
  recordCron: record_tenant_cron_run,
};

const OUTPUT_MAX = 8_000;

function parsePayload(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeText(value: string | null | undefined, max = OUTPUT_MAX): string | null {
  if (!value) return null;
  return redactAll(value).slice(0, max);
}

function safeEvent(event: RunEvent): RunEvent {
  const serialized = safeText(JSON.stringify(event.data), 16_000) ?? "{}";
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    data = { message: "The event details could not be displayed safely." };
  }
  return { ...event, data };
}

async function receiptFor(db: Client, scope: RunScope, run: Run): Promise<GuidedReceipt> {
  return {
    runId: run.id,
    automationId: run.automationId ?? "",
    scheduledFor: run.scheduledFor,
    status: run.status,
    errorCode: run.errorCode,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    events: (await readEvents(db, scope, run.id, 0, 500)).map(safeEvent),
  };
}

/** The sentence a person reads for a refusal or failure code (preview result, last-run line, receipts). */
export function plainFailure(code: string, detail?: string): string {
  switch (code) {
    case "owner_inactive": return "This automation's owner no longer has an active seat.";
    case "department_unavailable": return "This department or its AI teammate is no longer available to the owner.";
    case "ai_account_unavailable": return "The workspace AI account is not ready to run this automation.";
    case "tools_invalid": return "One of this automation's saved lookups is no longer allowed.";
    default:
      if (code.startsWith("missing_connection:")) return `The ${detail ?? "required"} connection is not connected.`;
      if (code.startsWith("tool_unavailable:")) return "One of this automation's lookups is not available to its owner.";
      return detail || "This saved automation can no longer be run safely.";
  }
}

async function stampResult(
  db: Client,
  deps: GuidedRunDeps,
  row: GuidedAutomationRow,
  mode: "live" | "preview",
  status: RunStatus,
  output: string | null,
  error: string | null,
): Promise<void> {
  const result = await deps.recordCron(db, {
    p_job_id: row.id,
    p_tenant_id: row.tenant_id,
    p_status: status === "done" ? "success" : "error",
    p_output: safeText(output),
    p_error: safeText(error, 1_000),
    p_increment_count: mode === "live",
  }) as { ok?: boolean; error?: string };
  if (!result?.ok) throw new Error(`guided_run_result_not_recorded:${result?.error ?? "unknown"}`);
}

async function terminalFailure(input: {
  db: Client;
  deps: GuidedRunDeps;
  row: GuidedAutomationRow;
  scope: RunScope;
  scheduledFor: Date;
  now: Date;
  mode: "live" | "preview";
  code: string;
  message: string;
  department?: string;
  agentSlug?: string;
}): Promise<GuidedRunResult> {
  const conversation = await ensureAutomationConversation(input.db, input.scope, {
    automationId: input.row.id,
    department: input.department ?? "chief_of_staff",
    agentSlug: input.agentSlug || input.row.agent_key || "unavailable",
    title: input.row.name || "Automation",
    now: input.now,
  });
  const written = await recordTerminalAutomationRun(input.db, input.scope, {
    id: randomUUID(),
    conversationId: conversation.id,
    automationId: input.row.id,
    scheduledFor: input.scheduledFor,
    origin: input.mode === "preview" ? "test" : "automation",
    status: "failed",
    text: "Guided automation preflight",
    finalText: null,
    errorCode: input.code,
    errorMessage: input.message,
    now: input.now,
  });
  if (written.created) await stampResult(input.db, input.deps, input.row, input.mode, written.run.status, null, input.message);
  return {
    runId: written.run.id,
    status: written.created ? written.run.status : "already_claimed",
    finalText: null,
    wouldDraft: [],
    receipt: await receiptFor(input.db, input.scope, written.run),
  };
}

type OwnerSeat = Extract<Awaited<ReturnType<typeof liveSeat>>, { live: true }>;
type AgentBinding = Extract<ReturnType<typeof departmentChannelFor>, { kind: "agent" }>;
type UsableAccount = UsableAiAccount & { provider: ApiEngineProvider };

export type GuidedPreflight =
  | {
      ok: true;
      seat: OwnerSeat;
      viewer: OsViewer;
      payload: GuidedPayload;
      department: (typeof OS_DEPARTMENTS)[number];
      binding: AgentBinding;
      account: UsableAccount;
      task: string;
      /** The workspace's slug, never empty (a viewer without one is refused above). */
      tenantSlug: string;
    }
  | { ok: false; code: string; detail?: string; department?: string; agentSlug?: string };

/**
 * Everything that must still be true for this automation to run NOW, checked against its OWNER's
 * current rights and the workspace's current state: the live seat, the payload (re-validated with the
 * owner's own company-financials right), the department and its AI teammate, every required
 * connection, every lookup, and the workspace AI account. Nothing is queued or written.
 *
 * ONE function for both callers: a scheduled or test run (runGuidedAutomation) and Turn on
 * (app/api/automations/guided/[id]/activate), so the rules that let a person switch it on are exactly
 * the rules that let it run.
 */
export async function preflightGuidedAutomation(input: {
  row: GuidedAutomationRow;
  now: Date;
  deps?: Partial<GuidedRunDeps>;
}): Promise<GuidedPreflight> {
  const { row, now } = input;
  const deps = { ...DEFAULT_DEPS, ...input.deps };
  const no = (code: string, detail?: string, department?: string, agentSlug?: string): GuidedPreflight => ({ ok: false, code, detail, department, agentSlug });

  if (row.action_type !== "department_task" || !row.tenant_id || !row.owner_user_id) return no("payload_invalid");

  let checked: Awaited<ReturnType<typeof liveSeat>>;
  try {
    checked = await deps.seat(row.tenant_id, row.owner_user_id);
  } catch {
    console.error("[guided.run.preflight]", { tenantId: row.tenant_id, automationId: row.id, stage: "owner_seat", code: "unavailable" });
    return no("owner_inactive");
  }
  if (!checked.live) return no("owner_inactive");
  const seat: OwnerSeat = checked;

  const viewerResult = await deps.viewer(row.tenant_id, row.owner_user_id);
  if (!viewerResult.ok) return no("owner_inactive");
  const viewer: OsViewer = viewerResult;
  const tenantSlug = viewer.surface.tenantSlug;
  if (!tenantSlug) return no("owner_inactive");
  const validation = validateGuidedPayload(parsePayload(row.action_payload), {
    companyFinancials: viewer.surface.capabilities.canSeeCompanyFinancials,
  });
  if (!validation.ok) return no(validation.error, validation.message);
  const payload: GuidedPayload = validation.payload;
  const department = OS_DEPARTMENTS.find((candidate) => candidate.key === payload.department);
  if (!department || !departmentGate(department.slug, viewer.navInput)) return no("department_unavailable", undefined, payload.department);
  const binding = departmentChannelFor(payload.department, { oasis: viewer.oasis, manifest: viewer.manifest });
  if (binding.kind !== "agent") return no("department_unavailable", undefined, payload.department);

  for (const connector of requiredConnectors(payload)) {
    let status;
    try {
      status = await deps.connector(row.tenant_id, connector, now.getTime());
    } catch {
      console.error("[guided.run.preflight]", { tenantId: row.tenant_id, automationId: row.id, stage: "connector", connector, code: "unavailable" });
      status = null;
    }
    if (status?.kind !== "connected") return no(`missing_connection:${connector}`, connector, payload.department, binding.agentSlug);
  }
  for (const tool of payload.tools) {
    if (!deskToolAvailability(tool, viewer).ok) return no(`tool_unavailable:${tool}`, undefined, payload.department, binding.agentSlug);
  }

  let account;
  try {
    account = await deps.account(row.tenant_id);
    if (!hasUsableKey(account) || !isApiEngineProvider(account.provider) || !account.model.trim()) account = null;
    else if (!deps.decrypt(account.encryptedApiKey)) account = null;
  } catch {
    console.error("[guided.run.preflight]", { tenantId: row.tenant_id, automationId: row.id, stage: "ai_account", code: "unavailable" });
    account = null;
  }
  if (!account || !hasUsableKey(account) || !isApiEngineProvider(account.provider)) {
    return no("ai_account_unavailable", undefined, payload.department, binding.agentSlug);
  }
  const task = taskMessageFor(payload);
  if (!task) return no("template_version_unknown", undefined, payload.department, binding.agentSlug);
  return { ok: true, seat, viewer, payload, department, binding, account: account as UsableAccount, task, tenantSlug };
}

/** Revalidate, claim, and execute one exact wall-clock occurrence. */
export async function runGuidedAutomation(input: {
  db: Client;
  row: GuidedAutomationRow;
  mode: "live" | "preview";
  scheduledFor: Date;
  now: Date;
  deps?: Partial<GuidedRunDeps>;
}): Promise<GuidedRunResult> {
  const { db, row, mode, scheduledFor, now } = input;
  const deps = { ...DEFAULT_DEPS, ...input.deps };
  const scope: RunScope = { tenantId: row.tenant_id, userId: row.owner_user_id };
  const fail = (code: string, detail?: string, department?: string, agentSlug?: string) => terminalFailure({
    db, deps, row, scope, scheduledFor, now, mode, code, message: plainFailure(code, detail), department, agentSlug,
  });

  const pre = await preflightGuidedAutomation({ row, now, deps: input.deps });
  if (!pre.ok) return fail(pre.code, pre.detail, pre.department, pre.agentSlug);
  const { seat, viewer, payload, department, binding, account, task, tenantSlug } = pre;

  const conversation = await ensureAutomationConversation(db, scope, {
    automationId: row.id,
    department: payload.department,
    agentSlug: binding.agentSlug,
    title: row.name,
    now,
  });
  const runId = randomUUID();
  const deadlineAt = new Date(now.getTime() + payload.runtime_cap_sec * 1_000);
  const queued = await enqueueRun(db, scope, {
    id: runId,
    conversationId: conversation.id,
    text: task,
    chatMode: "build",
    source: "automation",
    executor: "worker",
    origin: mode === "preview" ? "test" : "automation",
    automationId: row.id,
    scheduledFor,
    deadlineAt,
    runtimeEngineKind: "api",
    runtimeEngineName: account.provider,
    runtimeApiSnapshot: { provider: account.provider, model: account.model },
    showThinking: false,
    now,
  });
  if (!queued.ok) {
    if (queued.reason === "already_claimed") {
      const existing = await getAutomationRunForSlot(db, scope, row.id, scheduledFor);
      return {
        runId: existing?.id ?? "",
        status: "already_claimed",
        finalText: safeText(existing?.finalText),
        wouldDraft: [],
        receipt: existing ? await receiptFor(db, scope, existing) : null,
      };
    }
    throw new Error(`guided_run_enqueue_refused:${queued.reason}`);
  }

  const session: RunSession = {
    scope,
    email: viewer.email ?? seat.profile.email ?? "",
    tenantSlug,
    dept: department,
    operatorName: seat.profile.email?.split("@")[0] || "Owner",
    isOperator: false,
    canManageAi: seat.profile.isOwner || seat.profile.adminAccess || ["owner", "admin"].includes(seat.profile.teamRole),
    fallback: null,
    viewer,
    bridge: null,
    computerDispatch: null,
    apiEngineChoice: { kind: "api", provider: account.provider },
    apiAccountSnapshot: { provider: account.provider, model: account.model },
    engineChangedAt: null,
    fallbackFrom: null,
    fallbackReason: null,
  };
  const wouldDraft: WouldDraft[] = [];
  await deps.drive({
    db,
    scope,
    departmentLabel: department.label,
    deadlineMs: payload.runtime_cap_sec * 1_000,
    now: () => now,
    startTurn: ({ run, signal }) => deps.startTurn({
      session, payload, mode, automationId: row.id, automationName: row.name, run, signal, wouldDraft,
    }),
    recordOutcome: async () => undefined,
  }, conversation.id, runId);
  const finished = await getRun(db, scope, runId);
  if (!finished) throw new Error("guided_run_receipt_missing");
  const finalText = safeText(finished.finalText);
  const lastError = finished.errorCode ? `${finished.errorCode}: ${plainFailure(finished.errorCode)}` : null;
  await stampResult(db, deps, row, mode, finished.status, finalText, lastError);
  return {
    runId,
    status: finished.status,
    finalText,
    wouldDraft,
    receipt: await receiptFor(db, scope, finished),
  };
}

/** Record an occurrence too old to replay. The deterministic run id makes the
 * migration 213 index's `status <> 'missed'` exception overlap-safe. */
export async function recordMissedGuidedAutomation(input: {
  db: Client;
  row: GuidedAutomationRow;
  scheduledFor: Date;
  now: Date;
}): Promise<{ runId: string; created: boolean }> {
  const scope: RunScope = { tenantId: input.row.tenant_id, userId: input.row.owner_user_id };
  const raw = parsePayload(input.row.action_payload) as { department?: unknown } | null;
  const department = typeof raw?.department === "string" && OS_DEPARTMENTS.some((d) => d.key === raw.department)
    ? raw.department
    : "chief_of_staff";
  const conversation = await ensureAutomationConversation(input.db, scope, {
    automationId: input.row.id,
    department,
    agentSlug: input.row.agent_key || "unavailable",
    title: input.row.name || "Automation",
    now: input.now,
  });
  const result = await recordTerminalAutomationRun(input.db, scope, {
    id: stableMissedRunId(input.row.id, input.scheduledFor),
    conversationId: conversation.id,
    automationId: input.row.id,
    scheduledFor: input.scheduledFor,
    origin: "automation",
    status: "missed",
    text: "Scheduled occurrence",
    finalText: "This scheduled occurrence was missed and was not replayed.",
    errorCode: null,
    errorMessage: null,
    now: input.now,
  });
  return { runId: result.run.id, created: result.created };
}
