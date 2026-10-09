/**
 * lib/os/department-agent.ts - one agent turn for a department (or a direct
 * agent chat), with NO session: the tenant, the manifest slug, the department
 * and who is asking are passed in by the caller, who resolved them from its
 * own trusted source.
 *
 *   /api/agents/chat   the signed-in person's active workspace (session), and
 *                      streams the turn to the browser;
 *   Slack mentions     the workspace the Slack team is routed to
 *                      (provider_webhook_routes), and collects the whole reply
 *                      as the draft of a send_slack_message approval
 *                      (lib/slack/jobs.ts).
 *
 * Both go through prepareAgentTurn, so the rules are the same on every
 * channel:
 *   - a department speaks only through the agent this workspace binds to it
 *     (components/os/department/config.ts): a client workspace never gets an
 *     OASIS persona, and the reply names the DEPARTMENT, never the agent;
 *   - the model is paid by the WORKSPACE's own AI account (lib/ai/
 *     workspace-account.ts: the account row the team-wide connect writes, or
 *     the legacy `bravo` workspace row) or, only when the caller hands one in,
 *     the platform key: each caller resolves it behind the verified operator
 *     check (lib/platform-operator.ts), never this module;
 *   - the month's AI budget is checked before a model is called, and every
 *     model call is metered (lib/ai/usage.ts), under the department.
 *
 * Refusals come back as { status, error } with the same codes the web route
 * has always answered; `recordAs` marks the ones that are a verdict on the
 * workspace's AI account (recorded as the channel's last turn).
 */
import "server-only";
import { decryptField } from "@/lib/field-encryption";
import { streamChat, type ChatMessage, type Provider, type StreamEvent } from "@/lib/providers";
import type { OperatorFallback } from "@/lib/operator-credentials";
import { getAgentBySlug } from "@/lib/agents/loader";
import { getWorkspaceManifest } from "@/lib/manifest/loader";
import type { TenantManifest } from "@/lib/manifest/schema";
import { IDENTITY_LOCK_OVERLAY } from "@/lib/agent-personas";
import { getTenant } from "@/lib/queries";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
import type { OsDepartment } from "@/lib/os/departments";
import { departmentChannelFor } from "@/components/os/department/config";
import {
  agentChannelKey,
  classifyStreamError,
  departmentChannelKey,
  type TurnFailureCode,
} from "@/lib/os/channel/outcome";
import { departmentIdentityLock, departmentPrompt } from "@/lib/os/channel/identity";
import { LOCAL_MODEL_PROVIDER, hasUsableKey, readWorkspaceAiAccount, type WorkspaceAiAccount } from "@/lib/ai/workspace-account";
import { billingForKey, budgetExhaustedBeforeStream, modelCallMeter, type ModelCallMeter } from "@/lib/ai/usage";
import { resolveCall, type ModelSwap } from "@/lib/ai/model-registry";
import { redactAll } from "@/lib/secret-redaction";
import { DEPARTMENT_REPLY_MAX_TOKENS } from "@/lib/os/channel/reply-budget";

export type AgentTurnRequest = {
  tenantId: string;
  /** The manifest slug this tenant owns (the caller checked ownership). */
  tenantSlug: string;
  /** The agent asked for. For a department it must be the department's bound agent. */
  agentSlug: string;
  department: OsDepartment | null;
  /** Who the agent works for, as {{operator.*}} in its prompt. */
  operator: { name: string; email: string };
  /**
   * The platform key, when the caller verified the person is the platform
   * operator (the key bills OASIS). null = the workspace's own key or nothing.
   */
  platformFallback: OperatorFallback | null;
  /** Show the model id (operator detail) in the agent event. */
  revealModel: boolean;
  /** The signed-in person the turn served, when there is one. */
  userId: string | null;
  /** The job the turn belongs to (a Slack event), for the usage ledger. */
  jobId?: string | null;
  chatMode?: "plan" | "build";
  /**
   * The caller verified the person is the platform operator: a workspace
   * account on a local model server (its "key" is a web address the server
   * calls) may answer for them, and for nobody else. Absent (a Slack mention)
   * is no: such an account is treated as no usable account.
   */
  localModelAllowed?: boolean;
};

export type PreparedTurn = {
  tenantId: string;
  agentSlug: string;
  channelKey: string;
  department: OsDepartment | null;
  displayName: string;
  provider: Provider;
  /** The model the request sends: the saved one, or its registry replacement (`swap`). */
  model: string;
  /**
   * Set when the saved model is gone (lib/ai/model-registry.ts): the turn sends
   * the replacement on the same provider and key, and `meter` records why on
   * every call it opens (ai_usage_events.fallback_reason).
   */
  swap: ModelSwap | null;
  apiKey: string;
  keySource: "tenant" | "platform";
  system: string;
  meter: ModelCallMeter;
  revealModel: boolean;
  /** Carried to lib/providers.ts, which calls a local model server only with it. */
  localModelAllowed: boolean;
};

