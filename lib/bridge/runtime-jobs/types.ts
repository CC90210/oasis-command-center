import "server-only";
import { redactAll } from "@/lib/secret-redaction";

export const RUNTIME_ACTION_PROTOCOL = "runtime_action_v1" as const;
export const RUNTIME_ACTIONS = ["probe", "auth"] as const;
export const RUNTIME_ENGINE_KINDS = ["cli", "local"] as const;
export const RUNTIME_PROGRESS_CODES = ["starting", "waiting_for_user", "authenticating", "probing", "retrying"] as const;
export const RUNTIME_FAILURE_CODES = [
  "account_identity_unavailable",
  "account_unsupported",
  "auth_process_failed",
  "auth_start_failed",
  "auth_timeout",
  "cli_auth_required",
  "cli_empty_output",
  "cli_nonzero_exit",
  "cli_not_found",
  "cli_timeout",
  "cli_update_required",
  "manual_auth_required",
  "runtime_rate_limited",
  "runtime_action_failed",
  "runtime_engine_not_allowed",
  "runtime_probe_failed",
  "status_check_failed",
] as const;

export type RuntimeAction = (typeof RUNTIME_ACTIONS)[number];
export type RuntimeEngineKind = (typeof RUNTIME_ENGINE_KINDS)[number];
export type RuntimeProgressCode = (typeof RUNTIME_PROGRESS_CODES)[number];
export type RuntimeFailureCode = (typeof RUNTIME_FAILURE_CODES)[number];
export type RuntimeEngine = { kind: RuntimeEngineKind; name: string };
export type RuntimeCapability = { action: RuntimeAction; engine: RuntimeEngine };
export type RuntimeJobStatus = "queued" | "running" | "completed" | "failed";
export type CliRuntimeStateCode =
  | "ready"
  | "needs_sign_in"
  | "not_installed"
  | "unsupported"
  | "probe_failed"
  | "probe_required"
  | "rate_limited"
  | "account_identity_unavailable";
export type RuntimeClaimState = {
  claude: { installed: boolean; authenticated: boolean; state: CliRuntimeStateCode };
  codex: { installed: boolean; authenticated: boolean; state: CliRuntimeStateCode };
  opencode: { installed: boolean; authenticated: boolean; state: CliRuntimeStateCode };
  local_models?: Array<{
    ref: string;
    label: string;
    adapter: "ollama" | "lmstudio";
    state: "ready" | "unavailable" | "probe_required";
  }>;
};

export type RuntimeJobRow = {
  id: string;
  tenantId: string;
  userId: string;
  pairingId: string;
  action: RuntimeAction;
  engine: RuntimeEngine;
  prompt: string | null;
  status: RuntimeJobStatus;
  idempotencyKey: string;
  claimId: string | null;
  leaseId: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  deadlineAt: string | null;
  progressCode: RuntimeProgressCode | null;
  resultCode: string | null;
  result: Record<string, unknown> | null;
  errorCode:
    | RuntimeFailureCode
    | "lease_expired"
    | "queue_expired"
    | "pairing_approval_lost"
    | "pairing_revoked"
    | "requester_seat_inactive"
    | null;
  errorRetryable: boolean | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._:/-]{0,95}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const CLI_NAMES = new Set(["claude", "codex", "opencode"]);
/** What a connector that predates OpenCode reports for it: it cannot run it. */
const NOT_REPORTED: RuntimeClaimState["opencode"] = { installed: false, authenticated: false, state: "not_installed" };
const CLI_RUNTIME_STATES = new Set([
  "ready",
  "needs_sign_in",
  "not_installed",
  "unsupported",
  "probe_failed",
  "probe_required",
  "rate_limited",
  "account_identity_unavailable",
]);
const LOCAL_RUNTIME_STATES = new Set(["ready", "unavailable", "probe_required"]);
const LOCAL_REF_RE = /^(?:ollama|lmstudio)\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/()\-]{0,139}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

export function isRuntimeAction(value: unknown): value is RuntimeAction {
  return typeof value === "string" && (RUNTIME_ACTIONS as readonly string[]).includes(value);
}

export function isProgressCode(value: unknown): value is RuntimeProgressCode {
  return typeof value === "string" && (RUNTIME_PROGRESS_CODES as readonly string[]).includes(value);
}

export function isFailureCode(value: unknown): value is RuntimeFailureCode {
  return typeof value === "string" && (RUNTIME_FAILURE_CODES as readonly string[]).includes(value);
}

export function validRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_RE.test(value) && redactAll(value) === value;
}

export function parseRuntimeEngine(value: unknown): { ok: true; engine: RuntimeEngine } | { ok: false; code: string } {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["kind", "name"])) return { ok: false, code: "unexpected_field" };
  if (value.kind !== "cli" && value.kind !== "local") return { ok: false, code: "unsupported_engine" };
  if (typeof value.name !== "string" || redactAll(value.name) !== value.name) {
    return { ok: false, code: "unsupported_engine" };
  }
  const name = value.kind === "cli" ? value.name.toLowerCase() : value.name;
  if (value.kind === "cli" && (!IDENTIFIER_RE.test(name) || !CLI_NAMES.has(name))) return { ok: false, code: "unsupported_engine" };
  if (value.kind === "local" && (name.length > 160 || !LOCAL_REF_RE.test(name))) return { ok: false, code: "unsupported_engine" };
  return { ok: true, engine: { kind: value.kind, name } };
}

