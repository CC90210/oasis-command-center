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
import {
  billingForBridge,
  billingForKey,
  budgetExhaustedBeforeStream,
  modelCallMeter,
  utf8Length,
  type CallEnd,
  type ModelCallMeter,
} from "@/lib/ai/usage";
import { meterWithFallbackReason, resolveCall, type ModelSwap } from "@/lib/ai/model-registry";
import { redactAll } from "@/lib/secret-redaction";
import { DEPARTMENT_REPLY_MAX_TOKENS } from "@/lib/os/channel/reply-budget";
import { readAgentEngine } from "@/lib/ai/agent-engine-store";
import {
  bridgeEngineLine,
  engineFallbackReason,
  harnessEngineLine,
  spendFor,
  type AgentEngineChoice,
  type EngineSpend,
} from "@/lib/ai/agent-engine";
import { harnessForDepartment } from "@/lib/admin/harness-targets";
import { departmentBrain, brainLine } from "@/lib/ai/department-brain";
import { streamBridgeTurn, type BridgeCaller, type BridgeEngine } from "@/lib/ai/bridge-turn";

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
  /**
   * The paired computer, reachable for this person: the caller's resolver runs
   * the coding harness's own bridge gate (lib/bridge-proxy.ts
   * authorizeBridgeRequest) for this workspace, only when an engine there is
   * chosen. Absent, or answering null (a Slack mention, a person the gate
   * refuses, no bridge set up): an engine on the paired computer cannot answer, and the
   * workspace's API account answers instead, saying so (TurnEngine.fellBackFrom).
   */
  bridge?: (() => Promise<BridgeCaller | null>) | null;
};

/**
 * What a turn runs on (lib/ai/agent-engine.ts): the API account (or the
 * platform key), or an AI app / local model on the paired computer. `runsOn`
 * is the plain words every reply footer shows; `spend` says whose credits or
 * plan it uses. `fellBackFrom` names the engine that was chosen but could not
 * be reached for this person, when the API account answered in its place.
 */
