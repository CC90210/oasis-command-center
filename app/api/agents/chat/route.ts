/**
 * POST /api/agents/chat
 *
 * Streaming chat with any marketplace agent — built-in seed or tenant-
 * custom. The effective system prompt is:
 *
 *   1. Look up the agent in the library (DB-first, seed fallback).
 *   2. Interpolate {{tenant.*}} / {{operator.*}} placeholders from the
 *      tenant's manifest.
 *   3. Append the manifest binding's prompt_overlay (per-tenant customisation).
 *
 * Why this isn't /api/chat: that route hardcodes the agent_key validation
 * (bravo/atlas/maven/aura/hermes) and is tightly bound to persona files +
 * dashboard-context injection. Custom agents from the marketplace need a
 * different shape — no persona file, no dashboard-context block,
 * tenant-specific overlays applied per call. Splitting endpoints keeps
 * both paths simple.
 *
 * Body:
 *   {
 *     tenant_slug?: string,         // optional; must be a slug the caller OWNS
 *     agent_slug:   string,
 *     department?:  DepartmentKey,  // set by a department channel (/team/<dept>)
 *     messages:     ChatMessage[]   // rolling history maintained client-side
 *   }
 *
 * THE WORKSPACE COMES FROM THE SESSION. The caller's active profile (the same
 * resolver the /team pages use, so a multi-workspace user chats in the
 * workspace they are standing in) names the tenant; the manifest slug is the
 * one that tenant owns (lib/manifest/tenant-scope.ts). A body `tenant_slug` is
 * only accepted when the caller owns it, and refused with 403 otherwise: it
 * used to be checked for existence alone, which loaded ANY workspace's
 * manifest (brand, overlays) into the caller's prompt on the caller's key.
 *
 * A DEPARTMENT CHANNEL speaks as its department (lib/os/channel/identity.ts):
 * the `agent` event names the department, the persona's own name in its prompt
 * becomes the department, and the identity lock names only the department. The
 * agent must be the one this workspace binds to that department
 * (components/os/department/config.ts), or the request is refused.
 *
 * THE TURN IS SHARED. Everything after the session (the department binding,
 * the agent, the key, the budget, the prompt and the meter) is
 * lib/os/department-agent.ts prepareAgentTurn, the same session-less function a
 * Slack mention runs, so the web channel and Slack follow one set of rules.
 *
 * Provider: the WORKSPACE's own AI account (lib/ai/workspace-account.ts; a
 * teammate's personal key never answers a shared channel), or the platform key
 * for the verified operator only.
 *
 * Every turn that reaches a key has its outcome (ok, or a failure code from
 * lib/os/channel/outcome.ts) recorded as its channel's last turn
 * (lib/os/channel/turns.ts), which the department header reads; a 412 (no key
 * to try) is not. Every failure is logged with the tenant, the department or
 * agent, and the code (never message content, never a key).
 *
 * Response: text/event-stream SSE
 *   event: agent       data: { display_name, agent_slug | department, model?,
 *                              runs_on?, spend?, fell_back_from? }
 *                      (model only for the verified operator; runs_on/spend,
 *                      what answered and on whose credits, for owners, admins
 *                      and the operator: lib/ai/agent-engine.ts)
 *   event: delta       data: { text }
 *   event: usage       data: { input_tokens, output_tokens }
 *   event: done        data: {}
 *   event: error       data: { code, message }   (message: one plain sentence)
 */