export function parseCapability(value: unknown): { ok: true; capability: RuntimeCapability } | { ok: false; code: string } {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["action", "engine"])) return { ok: false, code: "unexpected_field" };
  if (!isRuntimeAction(value.action)) return { ok: false, code: "unsupported_action" };
  const engine = parseRuntimeEngine(value.engine);
  if (!engine.ok) return engine;
  return { ok: true, capability: { action: value.action, engine: engine.engine } };
}

export function parseCapabilities(value: unknown): { ok: true; capabilities: RuntimeCapability[] } | { ok: false; code: string } {
  if (!Array.isArray(value) || value.length > 32) return { ok: false, code: "invalid_capabilities" };
  const seen = new Set<string>();
  const capabilities: RuntimeCapability[] = [];
  for (const raw of value) {
    // A connector from before 2026-10-27 still offers Gemini CLI, which was
    // removed: skip that one entry rather than refuse the connector's claim.
    if (isPlainObject(raw) && isPlainObject(raw.engine) && raw.engine.kind === "cli" && raw.engine.name === "gemini") continue;
    const parsed = parseCapability(raw);
    if (!parsed.ok) return parsed;
    const key = `${parsed.capability.action}:${parsed.capability.engine.kind}:${parsed.capability.engine.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      capabilities.push(parsed.capability);
    }
  }
  return { ok: true, capabilities };
}

function parseCliRuntime(value: unknown): { ok: true; value: RuntimeClaimState["claude"] } | { ok: false; code: string } {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["installed", "authenticated", "state"])) return { ok: false, code: "unexpected_field" };
  if (typeof value.installed !== "boolean" || typeof value.authenticated !== "boolean" || typeof value.state !== "string" || !CLI_RUNTIME_STATES.has(value.state)) {
    return { ok: false, code: "invalid_runtime_state" };
  }
  return { ok: true, value: { installed: value.installed, authenticated: value.authenticated, state: value.state as CliRuntimeStateCode } };
}

export function parseRuntimeClaimState(value: unknown): { ok: true; state: RuntimeClaimState | null } | { ok: false; code: string } {
  if (value === undefined) return { ok: true, state: null };
  // "gemini" is what a connector from before 2026-10-27 still sends (Gemini
  // CLI was removed; OpenCode replaced it). It is checked for shape and then
  // dropped, so that connector keeps claiming until it updates; "opencode" is
  // absent from it and reads as not installed there.
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["claude", "codex", "opencode", "gemini", "local_models"])) return { ok: false, code: "unexpected_field" };
  const claude = parseCliRuntime(value.claude);
  const codex = parseCliRuntime(value.codex);
  const opencode = value.opencode === undefined ? { ok: true as const, value: NOT_REPORTED } : parseCliRuntime(value.opencode);
  const legacyGemini = value.gemini === undefined ? { ok: true as const } : parseCliRuntime(value.gemini);
  if (!claude.ok) return claude;
  if (!codex.ok) return codex;
  if (!opencode.ok) return opencode;
  if (!legacyGemini.ok) return legacyGemini;
  const state: RuntimeClaimState = { claude: claude.value, codex: codex.value, opencode: opencode.value };
  if (value.local_models !== undefined) {
    if (!Array.isArray(value.local_models) || value.local_models.length > 200) return { ok: false, code: "invalid_runtime_state" };
    const models: NonNullable<RuntimeClaimState["local_models"]> = [];
    const seen = new Set<string>();
    for (const raw of value.local_models) {
      if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["ref", "label", "adapter", "state"])) return { ok: false, code: "unexpected_field" };
      if (
        typeof raw.ref !== "string" || raw.ref.length > 160 || !LOCAL_REF_RE.test(raw.ref) || redactAll(raw.ref) !== raw.ref ||
        typeof raw.label !== "string" || !SAFE_LABEL_RE.test(raw.label) || redactAll(raw.label) !== raw.label ||
        (raw.adapter !== "ollama" && raw.adapter !== "lmstudio") ||
        typeof raw.state !== "string" || !LOCAL_RUNTIME_STATES.has(raw.state)
      ) {
        return { ok: false, code: "invalid_runtime_state" };
      }
      if ((raw.adapter === "ollama" && !raw.ref.startsWith("ollama/")) || (raw.adapter === "lmstudio" && !raw.ref.startsWith("lmstudio/"))) {
        return { ok: false, code: "invalid_runtime_state" };
      }
      if (seen.has(raw.ref)) return { ok: false, code: "invalid_runtime_state" };
      seen.add(raw.ref);
      models.push({
        ref: raw.ref,
        label: raw.label,
        adapter: raw.adapter,
        state: raw.state as "ready" | "unavailable" | "probe_required",
      });
    }
    state.local_models = models;
  }
  return { ok: true, state };
}

export function safeProbePrompt(value: unknown): { ok: true; prompt: string | null } | { ok: false; code: string } {
  if (value === undefined || value === null) return { ok: true, prompt: null };
  if (typeof value !== "string" || value.length < 1 || value.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    return { ok: false, code: "invalid_prompt" };
  }
  const redacted = redactAll(value);
  if (redacted !== value) return { ok: false, code: "secret_material_rejected" };
  return { ok: true, prompt: value };
}

export function safeResultText(value: unknown, max = 1_000): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > max) return null;
  return redactAll(value);
}
