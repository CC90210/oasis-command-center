/**
 * POST /api/bridge/chat
 *
 * Same-origin Supabase-authed proxy from the dashboard ChatWidget to the
 * PRIVATE VPS bridge (CLI tools). Lets SunBiz employees chat with the agents
 * via the bridge WITHOUT exposing the bridge to the public internet and with
 * per-role tool gating so a non-admin employee can NEVER get a shell.
 *
 * Trust model (3 hops, secret never reaches the browser):
 *   HOP 1 browser->Vercel: same-origin Supabase session cookie auths the
 *         proxy. The widget adds NO Authorization header.
 *   HOP 2 Vercel resolves identity server-side from user_profiles by
 *         user.id (tenant_id, team_role, is_owner, email). Browser-supplied
 *         tenant_id/team_role/user_id are IGNORED. FAIL CLOSED to read_only.
 *   HOP 3 Vercel->VPS: forwards to ${baseUrl}/chat with a server-only Bearer
 *         token (BRIDGE_BEARER_TOKEN, never NEXT_PUBLIC). The bridge proves
 *         the request came from the proxy via the bearer, then trusts the
 *         forwarded {tenant_id, user_id, team_role, disallowed_tools}.
 *
 * The disallowed_tools list (computed server-side from the DB role) becomes
 * the claude CLI `--disallowed-tools` spawn flag on the VPS — the hard wall.
 */

import { NextRequest } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { bridgeCliPolicy, type BridgeCliProvider } from "@/lib/bridge-cli-policy";
import { authorizeBridgePullActor } from "@/lib/bridge-proxy";
import { validateBridgeAgent } from "@/lib/agent-roots";
import { teeBridgeChatPersistence } from "@/lib/bridge-chat-persistence";
import { teeBridgeDashboardActions } from "@/lib/admin/bridge-dashboard-actions";
import {
  isOasisWorkspace,
  readEffectiveAgentEngineWithProof,
  savedRuntimeProbeProofReady,
  type SavedRuntimeProbeProof,
} from "@/lib/ai/agent-engine-store";
import { harnessRouteFor, type HarnessRoute } from "@/lib/ai/agent-engine";
import { subscriptionRolloutError } from "@/lib/ai/engine-rollout";
import { getServiceSupabase } from "@/lib/supabase-server";
import { pairingCanClaim, type PairedVia } from "@/lib/bridge/pairing-auth";
import { isOnline } from "@/lib/devices/presence";
import { readAgentsOwner } from "@/lib/agents-owner";
import { bridgeDisallowedToolsForRole } from "@/lib/role-gates";
import {
  cancelHarnessJob,
  enqueueHarnessJob,
  HARNESS_PROTOCOL,
  harnessJobStream,
  harnessJobStreamWithUnclaimedFallback,
  parseHarnessChatMode,
} from "@/lib/bridge/harness-jobs";
import { readLatestRuntimeProbeReceipts, runtimeProbeReceiptKey } from "@/lib/bridge/runtime-jobs";
import { liveSeat } from "@/lib/os/seat";
import { keepAlive } from "@/lib/os/runs/keepalive";
import { isWorkspaceApiFallbackReason, type WorkspaceApiFallbackReason } from "@/lib/os/runs/types";
import { runtimeAvailability } from "@/lib/bridge/runtime-availability";
import {
  ENGINE_FALLBACK_SIGNATURE_HEADER,
  ENGINE_FALLBACK_STATE_HEADER,
  mintEngineFallbackDispatch,
} from "@/lib/ai/engine-fallback-dispatch";
import { POST as cloudChatPost } from "@/app/api/chat/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Vercel plan caps maxDuration as a HARD validation at build time (not
// a silent runtime cap). Hobby = 60s, Pro = 300s, Pro+Fluid Compute =
// 800s. CC upgraded to Fluid Compute 2026-06-11, so this can ride at
// 800s — ~13 min — which covers every Solara operation observed
// in production so far (Mamaws underwriting + exploration sequence
// took ~10 min in the VPS-side test). For anything genuinely longer
// than 13 min, route the chat SSE directly through the Cloudflare
// tunnel to the VPS bridge, bypassing this Vercel function entirely.
export const maxDuration = 800;