export type PrepareRefusal = {
  ok: false;
  status: number;
  error: string;
  extra?: Record<string, unknown>;
  /** Set when the refusal is a verdict on the workspace's AI account: record it as the channel's last turn. */
  recordAs?: TurnFailureCode;
  /** Known once the agent resolved: the turn a recorded refusal belongs to. */
  agentSlug?: string;
  channelKey?: string;
};

export type PrepareResult = { ok: true; turn: PreparedTurn } | PrepareRefusal;

/**
 * Per-value sanitiser for template substitutions. Tenant-controlled strings
 * (brand.name, operator.name, etc.) land in the agent's system prompt
 * verbatim; a brand name reading "Ignore previous instructions ..." would
 * otherwise inject into every turn. Hard length cap, control characters and
 * code fences stripped, prompt-style headers and role labels removed.
 */
export function sanitizeInterpolated(raw: string): string {
  if (typeof raw !== "string") return "";
  const stripped = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/```+/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\b(SYSTEM|ASSISTANT|USER)\s*:/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, 240);
}

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_m, key) => {
    const v = vars[key];
    return v === undefined ? `{{${key}}}` : sanitizeInterpolated(v);
  });
}

/**
 * Resolve everything a turn needs, or say why it cannot run. No model is
 * called here; the budget is only checked.
 */
export async function prepareAgentTurn(req: AgentTurnRequest): Promise<PrepareResult> {
  const { tenantId, tenantSlug } = req;
  const agentSlug = (req.agentSlug || "").trim().toLowerCase();
  const dept = req.department;

  // The workspace's manifest: its roster says who leads each department. Read
  // strictly (W4a review R3): a read that fails is "we could not confirm your
  // workspace", never a department judged unbound or pinned on another agent.
  let manifest: TenantManifest;
  try {
    manifest = await getWorkspaceManifest(tenantId, tenantSlug);
  } catch (err) {
    console.error("[department-agent.manifest]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, status: 503, error: "workspace_unavailable" };
  }

  // A department channel: the agent must be the one this workspace's manifest
  // binds to that department (config.ts departmentChannelFor), so a department
  // label is never pinned on another agent, and a lead switched off answers
  // nothing.
  if (dept) {
    // getTenant answers null when the tenants read fails. That is not "not
    // OASIS": judging the binding on it would refuse OASIS's own departments.
    const tenant = await getTenant(tenantId);
    if (!tenant?.slug) return { ok: false, status: 503, error: "workspace_unavailable" };
    const lead = departmentChannelFor(dept.key, { oasis: isOasisSurfaceTenant(tenant.slug), manifest });
    if (lead.kind !== "agent" || lead.agentSlug !== agentSlug) {
      return { ok: false, status: 400, error: "department_agent_mismatch" };
    }
  }

  const agent = await getAgentBySlug(agentSlug, tenantId);
  if (!agent) return { ok: false, status: 404, error: "agent_not_found" };
  // Public seed OR tenant-owned custom only.
  if (!agent.is_public && agent.tenant_id !== tenantId) return { ok: false, status: 403, error: "agent_not_visible" };

  const channelKey = dept ? departmentChannelKey(dept.key) : agentChannelKey(agent.slug);
  const binding = manifest.agents.find((a) => a.slug === agent.slug);

  // The workspace's AI account (lib/ai/workspace-account.ts): the account the
  // owner connected for the whole team, whatever teammates the workspace has.
  // A teammate's personal key never answers a shared channel.
  let cfg: WorkspaceAiAccount | null;
  try {
    cfg = await readWorkspaceAiAccount(tenantId);
  } catch (err) {
    // A failed read is not "no key": answering 412 would send the owner to
    // connect an account that is already connected.
    console.error("[department-agent.config]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, status: 503, error: "config_unavailable" };
  }

  let provider: Provider;
  let model: string;
  let apiKey = "";
  let keySource: "tenant" | "platform" = "tenant";
  // A local model account answers only with the caller's verified-operator
  // verdict; for anyone else (and for every Slack mention) it is no usable
  // account, so no request to its address is ever made (Codex review, PR #535).
  const localModelAllowed = req.localModelAllowed === true;
  // ONE SOURCE (CC, 2026-10-09): the provider AND the model are the workspace
  // AI account's, as Settings > AI brain shows and switches them. A manifest
  // binding's model_override used to win here, a second place choosing a
  // department's model that no screen showed (no stored manifest carried one
  // on 2026-10-09); it no longer chooses anything.
  if (hasUsableKey(cfg) && (cfg.provider !== LOCAL_MODEL_PROVIDER || localModelAllowed)) {
    provider = cfg.provider;
    model = cfg.model;
    try {
      apiKey = decryptField(cfg.encryptedApiKey);
    } catch {
      return { ok: false, status: 500, error: "key_unreadable", recordAs: "key_unreadable", agentSlug: agent.slug, channelKey };
    }
  } else {
    const fallback = req.platformFallback;
    if (!fallback) {
      // Not recorded: no key was tried, so this says nothing about the key.
      return {
        ok: false,
        status: 412,
        error: "agent_not_configured",
        extra: { hint: "Connect an AI account in Settings > AI brain before chatting here." },
      };
    }
    provider = fallback.provider;
    model = fallback.model;
    apiKey = fallback.apiKey;
    keySource = "platform";
  }

  // The month's AI budget (lib/ai/usage.ts): a workspace already at its cap is
  // refused before a model is called, and it is recorded as the channel's last
  // turn, because it is a verdict every channel shares.
  const billing = billingForKey(provider, keySource);
  try {
    const exhausted = await budgetExhaustedBeforeStream(tenantId, billing.billingMode);
    if (exhausted) {
      return { ok: false, status: 402, error: exhausted, recordAs: exhausted, agentSlug: agent.slug, channelKey };
    }
  } catch (err) {
    console.error("[department-agent.budget]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, status: 503, error: "ai_usage_unavailable" };
  }

  // A department channel speaks as the department: the persona's own name in
  // its library prompt is replaced BEFORE interpolation, so a tenant value
  // (brand, operator name) is never rewritten.
  const displayName = dept ? dept.label : binding?.display_name || agent.name;
  const interpolated = interpolate(dept ? departmentPrompt(agent.base_prompt, dept.label) : agent.base_prompt, {
    "tenant.brand.name": manifest.brand.name,
    "tenant.brand.subtitle": manifest.brand.subtitle,
    "tenant.industry": manifest.onboarding_industry || "custom",
    "tenant.slug": tenantSlug,
    "operator.name": req.operator.name,
    "operator.email": req.operator.email,
    "agent.name": displayName,
  });
  const overlay = binding?.prompt_overlay?.trim();
  // The identity lock: the model never says which model or persona it is; a
  // department's own lock names only the department.
  const baseSystem =
    (overlay ? `${interpolated}\n\nTENANT OVERLAY:\n${overlay}` : interpolated) +
    (dept ? departmentIdentityLock(dept.label) : IDENTITY_LOCK_OVERLAY);
  const { composeSystemPrompt, normalizeMode } = await import("@/lib/chat-modes/plan-mode");
  const system = composeSystemPrompt(baseSystem, normalizeMode(req.chatMode));

  // The saved model, unless the registry knows it is gone: then its
  // replacement on the same provider and key, and the meter records why
  // (lib/ai/model-registry.ts). Resolved here, not only where the request is
  // built, so the turn names the model it really sends.
  const picked = resolveCall(
    provider,
    model,
    modelCallMeter({
      tenantId,
      surface: "agents.chat",
      ...billing,
      departmentKey: dept?.key ?? null,
      teammateId: agent.slug,
      userId: req.userId,
      jobId: req.jobId ?? null,
    }),
  );

  return {
    ok: true,
    turn: {
      tenantId,
      agentSlug: agent.slug,
      channelKey,
      department: dept,
      displayName,
      provider,
      model: picked.model,
      swap: picked.swap,
      apiKey,
      keySource,
      system,
      meter: picked.meter,
      revealModel: req.revealModel,
      localModelAllowed,
    },
  };
}

/** The provider stream for a prepared turn (the web route relays it as SSE). */
export function streamAgentTurn(
  turn: PreparedTurn,
  messages: readonly ChatMessage[],
  maxTokens = DEPARTMENT_REPLY_MAX_TOKENS,
): AsyncGenerator<StreamEvent> {
  const isOllama = turn.provider === "ollama";
  return streamChat({
    provider: turn.provider,
    model: turn.model,
    apiKey: isOllama ? "" : turn.apiKey,
    baseUrl: isOllama ? turn.apiKey : undefined,
    allowLocalModel: turn.localModelAllowed,
    system: turn.system,
    messages: messages.filter((m) => m.role === "user" || m.role === "assistant"),
    maxTokens,
    meter: turn.meter,
  });
}

export type TurnText = { ok: true; text: string } | { ok: false; code: TurnFailureCode };

/**
 * Run a prepared turn to its full text (a Slack draft). A turn that errors, or
 * that finishes with no text, is a failure with a code, never an empty draft.
 * A provider or SDK that THROWS is logged here with its cause (redacted, like
 * the web route's), because the caller only ever sees the code.
 */
export async function runAgentTurnToText(
  turn: PreparedTurn,
  messages: readonly ChatMessage[],
  maxTokens = 1024,
  stream: typeof streamAgentTurn = streamAgentTurn,
): Promise<TurnText> {
  let text = "";
  try {
    for await (const ev of stream(turn, messages, maxTokens)) {
      if (ev.type === "delta") text += ev.text;
      else if (ev.type === "error") return { ok: false, code: classifyStreamError(ev.message) };
    }
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error("[department-agent.turn]", {
      tenantId: turn.tenantId,
      agentSlug: turn.agentSlug,
      error: redactAll(detail).slice(0, 500),
    });
    const code = classifyStreamError(err instanceof Error ? err.message : String(err));
    return { ok: false, code: code === "provider_error" ? "stream_failed" : code };
  }
  const trimmed = text.trim();
  return trimmed ? { ok: true, text: trimmed } : { ok: false, code: "stream_failed" };
}
