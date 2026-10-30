/** Run one authenticated CC Telegram message on the exact saved computer. */
import "server-only";
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type { AgentEngineChoice } from "@/lib/ai/agent-engine";
import type { RunSession } from "@/lib/os/runs/session";
import type { executorDepsFor } from "@/lib/os/runs/turn-starter";
import type { sendMessage } from "@/lib/os/runs/send";
import { OASIS_TELEGRAM_TENANT_ID, type OasisTelegramJob } from "./protocol";

export type TelegramDeviceTurnResult =
  | { outcome: "completed"; text: string }
  | { outcome: "no_computer"; reason: string }
  | { outcome: "retry"; reason: string };

type DeviceEngine = Exclude<AgentEngineChoice, { kind: "api" }>;

export type TelegramDeviceContext = {
  session: RunSession;
  engine: DeviceEngine;
  agentSlug: string;
  userId: string;
};

type ContextResult =
  | { ok: true; context: TelegramDeviceContext }
  | { ok: false; outcome: "no_computer" | "retry"; reason: string };

export type TelegramDeviceTurnDeps = {
  resolveContext?: (db: Client) => Promise<ContextResult>;
  send?: typeof sendMessage;
  executor?: typeof executorDepsFor;
};

function stableUuid(namespace: string, userId: string, updateId: number): string {
  const hex = createHash("sha256")
    .update(`oasis:telegram:${namespace}:${OASIS_TELEGRAM_TENANT_ID}:${userId}:${updateId}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function telegramDeviceRunIdentity(userId: string, updateId: number): { conversationId: string; runId: string } {
  return {
    conversationId: stableUuid("conversation", userId, updateId),
    runId: stableUuid("run", userId, updateId),
  };
}

export function telegramPrompt(text: string): string {
  return [
    "[CC sent this through the authenticated private OASIS Telegram chat.",
    "Answer CC directly in concise plain text suitable for Telegram.",
    "This turn must run only on the saved paired computer; no hosted API fallback is permitted.]",
    "",
    text,
  ].join("\n");
}

function engineIdentity(engine: DeviceEngine): { kind: "cli" | "local"; name: string; pairingId: string | null } {
  return engine.kind === "cli"
    ? { kind: "cli", name: engine.cli, pairingId: engine.pairingId || null }
    : { kind: "local", name: engine.model, pairingId: engine.pairingId || null };
}

async function resolveDefaultContext(_db: Client): Promise<ContextResult> {
  try {
    const [
      { readAgentsOwner },
      { readEffectiveAgentEngine },
      { departmentChannelFor },
      { resolveOsViewerFor },
      { getWorkspaceManifest },
      { resolveOwnedSlug },
      { OS_DEPARTMENTS },
      { liveSeat },
      { getServiceSupabase },
      { adminGetUser },
      { resolveRunSession },
      { isOasisSurfaceTenant },
    ] = await Promise.all([
      import("@/lib/agents-owner"),
      import("@/lib/ai/agent-engine-store"),
      import("@/components/os/department/config"),
      import("@/components/os/department/viewer"),
      import("@/lib/manifest/loader"),
      import("@/lib/manifest/tenant-scope"),
      import("@/lib/os/departments"),
      import("@/lib/os/seat"),
      import("@/lib/supabase-server"),
      import("@/lib/turso-auth-admin"),
      import("@/lib/os/runs/session"),
      import("@/lib/role-surfaces"),
    ]);
    const owner = await readAgentsOwner(OASIS_TELEGRAM_TENANT_ID);
    if (owner.state !== "set") return { ok: false, outcome: "retry", reason: `agents_owner_${owner.state}` };
    const seat = await liveSeat(OASIS_TELEGRAM_TENANT_ID, owner.authUserId);
    if (!seat.live || !seat.profile.isOwner) {
      return {
        ok: false,
        outcome: "retry",
        reason: seat.live ? "oasis_owner_not_owner" : `oasis_owner_${seat.reason}`,
      };
    }
    const auth = await adminGetUser(getServiceSupabase(), owner.authUserId);
    if (!auth.ok) return { ok: false, outcome: "retry", reason: "oasis_owner_auth_unavailable" };
    const viewer = await resolveOsViewerFor(OASIS_TELEGRAM_TENANT_ID, owner.authUserId);
    if (!viewer.ok) return { ok: false, outcome: "retry", reason: `oasis_owner_viewer_${viewer.reason}` };

    const tenantSlug = ((await resolveOwnedSlug(OASIS_TELEGRAM_TENANT_ID)) || "").trim().toLowerCase();
    if (!tenantSlug || !isOasisSurfaceTenant(tenantSlug)) {
      return { ok: false, outcome: "retry", reason: "oasis_workspace_unavailable" };
    }
    const dept = OS_DEPARTMENTS.find((candidate) => candidate.key === "chief_of_staff");
    if (!dept) return { ok: false, outcome: "retry", reason: "chief_of_staff_unavailable" };
    const manifest = await getWorkspaceManifest(OASIS_TELEGRAM_TENANT_ID, tenantSlug);
    const binding = departmentChannelFor(dept.key, { oasis: true, manifest });
    if (binding.kind !== "agent") return { ok: false, outcome: "retry", reason: "chief_of_staff_not_configured" };

    const canonical = await readEffectiveAgentEngine(OASIS_TELEGRAM_TENANT_ID, null);
    if (canonical.engine.kind === "api") {
      return { ok: false, outcome: "no_computer", reason: "saved_engine_is_api" };
    }
    const expected = engineIdentity(canonical.engine);
    if (!expected.pairingId) return { ok: false, outcome: "no_computer", reason: "computer_choice_needs_pairing" };

    const resolved = await resolveRunSession({
      department: dept.key,
      actor: {
        tenantId: OASIS_TELEGRAM_TENANT_ID,
        user: { id: owner.authUserId, email: auth.value.email },
        profile: {
          team_role: seat.profile.teamRole,
          is_owner: seat.profile.isOwner,
          admin_access: seat.profile.adminAccess,
          display_name: auth.value.fullName,
          full_name: auth.value.fullName,
        },
        viewer,
        engineUserId: null,
        operatorName: auth.value.fullName || "CC",
      },
    });
    if (!resolved.ok) {
      return {
        ok: false,
        outcome: resolved.status === 409 ? "no_computer" : "retry",
        reason: resolved.error,
      };
    }
    const dispatch = resolved.session.computerDispatch;
    if (
      !dispatch ||
      dispatch.pairingId !== expected.pairingId ||
      dispatch.engineKind !== expected.kind ||
      dispatch.engineName !== expected.name
    ) {
      // This includes an immediate workspace-API fallback. Telegram never takes it.
      return { ok: false, outcome: "no_computer", reason: "exact_computer_unavailable" };
    }
    return {
      ok: true,
      context: {
        session: {
          ...resolved.session,
          computerDispatch: { ...dispatch, fallback: "none" },
          apiAccountSnapshot: null,
          fallbackFrom: null,
          fallbackReason: null,
        },
        engine: canonical.engine,
        agentSlug: binding.agentSlug,
        userId: owner.authUserId,
      },
    };
  } catch (error) {
    console.error(
      "[oasis-telegram.device] context resolution failed",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return { ok: false, outcome: "retry", reason: "device_context_unavailable" };
  }
}

function sseFrames(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.split(/\r?\n\r?\n/).flatMap((frame) => {
    let event = "message";
    let data = "";
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return [];
    try {
      const parsed = JSON.parse(data) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? [{ event, data: parsed as Record<string, unknown> }]
        : [];
    } catch {
      return [];
    }
  });
}

function responseError(raw: string, status: number): string {
  try {
    const parsed = JSON.parse(raw) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : `http_${status}`;
  } catch {
    return `http_${status}`;
  }
}

const NO_COMPUTER_ERRORS = new Set([
  "computer_not_connected",
  "computer_not_answering",
  "computer_not_approved",
  "computer_offline",
  "computer_choice_needs_pairing",
  "department_profile_unsupported",
  "engine_dispatch_unavailable",
  "subscription_auth_failure",
  "subscription_limit",
  "cli_not_found",
  "cli_account_unsupported",
]);

export async function runOasisTelegramDeviceTurn(
  db: Client,
  job: OasisTelegramJob,
  deps: TelegramDeviceTurnDeps = {},
): Promise<TelegramDeviceTurnResult> {
  const resolved = await (deps.resolveContext ?? resolveDefaultContext)(db);
  if (!resolved.ok) return { outcome: resolved.outcome, reason: resolved.reason };
  const { session, engine, agentSlug, userId } = resolved.context;
  const expected = engineIdentity(engine);
  const dispatch = session.computerDispatch;
  if (
    !dispatch ||
    !expected.pairingId ||
    dispatch.pairingId !== expected.pairingId ||
    dispatch.engineKind !== expected.kind ||
    dispatch.engineName !== expected.name
  ) {
    return { outcome: "no_computer", reason: "exact_computer_unavailable" };
  }
  const safeDispatch = { ...dispatch, fallback: "none" as const };
  const safeSession: RunSession = {
    ...session,
    computerDispatch: safeDispatch,
    apiAccountSnapshot: null,
    fallbackFrom: null,
    fallbackReason: null,
  };
  try {
    const send = deps.send ?? (await import("@/lib/os/runs/send")).sendMessage;
    const executor = deps.executor ?? (await import("@/lib/os/runs/turn-starter")).executorDepsFor;
    const response = await send({
      db,
      deps: executor(safeSession, db),
      showThinking: false,
      input: {
        department: safeSession.dept.key,
        agentSlug,
        text: telegramPrompt(job.text),
        conversationId: "",
        chatMode: "build",
      },
      computerDispatch: safeDispatch,
      apiAccountSnapshot: null,
      fallbackFrom: null,
      fallbackReason: null,
      idempotency: telegramDeviceRunIdentity(userId, job.updateId),
    });
    const raw = await response.text();
    if (response.status === 202) return { outcome: "retry", reason: "device_still_running" };
    if (!response.ok) {
      const error = responseError(raw, response.status);
      return NO_COMPUTER_ERRORS.has(error)
        ? { outcome: "no_computer", reason: error }
        : { outcome: "retry", reason: error };
    }
    let finalText = "";
    let errorCode: string | null = null;
    for (const frame of sseFrames(raw)) {
      if (frame.event === "ev") {
        const kind = typeof frame.data.kind === "string" ? frame.data.kind : "";
        const data = frame.data.data && typeof frame.data.data === "object" && !Array.isArray(frame.data.data)
          ? (frame.data.data as Record<string, unknown>)
          : {};
        if (kind === "delta" && typeof data.text === "string") finalText += data.text;
        if (kind === "error" && typeof data.code === "string") errorCode = data.code;
      } else if (frame.event === "end") {
        if (typeof frame.data.final_text === "string" && frame.data.final_text.trim()) finalText = frame.data.final_text;
        if (typeof frame.data.error_code === "string" && frame.data.error_code) errorCode = frame.data.error_code;
      }
    }
    if (errorCode) {
      return NO_COMPUTER_ERRORS.has(errorCode)
        ? { outcome: "no_computer", reason: errorCode }
        : { outcome: "retry", reason: errorCode };
    }
    if (!finalText.trim()) return { outcome: "retry", reason: "reply_empty" };
    return { outcome: "completed", text: finalText.trim() };
  } catch (error) {
    if (error instanceof Error && error.name === "RunsUnavailableError") {
      return { outcome: "retry", reason: "chat_history_unavailable" };
    }
    console.error(
      "[oasis-telegram.device] exact-device turn failed",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return { outcome: "retry", reason: "device_turn_failed" };
  }
}
