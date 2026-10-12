import "server-only";

import type { AgentEngineChoice } from "@/lib/ai/agent-engine";
import { signResumeState, verifyResumeState } from "@/lib/resume-hmac";
import {
  isWorkspaceApiFallbackReason,
  type WorkspaceApiFallbackReason,
} from "@/lib/os/runs/types";

export const ENGINE_FALLBACK_STATE_HEADER = "x-oasis-engine-fallback-state";
export const ENGINE_FALLBACK_SIGNATURE_HEADER = "x-oasis-engine-fallback-signature";

const VERSION = 1;
const MAX_TTL_SEC = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EngineFallbackDispatch = {
  v: 1;
  tenant_id: string;
  user_id: string;
  agent_key: string;
  pairing_id: string;
  engine_kind: "subscription" | "local";
  engine_name: string;
  reason: WorkspaceApiFallbackReason;
  conversation_id: string;
  rate_limit_applied: true;
  iat: number;
  exp: number;
};

export type MintedEngineFallbackDispatch = {
  state: EngineFallbackDispatch;
  stateHeader: string;
  signature: string;
};

export type CanonicalCloudDispatchError =
  | "engine_requires_device_route"
  | "workspace_api_fallback_not_enabled"
  | "engine_selection_stale";

/**
 * `/api/chat` is a cloud executor, not an alternate router. A browser may use
 * it directly only while the effective canonical engine is API mode. A saved
 * computer engine may enter it only through the short-lived server-signed
 * fallback instruction minted by `/api/bridge/chat`, and that instruction
 * must still match the exact current pairing/runtime and opt-in policy.
 */
export function canonicalCloudDispatchError(
  engine: AgentEngineChoice,
  dispatch: EngineFallbackDispatch | null,
): CanonicalCloudDispatchError | null {
  if (!dispatch) return engine.kind === "api" ? null : "engine_requires_device_route";
  if (engine.kind === "api") return "engine_selection_stale";
  if ((engine.fallback ?? "none") !== "workspace_api") return "workspace_api_fallback_not_enabled";
  const engineKind = engine.kind === "cli" ? "subscription" : "local";
  const engineName = engine.kind === "cli" ? engine.cli : engine.model;
  if (
    !engine.pairingId ||
    engine.pairingId !== dispatch.pairing_id ||
    engineKind !== dispatch.engine_kind ||
    engineName !== dispatch.engine_name
  ) {
    return "engine_selection_stale";
  }
  return null;
}

function binding(state: EngineFallbackDispatch) {
  return {
    tenant_id: state.tenant_id,
    user_id: state.user_id,
    agent_key: state.agent_key,
  };
}

function isShortText(value: unknown, max = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parseState(raw: string): EngineFallbackDispatch | null {
  if (!raw || raw.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Partial<EngineFallbackDispatch>;
  if (
    value.v !== VERSION ||
    !isShortText(value.tenant_id) ||
    !isShortText(value.user_id) ||
    !isShortText(value.agent_key, 80) ||
    !isShortText(value.pairing_id) ||
    (value.engine_kind !== "subscription" && value.engine_kind !== "local") ||
    !isShortText(value.engine_name) ||
    !isWorkspaceApiFallbackReason(value.reason) ||
    typeof value.conversation_id !== "string" ||
    !UUID_RE.test(value.conversation_id) ||
    value.rate_limit_applied !== true ||
    typeof value.iat !== "number" ||
    typeof value.exp !== "number"
  ) {
    return null;
  }
  return value as EngineFallbackDispatch;
}

/** Mint a short-lived server-to-server instruction for one already-authorized
 * fallback. The browser never receives this token and cannot opt itself into
 * workspace API spend. */
export function mintEngineFallbackDispatch(input: {
  tenantId: string;
  userId: string;
  agentKey: string;
  pairingId: string;
  engineKind: "subscription" | "local";
  engineName: string;
  reason: WorkspaceApiFallbackReason;
  conversationId: string;
  nowMs?: number;
}): MintedEngineFallbackDispatch | null {
  if (!UUID_RE.test(input.conversationId)) return null;
  const iat = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const state: EngineFallbackDispatch = {
    v: VERSION,
    tenant_id: input.tenantId,
    user_id: input.userId,
    agent_key: input.agentKey,
    pairing_id: input.pairingId,
    engine_kind: input.engineKind,
    engine_name: input.engineName,
    reason: input.reason,
    conversation_id: input.conversationId,
    rate_limit_applied: true,
    iat,
    exp: iat + MAX_TTL_SEC,
  };
  const signature = signResumeState(state, binding(state));
  if (signature === null) return null;
  return {
    state,
    stateHeader: Buffer.from(JSON.stringify(state), "utf8").toString("base64url"),
    signature,
  };
}

/** Verify the internal instruction and bind it to the authenticated requester
 * and agent. A valid signature alone never overrides current tenant identity;
 * /api/chat compares the resolved tenant again before spending. */
export function verifyEngineFallbackDispatch(input: {
  stateHeader: string | null;
  signature: string | null;
  userId: string;
  agentKey: string;
  nowMs?: number;
}): EngineFallbackDispatch | null {
  const state = parseState(input.stateHeader || "");
  if (!state || state.user_id !== input.userId || state.agent_key !== input.agentKey) return null;
  const checked = verifyResumeState(state, input.signature, binding(state));
  if (!checked.ok) return null;
  const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (state.iat > now + 5 || state.exp <= now || state.exp - state.iat > MAX_TTL_SEC) return null;
  return state;
}

export function engineFallbackAuditReason(state: EngineFallbackDispatch): string {
  return `engine_unreachable:${state.engine_name}+${state.reason}`;
}

export function engineFallbackReplyLabel(state: EngineFallbackDispatch): string {
  const engine = state.engine_kind === "local" ? `local model ${state.engine_name}` : `${state.engine_name} subscription`;
  return `Workspace API fallback — the selected computer could not answer with its ${engine} (${state.reason}). This reply uses workspace API credits; no other computer was used, and cloud fallback cannot edit that computer's files.\n\n`;
}