// Body-size + attachment caps — an authed employee must not be able to push
// unbounded payloads to the VPS spawn. Mirrors the /api/chat attachment cap
// (MAX_ATTACHMENTS_PER_TURN=5 in ChatWidget) and adds a hard byte ceiling
// (/api/chat has no explicit one but is bounded by Vercel's 4.5MB request
// limit; we pull it in tighter for the spawn path).
const MAX_BODY_BYTES = 1_000_000; // 1 MB of JSON
const MAX_ATTACHMENTS = 5;
const MAX_MESSAGES = 200;

type IncomingBody = {
  agent?: string;
  messages?: Array<{ role?: string; content?: string }>;
  session_id?: string | null;
  tab_id?: string;
  cli_provider?: string;
  target_pairing_id?: string;
  runtime_engine_kind?: string;
  runtime_engine_name?: string;
  fallback_policy?: string;
  chat_mode?: string;
  attachments?: Array<{
    id?: string;
    filename?: string;
    mime_type?: string;
    size_bytes?: number;
    parser?: string;
    text_excerpt?: string | null;
  }>;
  // tenant_id / team_role / user_id / disallowed_tools, if present, are
  // IGNORED — we always derive them server-side and let the server fields
  // win in the forwarded body.
  //
  // No catch-all index signature here on purpose (O1, security_rules #14):
  // this type is the allow-list. A client-supplied field this type does not
  // name (a `department` block, say) must fail TO TYPE-CHECK if anyone ever
  // tries to read it off `clientBody`, not silently pass through a spread.
};

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  // ---- Body-size guard BEFORE parse ----------------------------------------
  // content-length is advisory (a client can lie / omit it) but it's a cheap
  // first cut; the post-parse structural caps below are the real backstop.
  const declaredLen = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    return jsonError(413, "payload_too_large");
  }

  let clientBody: IncomingBody;
  let rawText: string;
  try {
    rawText = await req.text();
  } catch {
    return jsonError(400, "invalid_body");
  }
  if (rawText.length > MAX_BODY_BYTES) {
    return jsonError(413, "payload_too_large");
  }
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonError(400, "invalid_body");
    }
    clientBody = parsed as IncomingBody;
  } catch {
    return jsonError(400, "invalid_json");
  }

  // ---- Validate the client-supplied shape (same checks as /api/chat) -------
  const messages = Array.isArray(clientBody.messages) ? clientBody.messages : [];
  if (messages.length === 0) return jsonError(400, "no_messages");
  if (messages.length > MAX_MESSAGES) return jsonError(400, "too_many_messages");
  const lastUserMsg = [...messages].reverse().find((m) => m && m.role === "user");
  if (!lastUserMsg || !String(lastUserMsg.content || "").trim()) {
    return jsonError(400, "no_user_message");
  }
  // Every entry is checked BEFORE the allow-listed projection below reads its
  // fields: `[null, {...}]` used to pass the checks above and then throw an
  // unhandled 500 when the projection read `m.role` (Codex review, O1).
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!messages.every((m) => isObject(m) && typeof m.role === "string" && typeof m.content === "string")) {
    return jsonError(400, "invalid_messages");
  }
  const attachments = Array.isArray(clientBody.attachments) ? clientBody.attachments : [];
  if (attachments.length > MAX_ATTACHMENTS) return jsonError(400, "too_many_attachments");
  if (!attachments.every((a) => isObject(a) && typeof a.id === "string" && a.id.length > 0)) {
    return jsonError(400, "invalid_attachments");
  }

  // cli_provider gate — same allowlist /api/chat (and the bridge) enforce.
  const requestedCliProvider = typeof clientBody.cli_provider === "string" ? clientBody.cli_provider.toLowerCase() : null;
  if (requestedCliProvider !== null && !["claude", "codex", "opencode"].includes(requestedCliProvider)) {
    return jsonError(400, "invalid_cli_provider");
  }

  // ---- Pin the agent server-side -------------------------------------------
  // Slug is validated AFTER tenant resolution below (one helper, both gates).
  // The body-size + cli_provider checks above already filter the bulk of
  // malformed requests, so deferring agent validation past the auth path
  // costs nothing measurable and keeps the security check centralized.
  const agent = String(clientBody.agent || "").trim().toLowerCase();

  // ---- Auth + tenant gate (shared helper) ----------------------------------
  // Consolidated 2026-06-10 — used to inline ~60 lines duplicating
  // authorizeBridgeRequest. Same gate logic, single source of truth. Any
  // change to the security boundary (slug==='submissions' OR isOperator,
  // fail-closed teamRole='read_only', etc.) now lives in one file —
  // lib/bridge-proxy.ts — instead of two. The /chat-reset + /prewarm
  // routes already use this helper; bringing /chat into line eliminates
  // the privilege-escalation-via-drift bug class.
  const auth = await authorizeBridgePullActor();
  if (!auth.ok) return jsonError(auth.status, auth.error);

  // ---- Agent allowlist (both gates: known-universe + tenant-specific) ------
  const agentCheck = validateBridgeAgent(agent, auth.tenantSlug);
  if (!agentCheck.ok) return jsonError(agentCheck.status, agentCheck.error);

  // Resolve the effective choice again on the server. A stale tab, forged
  // browser body, or remembered CLI cannot change the saved computer/runtime.
  let savedRoute: HarnessRoute;
  let engineSource: "person" | "workspace";
  let savedProbeProof: SavedRuntimeProbeProof | null;
  try {
    const effective = await readEffectiveAgentEngineWithProof(auth.tenantId, auth.userId);
    savedRoute = harnessRouteFor(effective.engine);
    engineSource = effective.source;
    savedProbeProof = effective.probeProof;
  } catch (error) {
    console.error("[bridge.chat.engine]", error);
    return jsonError(503, "engine_config_unavailable");
  }
  if (savedRoute.mode === "cloud_only") return jsonError(409, "engine_requires_cloud_route");
  if (savedRoute.mode === "unavailable") return jsonError(409, "engine_pairing_required");

  // Test and Save apply this same rollout gate. Re-check it at execution time
  // so a legacy/pre-existing row cannot run Codex outside an eligible OASIS
  // workspace merely because it predates the canonical engine API.
  if (savedRoute.engineKind === "subscription") {
    try {
      if (subscriptionRolloutError(savedRoute.runtime!, await isOasisWorkspace(auth.tenantId))) {
        return jsonError(409, "codex_oasis_rollout_only");
      }
    } catch (error) {
      console.error("[bridge.chat.rollout]", error instanceof Error ? error.message : String(error));
      return jsonError(503, "engine_rollout_check_unavailable");
    }
  }

  const bindingMatches =
    clientBody.target_pairing_id === savedRoute.pairingId &&
    clientBody.runtime_engine_kind === savedRoute.engineKind &&
    clientBody.runtime_engine_name === savedRoute.engineName &&
    clientBody.fallback_policy === savedRoute.fallback &&
    (savedRoute.engineKind === "subscription"
      ? requestedCliProvider === savedRoute.engineName
      : requestedCliProvider === null);
  if (!bindingMatches) return jsonError(409, "engine_selection_stale");

  // Re-check the selected pairing at handoff time. A heartbeat or credential
  // file is not readiness: the exact runtime must have passed its probe.
  const { data: pairingData, error: pairingError } = await getServiceSupabase()
    .from("bridge_pairings")
    .select("id, user_id, last_seen_at, claim_enabled_at, paired_via, scope, claim_protocols, claim_runtime_state")
    .eq("tenant_id", auth.tenantId)
    .eq("id", savedRoute.pairingId)
    .is("revoked_at", null)
    .maybeSingle();
  if (pairingError) {
    console.error("[bridge.chat.pairing]", pairingError.message);
    return jsonError(503, "pairing_check_unavailable");
  }
  const pairing = pairingData as {
    id?: string;
    user_id?: string | null;
    last_seen_at?: string | null;
    claim_enabled_at?: string | null;
    paired_via?: string | null;
    scope?: string | null;
    claim_protocols?: unknown;
    claim_runtime_state?: unknown;
  } | null;
  const pairedVia: PairedVia =
    pairing?.paired_via === "pair_code" || pairing?.paired_via === "hmac" || pairing?.paired_via === "signup_secret"
      ? pairing.paired_via
      : null;
  if (!pairing || !pairingCanClaim({ claimEnabledAt: pairing.claim_enabled_at ?? null, pairedVia })) {
    return jsonError(409, "pairing_not_approved");
  }
  if (!stringList(pairing.claim_protocols).includes(HARNESS_PROTOCOL)) return jsonError(409, "connector_update_required");
  const pairingScope = pairing.scope === "connector" ? "connector" : "daemon";
  let workspaceOwnerId: string | null = null;
  if (engineSource === "workspace" || pairingScope === "daemon") {
    const owner = await readAgentsOwner(auth.tenantId);
    if (owner.state === "unavailable") return jsonError(503, "workspace_agents_owner_unavailable");
    if (engineSource === "workspace" && owner.state !== "set") return jsonError(409, "workspace_agents_owner_unavailable");
    workspaceOwnerId = owner.state === "set" ? owner.authUserId : null;
  }
  if (pairingScope === "daemon" && (!workspaceOwnerId || pairing.user_id !== workspaceOwnerId)) {
    return jsonError(409, "agents_owner_only");
  }
  const pairingOwnerId = engineSource === "workspace" ? workspaceOwnerId! : auth.userId;
  if (pairing.user_id !== pairingOwnerId) return jsonError(403, "engine_pairing_owner_mismatch");
  // ---- Per-tenant rate limit (same shape as /api/chat) ---------------------
  const limit = rateLimit({ key: `bridge-chat:${auth.tenantId}`, capacity: 30, refillPerSec: 1 / 15 });
  if (!limit.allowed) {
    return new Response(
      JSON.stringify({ ok: false, error: "rate_limited", retry_in_sec: limit.resetIn }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": String(limit.resetIn) } },
    );
  }

  // ---- Role-derived runtime + disallowed tools (server-side) ----------------
  // Non-privileged roles run on Claude Code, the ONLY runtime whose
  // --disallowed-tools spawn flag enforces the no-shell wall (Codex audit P1);
  // owner/admin keep their choice and every tool. One rule shared with the
  // department turns on a CLI engine (lib/bridge-cli-policy.ts). The server
  // value wins in the forward body.
  const disallowedTools = bridgeDisallowedToolsForRole(auth.teamRole);
  let effectiveCliProvider: BridgeCliProvider | null = null;
  if (savedRoute.engineKind === "subscription") {
    const policy = bridgeCliPolicy(auth.teamRole, savedRoute.engineName as BridgeCliProvider);
    if (policy.cliProvider !== savedRoute.engineName) return jsonError(403, "engine_not_allowed_for_role");
    effectiveCliProvider = policy.cliProvider;
  } else if (disallowedTools.length > 0) {
    // Local servers have no equivalent of Claude's --disallowed-tools wall.
    // Refuse the turn rather than quietly substituting Claude.
    return jsonError(403, "engine_not_allowed_for_role");
  }

  // Every device-backed runtime uses the exact-pairing pull lane. The selected
  // laptop calls OUT to claim the structured task, then posts a signed SSE
  // event stream back. This is the missing routing primitive for a Mac/PC
  // that has no inbound URL at all. No dashboard-controlled shell command or
  // path crosses this boundary: the connector resolves the allow-listed agent
  // key to its own local repo root.
  const parsedChatMode = parseHarnessChatMode(clientBody.chat_mode);
  if (!parsedChatMode.ok) return jsonError(400, parsedChatMode.code);
  const chatMode = parsedChatMode.value;
  if (chatMode === "build" && !(savedRoute.engineKind === "subscription" && savedRoute.engineName === "codex")) {
    return jsonError(409, "repo_write_sandbox_unavailable_use_codex_or_api");
  }
  const repoWrites = savedRoute.engineKind === "subscription" && savedRoute.engineName === "codex" && chatMode === "build" && disallowedTools.length === 0;
  const normalizedAttachments = attachments.map((attachment) => ({
    id: String(attachment.id),
    filename: typeof attachment.filename === "string" ? attachment.filename : undefined,
    mime_type: typeof attachment.mime_type === "string" ? attachment.mime_type : undefined,
    size_bytes: typeof attachment.size_bytes === "number" ? attachment.size_bytes : undefined,
    parser: typeof attachment.parser === "string" ? attachment.parser : undefined,
    text_excerpt: typeof attachment.text_excerpt === "string" ? attachment.text_excerpt : null,
  }));

  /** Activate only this saved selection's explicit fallback. The signed
   * instruction never reaches the browser; /api/chat independently resolves
   * the authenticated workspace and permits only its current workspace key. */
  const workspaceFallbackResponse = async (reason: WorkspaceApiFallbackReason): Promise<Response> => {
    if (savedRoute.fallback !== "workspace_api" || !isWorkspaceApiFallbackReason(reason)) {
      return jsonError(409, "workspace_api_fallback_not_enabled");
    }
    // Approval, ownership and both seat revocations remain hard boundaries
    // even after a 30-second no-claim wait. They must never turn into API spend.
    const requesterSeat = await liveSeat(auth.tenantId, auth.userId);
    if (!requesterSeat.live) {
      return jsonError(requesterSeat.reason === "unavailable" ? 503 : 403, requesterSeat.reason === "unavailable" ? "requester_check_unavailable" : "requester_inactive");
    }
    const ownerSeat = pairingOwnerId === auth.userId ? requesterSeat : await liveSeat(auth.tenantId, pairingOwnerId);
    if (!ownerSeat.live) {
      return jsonError(ownerSeat.reason === "unavailable" ? 503 : 403, ownerSeat.reason === "unavailable" ? "pairing_owner_check_unavailable" : "pairing_owner_inactive");
    }
    const { data: livePairing, error: livePairingError } = await getServiceSupabase()
      .from("bridge_pairings")
      .select("id, user_id, claim_enabled_at, paired_via, scope")
      .eq("tenant_id", auth.tenantId)
      .eq("id", savedRoute.pairingId)
      .is("revoked_at", null)
      .maybeSingle();
    if (livePairingError) {
      console.error("[bridge.chat.fallback-pairing]", livePairingError.message);
      return jsonError(503, "pairing_check_unavailable");
    }
    const live = livePairing as {
      user_id?: string | null;
      claim_enabled_at?: string | null;
      paired_via?: string | null;
      scope?: string | null;
    } | null;
    const livePairedVia: PairedVia =
      live?.paired_via === "pair_code" || live?.paired_via === "hmac" || live?.paired_via === "signup_secret"
        ? live.paired_via
        : null;
    if (!live || live.user_id !== pairingOwnerId || !pairingCanClaim({ claimEnabledAt: live.claim_enabled_at ?? null, pairedVia: livePairedVia })) {
      return jsonError(409, "pairing_no_longer_approved");
    }
    if (live.scope !== "connector") {
      const currentOwner = await readAgentsOwner(auth.tenantId);
      if (currentOwner.state === "unavailable") return jsonError(503, "workspace_agents_owner_unavailable");
      if (currentOwner.state !== "set" || currentOwner.authUserId !== live.user_id) {
        return jsonError(409, "agents_owner_only");
      }
    }
    const conversationId = typeof clientBody.tab_id === "string" ? clientBody.tab_id : "";
    const dispatch = mintEngineFallbackDispatch({
      tenantId: auth.tenantId,
      userId: auth.userId,
      agentKey: agent,
      pairingId: savedRoute.pairingId,
      engineKind: savedRoute.engineKind,
      engineName: savedRoute.engineName,
      reason,
      conversationId,
    });
    if (!dispatch) return jsonError(409, "workspace_api_fallback_session_invalid");
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    headers.set(ENGINE_FALLBACK_STATE_HEADER, dispatch.stateHeader);
    headers.set(ENGINE_FALLBACK_SIGNATURE_HEADER, dispatch.signature);
    const cloudRequest = new NextRequest(new URL("/api/chat", req.url), {
      method: "POST",
      headers,
      signal: req.signal,
      body: JSON.stringify({
        agent_key: agent,
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        attachments: normalizedAttachments.map((attachment) => ({ id: attachment.id })),
        cloud_tools: "tools",
        tool_routing: "cloud_only",
        chat_mode: chatMode,
      }),
    });
    return cloudChatPost(cloudRequest);
  };

  if (!isOnline(pairing.last_seen_at, Date.now())) {
    return savedRoute.fallback === "workspace_api"
      ? workspaceFallbackResponse("computer_offline")
      : jsonError(409, "pairing_offline");
  }
  const runtimeCheck = runtimeAvailability(pairing.claim_runtime_state, savedRoute);
  if (!runtimeCheck.ok) {
    return savedRoute.fallback === "workspace_api" && runtimeCheck.fallbackReason
      ? workspaceFallbackResponse(runtimeCheck.fallbackReason)
      : jsonError(409, runtimeCheck.error);
  }
  try {
    const receipts = await readLatestRuntimeProbeReceipts(auth.tenantId, [savedRoute.pairingId]);
    const runtimeEngine = savedRoute.engineKind === "subscription"
      ? { kind: "cli" as const, name: savedRoute.engineName }
      : { kind: "local" as const, name: savedRoute.engineName };
    const receipt = receipts.get(runtimeProbeReceiptKey(savedRoute.pairingId, runtimeEngine));
    if (!savedRuntimeProbeProofReady(savedProbeProof, savedRoute.pairingId, runtimeEngine, receipt)) {
      return jsonError(409, "engine_needs_test");
    }
  } catch (error) {
    console.error("[bridge.chat.probe-receipt]", error instanceof Error ? error.message : String(error));
    return jsonError(503, "engine_probe_check_unavailable");
  }

  const queued = await enqueueHarnessJob({
    tenantId: auth.tenantId,
    userId: auth.userId,
    pairingOwnerId,
    pairingId: savedRoute.pairingId,
    agentKey: agent,
    engine: savedRoute.engineKind === "subscription"
      ? { kind: "cli", name: savedRoute.engineName }
      : { kind: "local", name: savedRoute.engineName },
    chatMode,
    repoWrites,
    request: {
      messages: messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content),
      })),
      attachments: normalizedAttachments,
      session_id: typeof clientBody.session_id === "string" ? clientBody.session_id.slice(0, 200) : null,
      tab_id: typeof clientBody.tab_id === "string" ? clientBody.tab_id.slice(0, 200) : null,
      disallowed_tools: disallowedTools,
      fallback_policy: savedRoute.fallback,
    },
  });
  if (!queued.ok) {
    return queued.code === "computer_not_answering" && savedRoute.fallback === "workspace_api"
      ? workspaceFallbackResponse("computer_not_answering")
      : jsonError(409, queued.code);
  }
  // A closed tab or a page left mid-reply aborts the request, and this cancel
  // is what tells the connector to stop. On Cloudflare Workers the request is
  // cancelled at exactly that moment, and a promise nobody gave to ctx.waitUntil
  // is cancelled with it: a bare `void` could leave the job running with nobody
  // watching. The same hazard, in lib/bridge-chat-persistence.ts, left every
  // reply unsaved (bridge chat saved no replies; 2026-10-20 audit). keepAlive
  // hands the cancel to the platform and never throws. It finds the platform
  // only while this callback still runs inside the request's context (OpenNext
  // keeps it in an AsyncLocalStorage); where the runtime calls the listener
  // without it, keepAlive falls back and the cancel runs as it did before. Making
  // it reliable (a waitUntil hold registered at request time and released on
  // normal completion) is a separate follow-up, not part of this change.
  const cancelForDisconnect = () => {
    const cancelled = cancelHarnessJob({ tenantId: auth.tenantId, userId: auth.userId, jobId: queued.job.id }).catch((error) => {
      console.error("[bridge.chat.disconnect-cancel]", error instanceof Error ? error.message : String(error));
    });
    void keepAlive(cancelled, "bridge.chat.disconnect-cancel");
  };
  if (req.signal.aborted) cancelForDisconnect();
  else req.signal.addEventListener("abort", cancelForDisconnect, { once: true });
  // ---- SSE relay (+ history persistence tee) -------------------------------
  // The bytes still pass through byte-identical to the widget. On the happy
  // path we additionally TEE the stream (lib/bridge-chat-persistence) to write
  // chat_sessions/chat_messages scoped to (tenant_id, user_id, agent) — without
  // this, bridge/CLI chats (the path SunBiz employees use) never land in the
  // "Previous chats" drawer. The tee only OBSERVES a decoded copy; it never
  // alters the bytes and soft-fails so persistence can't break the relay. The
  // bearer is NOT echoed in any response header.
  const sseHeaders = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
  const deviceStream = () => {
    // Only the device branch owns bridge persistence. If a never-claimed job
    // falls back, /api/chat persists the turn and its usage exactly once.
    const persistedBody = teeBridgeChatPersistence(harnessJobStream(queued.job), {
      tenantId: auth.tenantId,
      userId: auth.userId,
      agent,
      cliProvider: effectiveCliProvider ?? `local:${savedRoute.engineName}`,
      // Stable per-conversation key = the client's tab_id (NOT Claude's per-turn
      // session id, which forks every --resume turn and would shatter history).
      conversationId: String(clientBody.tab_id || ""),
      userMessage: String(lastUserMsg.content || ""),
      startedAt,
    });
    // <dashboard-action> markers in the reply become signed proposals here
    // (2026-09-30), never writes: markers inside code are ignored, and each
    // other one is written only when the operator clicks Apply, then Confirm
    // (POST /api/bridge/actions, which logs it for /runs). Tenant, user and role
    // are this route's own authorization, never the body.
    return teeBridgeDashboardActions(persistedBody, {
      tenantId: auth.tenantId,
      userId: auth.userId,
      agent,
      teamRole: auth.teamRole,
    });
  };
  const body = savedRoute.fallback === "workspace_api"
    ? harnessJobStreamWithUnclaimedFallback(queued.job, {
        deviceStream,
        fallbackResponse: () => workspaceFallbackResponse("computer_not_answering"),
      })
    : deviceStream();
  return new Response(body, { status: 200, headers: sseHeaders });
}

function stringList(raw: unknown): string[] {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