export type TurnEngine =
  | { kind: "api"; runsOn: string; spend: EngineSpend; fellBackFrom: string | null }
  | (BridgeEngine & {
      runsOn: string;
      spend: EngineSpend;
      caller: BridgeCaller;
      tenantSlug: string;
      fellBackFrom: null;
      /** The department's agent harness the app runs in (lib/admin/harness-targets.ts). */
      harness: { agent: string; department: string; label: string };
    });

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
  /** What the turn runs on; kind "api" is a hosted provider call (streamChat). */
  engine: TurnEngine;
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
  // OASIS's own workspace: its department turns may run in the department's
  // agent harness on the paired computer (lib/admin/harness-targets.ts).
  let oasisWorkspace = false;
  if (dept) {
    // getTenant answers null when the tenants read fails. That is not "not
    // OASIS": judging the binding on it would refuse OASIS's own departments.
    const tenant = await getTenant(tenantId);
    if (!tenant?.slug) return { ok: false, status: 503, error: "workspace_unavailable" };
    oasisWorkspace = isOasisSurfaceTenant(tenant.slug);
    const lead = departmentChannelFor(dept.key, { oasis: oasisWorkspace, manifest });
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
  let chosen: AgentEngineChoice;
  try {
    [cfg, chosen] = await Promise.all([readWorkspaceAiAccount(tenantId), readAgentEngine(tenantId)]);
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
  // WHAT POWERS YOUR AGENTS (lib/ai/agent-engine.ts): an AI app or local model
  // on the paired computer answers when the caller can reach it for this
  // person; then no key, no API credits and no budget are involved. Otherwise
  // the API account below answers, and the reply says what was chosen instead.
  const bridgeEngine: BridgeEngine | null = chosen.kind === "api" ? null : chosen;
  // The harness path is OASIS's department channels only, until client
  // harness packs exist: anyone else on a CLI engine is answered by the API
  // account (in-app desk agent), and the turn says so.
  const target = dept && oasisWorkspace ? harnessForDepartment(dept.key) : null;
  const harness = target && dept ? { agent: target.agent, department: dept.label, label: target.departments } : null;
  // Asked only when an engine on the paired computer is chosen; a gate that
  // throws is "can't be reached", never a crash of the turn.
  const caller = bridgeEngine && harness && req.bridge ? await req.bridge().catch(() => null) : null;
  const viaBridge = bridgeEngine && harness && caller ? { engine: bridgeEngine, caller, harness } : null;
  const fellBackFrom = bridgeEngine && !viaBridge ? bridgeEngineLine(bridgeEngine) : null;
  if (viaBridge) {
    // Named for the logs and the operator's model detail; no key is sent.
    provider = hasUsableKey(cfg) ? cfg.provider : "anthropic";
    model = bridgeEngineLine(viaBridge.engine);
  } else if (hasUsableKey(cfg) && (cfg.provider !== LOCAL_MODEL_PROVIDER || localModelAllowed)) {
    // ONE SOURCE (CC, 2026-10-09): the provider AND the model are the workspace
    // AI account's, as Settings > AI brain shows and switches them. A manifest
    // binding's model_override used to win here, a second place choosing a
    // department's model that no screen showed (no stored manifest carried one
    // on 2026-10-09); it no longer chooses anything.
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
        extra: {
          hint: fellBackFrom
            ? `Your agents run on ${fellBackFrom}, which can't be reached for this chat, and no AI account is connected to answer instead.`
            : "Connect an AI account in Settings > AI brain before chatting here.",
        },
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
  // A turn on the paired computer spends no API credits, so no budget applies.
  const billing = viaBridge ? billingForBridge(viaBridge.engine) : billingForKey(provider, keySource);
  try {
    const exhausted = viaBridge ? null : await budgetExhaustedBeforeStream(tenantId, billing.billingMode);
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
  const meter = modelCallMeter({
    tenantId,
    surface: "agents.chat",
    ...billing,
    departmentKey: dept?.key ?? null,
    teammateId: agent.slug,
    userId: req.userId,
    jobId: req.jobId ?? null,
  });
  // A turn on the paired computer sends no hosted model, so there is nothing to
  // resolve; its one row is written by streamAgentTurn (meteredBridgeTurn). A
  // turn that fell back from the chosen engine records that on every call it
  // opens, INSIDE the model-swap wrapper so both reasons survive.
  const apiMeter = bridgeEngine && fellBackFrom ? meterWithFallbackReason(meter, engineFallbackReason(bridgeEngine)) : meter;
  const picked = viaBridge ? { model, swap: null, meter } : resolveCall(provider, model, apiMeter);
  const brain = keySource === "tenant" && hasUsableKey(cfg) ? departmentBrain({ provider, model: picked.model }) : null;
  const engine: TurnEngine = viaBridge
    ? {
        ...viaBridge.engine,
        runsOn: harnessEngineLine(viaBridge.engine, viaBridge.harness.label),
        spend: spendFor(viaBridge.engine),
        caller: viaBridge.caller,
        tenantSlug,
        fellBackFrom: null,
        harness: viaBridge.harness,
      }
    : {
        kind: "api",
        runsOn: keySource === "platform" ? "the OASIS platform key" : brain ? `${brainLine(brain)} (API)` : `${provider} (API)`,
        spend: keySource === "platform" ? "platform" : "api_credits",
        fellBackFrom,
      };

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
      engine,
    },
  };
}

/** What the ledger calls the engine: the app's id ("claude", "codex", "gemini") or the local model's name. */
function bridgeLedgerModel(engine: BridgeEngine): string {
  return engine.kind === "cli" ? engine.cli : engine.model;
}

/** The ledger's error_code for a bridge stream error: the same words the channel shows (outcome.ts), empty replies as the providers record them. */
function bridgeErrorCode(message: string): string {
  const empty = /^empty_reply:(thinking|blocked|empty)$/.exec(message);
  return empty ? `empty_reply_${empty[1]}` : classifyStreamError(message);
}

/**
 * One ledger row for one department turn on the paired computer, whatever its
 * end. Passes every event through unchanged.
 *
 *   - provider "bridge", model the app or local model; billing subscription or
 *     local (billingForBridge), so nothing is priced or reserved against the
 *     budget; cost is a known 0 (nothing billed to an API account).
 *   - text arrived and the stream finished: ok. The bridge often reports no
 *     token counts, so output_tokens falls back to a characters/4 estimate: an
 *     ok row never carries 0 for a reply that had words, and the health check's
 *     "ok with 0 output" rule stays a real alarm.
 *   - an error event: that failure's code (bridge_unreachable, cli_failed, ...).
 *   - a stream that ends with no text, or no end at all: a FAILURE
 *     (empty_reply_*), never ok.
 *   - the consumer stopping early: cancelled.
 * Latency runs from the first pull, the start of the turn.
 */
export async function* meteredBridgeTurn(
  meter: ModelCallMeter,
  engine: BridgeEngine,
  inner: AsyncGenerator<StreamEvent>,
  size: { maxOutputTokens: number; promptBytes: number },
): AsyncGenerator<StreamEvent> {
  const call = await meter.begin({
    provider: "bridge",
    model: bridgeLedgerModel(engine),
    maxOutputTokens: size.maxOutputTokens,
    promptBytes: size.promptBytes,
  });
  let chars = 0;
  let reportedIn = 0;
  let reportedOut = 0;
  let end: CallEnd | null = null;
  const empty: CallEnd = {
    outcome: "error",
    errorCode: "empty_reply_empty",
    usage: { inputTokens: null, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null },
    notBilled: true,
  };
  try {
    for await (const ev of inner) {
      if (ev.type === "delta") chars += ev.text.length;
      else if (ev.type === "done") {
        reportedIn = ev.inputTokens;
        reportedOut = ev.outputTokens;
      } else if (ev.type === "error") {
        end = { outcome: "error", errorCode: bridgeErrorCode(ev.message), usage: null, notBilled: true };
      }
      yield ev;
    }
    end ??=
      chars > 0
        ? {
            outcome: "ok",
            usage: {
              inputTokens: reportedIn > 0 ? reportedIn : null,
              outputTokens: reportedOut > 0 ? reportedOut : Math.ceil(chars / 4),
              cacheReadTokens: null,
              cacheWriteTokens: null,
            },
            notBilled: true,
          }
        : empty;
  } catch (err) {
    end = { outcome: "error", errorCode: "stream_failed", usage: null, notBilled: true };
    throw err;
  } finally {
    await call.finish(end ?? { outcome: "cancelled", usage: null, notBilled: true });
  }
}

/** The provider stream for a prepared turn (the web route relays it as SSE). */
export function streamAgentTurn(
  turn: PreparedTurn,
  messages: readonly ChatMessage[],
  maxTokens = DEPARTMENT_REPLY_MAX_TOKENS,
): AsyncGenerator<StreamEvent> {
  // The paired computer (lib/ai/bridge-turn.ts): the same SSE shape, no key.
  // No hosted model is called, but the turn still leaves its one ledger row,
  // or a broken CLI turn would be invisible to the department-chat health check.
  if (turn.engine.kind !== "api") {
    const engine: BridgeEngine = turn.engine.kind === "cli" ? { kind: "cli", cli: turn.engine.cli } : { kind: "local", model: turn.engine.model };
    return meteredBridgeTurn(
      turn.meter,
      engine,
      streamBridgeTurn({
        caller: turn.engine.caller,
        engine,
        agentSlug: turn.agentSlug,
        tenantSlug: turn.engine.tenantSlug,
        system: turn.system,
        messages,
        maxTokens,
        harness: { agent: turn.engine.harness.agent, department: turn.engine.harness.department },
      }),
      { maxOutputTokens: maxTokens, promptBytes: utf8Length(JSON.stringify({ system: turn.system, messages })) },
    );
  }
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
