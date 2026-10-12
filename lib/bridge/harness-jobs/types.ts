export const HARNESS_PROTOCOL = "coding_harness_task_v1" as const;

export const HARNESS_EVENT_TYPES = [
  "session",
  "agent_status",
  "info",
  "delta",
  "tool",
  "tool_result",
  "tool_progress",
  "error",
  "done",
] as const;

export type HarnessEventType = (typeof HARNESS_EVENT_TYPES)[number];
export type HarnessEngine = { kind: "cli" | "local"; name: string };
export type HarnessChatMode = "plan" | "build";

/** Missing means read-only. Only the literal `build` value grants the route
 * permission to request repo-scoped writes; every other supplied value is a
 * malformed authority request and must be rejected. */
export function parseHarnessChatMode(value: unknown):
  | { ok: true; value: HarnessChatMode }
  | { ok: false; code: "invalid_chat_mode" } {
  if (value === undefined) return { ok: true, value: "plan" };
  if (value === "plan" || value === "build") return { ok: true, value };
  return { ok: false, code: "invalid_chat_mode" };
}

export type HarnessRequest = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  attachments: Array<{
    id: string;
    filename?: string;
    mime_type?: string;
    size_bytes?: number;
    parser?: string;
    text_excerpt?: string | null;
  }>;
  session_id: string | null;
  tab_id: string | null;
  disallowed_tools: string[];
  fallback_policy: "none" | "workspace_api";
};

export type HarnessJob = {
  id: string;
  tenantId: string;
  userId: string;
  pairingId: string;
  agentKey: string;
  engine: HarnessEngine;
  chatMode: HarnessChatMode;
  repoWrites: boolean;
  request: HarnessRequest;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  claimId: string | null;
  leaseId: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  deadlineAt: string;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type HarnessEvent = {
  seq: number;
  type: HarnessEventType;
  data: Record<string, unknown>;
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isHarnessEventType(value: unknown): value is HarnessEventType {
  return typeof value === "string" && (HARNESS_EVENT_TYPES as readonly string[]).includes(value);
}

export function validHarnessId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
}

export function validClaimId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}