import { type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/supabase-server";
import { resolveActiveProfileForUser } from "@/lib/active-profile-resolver";
import type { ChatMessage } from "@/lib/providers";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { operatorPlatformFallback } from "@/lib/operator-credentials";
import { redactAll } from "@/lib/secret-redaction";
import { manifestExists } from "@/lib/manifest/loader";
import { ownsSlug, resolveOwnedSlug } from "@/lib/manifest/tenant-scope";
import { operatorNameOverride } from "@/lib/operator-name";
import { getTursoClient } from "@/lib/turso";
import { OS_DEPARTMENTS, type OsDepartment } from "@/lib/os/departments";
import { classifyStreamError, failureCopy, type TurnFailureCode } from "@/lib/os/channel/outcome";
import { recordTurnOutcome } from "@/lib/os/channel/turns";
import type { AiBudgetCode } from "@/lib/ai/usage";
import { modelFactsForCopy } from "@/lib/ai/model-registry";
import { isAdminProfile } from "@/lib/lead-scope";
import { prepareAgentTurn, streamAgentTurn } from "@/lib/os/department-agent";
import { bridgeCallerForSession } from "@/lib/ai/bridge-turn";
import { DEPARTMENT_REPLY_MAX_TOKENS } from "@/lib/os/channel/reply-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Body = {
  tenant_slug?: string;
  agent_slug?: string;
  department?: string;
  messages?: ChatMessage[];
  /** Plan vs Build mode parity with /api/chat. "plan" appends the OpenCode-
   *  style plan overlay to the system prompt so the agent stays in
   *  research-and-propose mode until the operator types /build. Default
   *  is "build" (full agent behavior). */
  chat_mode?: "plan" | "build";
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type FailureContext = {
  tenantId: string | null;
  department: string | null;
  agentSlug: string | null;
};

/**
 * One log line per failed turn or refused request: who (tenant), where
 * (department or agent) and why (code). Never message content, never a key;
 * `detail` is only passed for a failure we could not classify, redacted and
 * cut short, so an unknown provider error is still diagnosable.
 */
function logFailure(stage: "pre_stream" | "stream", ctx: FailureContext, code: string, extra: Record<string, unknown> = {}) {
  console.error("[agents.chat.failure]", {
    stage,
    tenantId: ctx.tenantId,
    department: ctx.department,
    agentSlug: ctx.agentSlug,
    code,
    ...extra,
  });
}

/** A pre-stream refusal: logged, then answered as JSON. */
function refuse(ctx: FailureContext, status: number, error: string, extra: Record<string, unknown> = {}): Response {
  logFailure("pre_stream", ctx, error, { status });
  return jsonResponse(status, { ok: false, error, ...extra });
}

/**
 * Record a turn as its channel's last. Never fails the turn: a write that
 * cannot happen is logged (lib/os/channel/turns.ts logs a missing table once).
 */
async function recordTurn(
  ctx: FailureContext & { tenantId: string; channelKey: string; agentSlug: string },
  ok: boolean,
  code: TurnFailureCode | null,
): Promise<void> {
  try {
    await recordTurnOutcome(getTursoClient(), {
      tenantId: ctx.tenantId,
      channelKey: ctx.channelKey,
      agentSlug: ctx.agentSlug,
      ok,
      code,
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[agents.chat.record_turn]", {
      tenantId: ctx.tenantId,
      department: ctx.department,
      agentSlug: ctx.agentSlug,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return refuse({ tenantId: null, department: null, agentSlug: null }, 401, "unauthorized");

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return refuse({ tenantId: null, department: null, agentSlug: null }, 400, "invalid_json");
  }

  const requestedSlug = (body.tenant_slug || "").trim().toLowerCase();
  const agentSlug = (body.agent_slug || "").trim().toLowerCase();
  const departmentKey = typeof body.department === "string" ? body.department.trim() : "";
  const ctx: FailureContext = { tenantId: null, department: departmentKey || null, agentSlug: agentSlug || null };
  if (!agentSlug) return refuse(ctx, 400, "agent_slug_required");
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  if (!lastUser) return refuse(ctx, 400, "no_user_message");

  // The workspace is the session's ACTIVE one: the profile resolver the
  // /team pages use (lib/api-auth resolveSessionContext), not a
  // `.maybeSingle()` over user_profiles, which errors for anyone with a seat
  // in two workspaces and would leave them unable to chat anywhere.
  const resolved = await resolveActiveProfileForUser(user);
  if (resolved.error) return refuse(ctx, 503, "profile_unavailable");
  const profile = resolved.profile;
  if (!profile?.tenant_id) return refuse(ctx, 403, "no_tenant");
  const tenantId = profile.tenant_id;
  ctx.tenantId = tenantId;

  // The manifest slug: the one this tenant owns, or a requested one it owns.
  let tenantSlug: string | null;
  if (requestedSlug) {
    tenantSlug = (await ownsSlug(requestedSlug, tenantId)) ? requestedSlug : null;
    if (!tenantSlug) return refuse(ctx, 403, "slug_not_owned");
  } else {
    tenantSlug = ((await resolveOwnedSlug(tenantId)) || "").toLowerCase() || null;
  }
  if (!tenantSlug || !(await manifestExists(tenantSlug))) return refuse(ctx, 400, "unknown_tenant");

  let dept: OsDepartment | null = null;
  if (departmentKey) {
    dept = OS_DEPARTMENTS.find((d) => d.key === departmentKey) ?? null;
    if (!dept) return refuse(ctx, 400, "unknown_department");
  }

  // The model id is operator detail, and the platform key bills OASIS: both
  // for the verified operator only (lib/platform-operator.ts). Read once.
  // One exception, below: a model the provider says was not found is named to
  // the people who can pick another one (PR #555 review).
  const isOperator = await isPlatformOperatorForAuthUser(user.id, user.email);
  // An owner or admin (lib/lead-scope.ts isAdminProfile: the founder persona,
  // the rule the channel's AI settings link follows) may change the model.
  const canManageAi = isAdminProfile(profile);
  const fallback = isOperator ? operatorPlatformFallback() : null;
  // Hardwired per-account override (lib/operator-name.ts) wins, e.g. the Matt
  // account's operator.name resolves to "Uri".
  const operatorName =
    operatorNameOverride({ authUserId: user.id, email: user.email }) ||
    profile.display_name ||
    profile.full_name ||
    "Operator";

  // The turn itself (binding, agent, key, budget, prompt, meter) is the same
  // session-less function a Slack mention runs (lib/os/department-agent.ts).
  const prepared = await prepareAgentTurn({
    tenantId,
    tenantSlug,
    agentSlug,
    department: dept,
    operator: { name: operatorName, email: user.email || "" },
    platformFallback: fallback,
    revealModel: isOperator,
    // A local model account answers for the verified operator only.
    localModelAllowed: isOperator,
    userId: user.id,
    chatMode: body.chat_mode,
    // What powers your agents may be an AI app on the paired computer: reached
    // by the coding harness's own gate, asked only when that is the choice.
    bridge: () => bridgeCallerForSession(tenantId),
  });
  if (!prepared.ok) {
    // A refusal that is a verdict on the workspace's AI account (an unreadable
    // key, the month's cap) is its channel's last turn; one where no key was
    // tried is not (it would overwrite a real refusal).
    if (prepared.recordAs && prepared.agentSlug && prepared.channelKey) {
      await recordTurn({ ...ctx, tenantId, agentSlug: prepared.agentSlug, channelKey: prepared.channelKey }, false, prepared.recordAs);
    }
    if (prepared.status === 402) {
      // The month's AI budget (lib/ai/usage.ts): answered before a stream opens.
      const exhausted = prepared.error as AiBudgetCode;
      return refuse(ctx, 402, exhausted, { message: failureCopy(exhausted, { canManageAi: false }).sentence });
    }
    return refuse(ctx, prepared.status, prepared.error, prepared.extra ?? {});
  }
  const t = prepared.turn;
  const turn = { ...ctx, tenantId, agentSlug: t.agentSlug, channelKey: t.channelKey };

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      send("agent", {
        display_name: t.displayName,
        ...(t.department ? { department: t.department.key } : { agent_slug: t.agentSlug }),
        ...(t.revealModel ? { model: t.model } : {}),
        // What answered and whose credits or plan it used, in plain words
        // (lib/ai/agent-engine.ts), for owners, admins and the operator: the
        // people who choose it in Settings > AI brain.
        ...(t.revealModel || canManageAi
          ? { runs_on: t.engine.runsOn, spend: t.engine.spend, ...(t.engine.fellBackFrom ? { fell_back_from: t.engine.fellBackFrom } : {}) }
          : {}),
      });

      // One code per failed turn. The client gets the code and one plain
      // sentence; the provider's own error body is never forwarded. A model
      // the provider says was not found is NAMED (with what to pick instead)
      // to whoever can pick another, an owner or admin or the verified
      // operator, so the channel says which model, not just "the model".
      // Anyone else gets the plain sentence and no model: the id is the
      // workspace's configuration, theirs only to report (PR #555 review).
      const outcome: { failure: TurnFailureCode | null } = { failure: null };
      const fail = (code: TurnFailureCode, detail: string | null) => {
        if (outcome.failure) return;
        outcome.failure = code;
        logFailure("stream", ctx, code, {
          provider: t.provider,
          ...(code === "provider_404" ? { model: t.model } : {}),
          ...(detail && (code === "provider_error" || code === "stream_failed")
            ? { detail: redactAll(detail).slice(0, 160) }
            : {}),
        });
        const model = code === "provider_404" && (canManageAi || t.revealModel) ? modelFactsForCopy(t.provider, t.model) : null;
        send("error", { code, message: failureCopy(code, { canManageAi: false, model }).sentence, ...(model ? { model } : {}) });
      };
      try {
        for await (const ev of streamAgentTurn(t, incoming, DEPARTMENT_REPLY_MAX_TOKENS)) {
          if (ev.type === "delta") {
            send("delta", { text: ev.text });
          } else if (ev.type === "done") {
            send("usage", { input_tokens: ev.inputTokens, output_tokens: ev.outputTokens });
          } else if (ev.type === "error") {
            fail(classifyStreamError(ev.message), ev.message);
          }
        }
      } catch (err) {
        fail("stream_failed", err instanceof Error ? err.message : "stream_failed");
      }
      await recordTurn(turn, outcome.failure === null, outcome.failure);
      send("done", {});
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
