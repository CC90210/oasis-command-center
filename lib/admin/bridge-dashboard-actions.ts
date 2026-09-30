/**
 * The <dashboard-action> markers in a bridge (Coding harness) reply
 * (2026-09-30): proposed to the operator, written only when the operator
 * confirms each one.
 *
 * The bridge's own prompt tells Claude Code that "the dashboard parses these
 * post-stream and applies them server-side, tenant-scoped, audit-logged". Only
 * the cloud path (/api/chat) ever did; /api/bridge/chat relayed the stream
 * untouched, so a change asked for in the harness was stripped from the bubble
 * and never applied or logged, and /runs stayed empty.
 *
 * NOTHING IS WRITTEN ON STREAM CLOSE. The harness exists to talk about code,
 * and a reply that quotes or illustrates the marker protocol (the bridge prompt
 * teaches it; lib/agent-personas.ts holds a full create_record example with
 * sample data) would otherwise write that example to production. So:
 *
 *   1. Markers inside fenced code blocks or inline code spans are not read at
 *      all (stripCode): code the reply shows is never an instruction.
 *   2. Every other marker becomes an `event: action_pending` frame carrying the
 *      exact type and payload, an expiry, and a signature bound to this
 *      session's tenant, user and agent (lib/resume-hmac, the key /api/chat
 *      already signs its resume tokens with). The widget shows it as a
 *      proposed change with Apply, then Confirm.
 *   3. The operator's confirm POSTs /api/bridge/actions, which re-authorizes
 *      the session (lib/bridge-proxy), verifies the signature against THAT
 *      session's identity, re-checks the role, then runs it through the same
 *      runAction the cloud path uses and logs it through logAction, so /runs
 *      fills. A token minted for another user, tenant or agent, an edited
 *      payload, or an expired one is refused and nothing runs.
 *
 * A marker that could never run (an unknown type, or a role that may not write
 * the CRM) is refused up front as an `event: action` frame and logged, so the
 * operator is never asked to confirm something that cannot happen.
 *
 * FRAMES, NOT CHUNKS. The relay forwards whole SSE frames. A network chunk can
 * end mid-frame (normal for a proxied or tunnelled stream); inserting the
 * proposal frames before a raw chunk would land them inside the partial frame,
 * the widget would parse the proposal as a `delta`, and the rest of the real
 * delta would be lost. Frames are split on the blank line the bridge and the
 * widget both use, and forwarded byte-for-byte.
 */

import "server-only";

import { extractActionMarkers, knownActionTypes, runAction, type ActionResult } from "@/lib/agent-actions";
import { logAction } from "@/lib/action-log";
import { READ_ONLY_DENIED_MARKERS, canWriteCrm } from "@/lib/role-gates";
import { signResumeState, verifyResumeState, type ResumeBinding } from "@/lib/resume-hmac";

export type BridgeActionContext = {
  tenantId: string;
  userId: string;
  agent: string;
  teamRole: string;
};

export type BridgeActionDeps = {
  run?: typeof runAction;
  log?: typeof logAction;
};

/** How long a proposed change can be confirmed. After that, ask the harness again. */
export const PENDING_ACTION_TTL_MS = 30 * 60_000;
const PENDING_KIND = "bridge_dashboard_action.v1";

/** What the widget receives for one proposed change, and posts back on confirm. */
export type PendingBridgeAction = {
  type: string;
  payload: Record<string, unknown>;
  /** Epoch ms after which the confirm is refused. */
  exp: number;
  token: string;
};

// ── Code is not an instruction ────────────────────────────────────────────

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Remove fenced code blocks (``` or ~~~, closed by a fence of the same
 * character at least as long; an unclosed fence runs to the end, as in
 * CommonMark) and inline code spans (a run of N backticks closed by the next
 * run of exactly N). What is left is the prose the reply addresses to the
 * dashboard.
 */
export function stripCode(text: string): string {
  const kept: string[] = [];
  let fence: { char: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, "");
}

// ── Proposals ─────────────────────────────────────────────────────────────

function bindingFor(ctx: BridgeActionContext): ResumeBinding {
  return { tenant_id: ctx.tenantId, user_id: ctx.userId, agent_key: ctx.agent };
}

function signedState(type: string, payload: Record<string, unknown>, exp: number) {
  return { kind: PENDING_KIND, type, payload, exp };
}

/**
 * PURE apart from signing. The reply's markers outside code, split into the
 * changes to propose and the ones refused up front.
 */
export function proposeBridgeMarkers(
  text: string,
  ctx: BridgeActionContext,
  now: number = Date.now(),
): { pending: PendingBridgeAction[]; refused: ActionResult[] } {
  const known = new Set(knownActionTypes());
  const pending: PendingBridgeAction[] = [];
  const refused: ActionResult[] = [];
  for (const spec of extractActionMarkers(stripCode(text))) {
    if (!known.has(spec.type)) {
      refused.push({ ok: false, type: spec.type, error: `unknown_action:${spec.type}` });
      continue;
    }
    if (!canWriteCrm(ctx.teamRole) && READ_ONLY_DENIED_MARKERS.has(spec.type)) {
      refused.push({ ok: false, type: spec.type, error: "forbidden_role" });
      continue;
    }
    const exp = now + PENDING_ACTION_TTL_MS;
    const token = signResumeState(signedState(spec.type, spec.payload, exp), bindingFor(ctx));
    if (token === null) {
      // Production with no signing key: a proposal nobody could confirm is
      // refused here, loudly, instead of shown as a button that always fails.
      console.error("[bridge.dashboard_action] signing key missing; proposal refused", spec.type);
      refused.push({ ok: false, type: spec.type, error: "signing_unavailable" });
      continue;
    }
    pending.push({ type: spec.type, payload: spec.payload, exp, token });
  }
  return { pending, refused };
}

async function logResult(result: ActionResult, ctx: BridgeActionContext, log: typeof logAction): Promise<void> {
  await log({
    agent_key: ctx.agent,
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    type: result.type,
    ok: result.ok,
    summary: result.ok ? result.summary : undefined,
    error: result.ok ? undefined : result.error,
  });
}

// ── Confirm ───────────────────────────────────────────────────────────────

/**
 * Run one proposed change the operator confirmed. `ctx` is the confirming
 * request's own authorization (never the body). Never throws.
 */
export async function applyPendingBridgeAction(
  input: Record<string, unknown>,
  ctx: BridgeActionContext,
  deps: BridgeActionDeps = {},
  now: number = Date.now(),
): Promise<{ status: number; result: ActionResult }> {
  const run = deps.run ?? runAction;
  const log = deps.log ?? logAction;
  const type = typeof input.type === "string" ? input.type : "";
  const payload = input.payload;
  const exp = typeof input.exp === "number" ? input.exp : NaN;
  // "" is what an unsigned development build mints (lib/resume-hmac); the
  // verifier decides whether that is acceptable, not this shape check.
  const token = typeof input.token === "string" ? input.token : null;
  const refuse = (status: number, error: string) => ({ status, result: { ok: false as const, type: type || "?", error } });

  if (!/^[a-z_]+$/.test(type) || !payload || typeof payload !== "object" || Array.isArray(payload) || !Number.isFinite(exp) || token === null) {
    return refuse(400, "invalid_request");
  }
  const spec = { type, payload: payload as Record<string, unknown> };
  const check = verifyResumeState(signedState(spec.type, spec.payload, exp), token, bindingFor(ctx));
  if (!check.ok) {
    console.error("[bridge.dashboard_action] confirm refused", type, check.reason);
    return refuse(check.reason === "server_misconfigured" ? 503 : 403, `not_confirmable:${check.reason}`);
  }
  if (now > exp) return refuse(410, "expired");

  let result: ActionResult;
  if (!canWriteCrm(ctx.teamRole) && READ_ONLY_DENIED_MARKERS.has(type)) {
    result = { ok: false, type, error: "forbidden_role" };
  } else {
    try {
      result = await run(spec, { tenantId: ctx.tenantId, authUserId: ctx.userId, userId: ctx.userId, isAdmin: ctx.teamRole === "owner" || ctx.teamRole === "admin" });
    } catch (err) {
      console.error("[bridge.dashboard_action]", type, err instanceof Error ? err.message : err);
      result = { ok: false, type, error: err instanceof Error ? err.message : "action_failed" };
    }
  }
  await logResult(result, ctx, log);
  return { status: result.ok || result.error !== "forbidden_role" ? 200 : 403, result };
}

// ── The relay ─────────────────────────────────────────────────────────────

function parseFrame(block: string): { event: string; data: string } {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data = line.slice(5).trim();
  }
  return { event, data };
}

/**
 * Wrap the relayed bridge SSE body: whole frames pass through unchanged; at
 * the terminal `done` frame (or at the end, when none came) the reply's
 * markers become proposal and refusal frames, placed before `done`. Nothing is
 * applied here.
 */
export function teeBridgeDashboardActions(
  upstream: ReadableStream<Uint8Array>,
  ctx: BridgeActionContext,
  deps: BridgeActionDeps = {},
): ReadableStream<Uint8Array> {
  const log = deps.log ?? logAction;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let assistant = "";
  let settled = false;

  async function actionFrames(): Promise<string> {
    if (settled) return "";
    settled = true;
    const { pending, refused } = proposeBridgeMarkers(assistant, ctx);
    for (const r of refused) await logResult(r, ctx, log);
    return [
      ...refused.map((r) => `event: action\ndata: ${JSON.stringify(r)}\n\n`),
      ...pending.map((p) => `event: action_pending\ndata: ${JSON.stringify(p)}\n\n`),
    ].join("");
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      let out = "";
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const { event, data } = parseFrame(block);
        if (event === "done") {
          out += await actionFrames();
        } else if (event === "delta" && data) {
          try {
            const parsed = JSON.parse(data) as { text?: unknown };
            if (typeof parsed.text === "string") assistant += parsed.text;
          } catch (err) {
            console.error("[bridge.dashboard_action.frame]", err instanceof Error ? err.message : err);
          }
        }
        out += `${block}\n\n`;
      }
      if (out) controller.enqueue(encoder.encode(out));
    },
    async flush(controller) {
      buf += decoder.decode();
      // The stream ended without `done`: proposals first, then whatever
      // unterminated remainder the bridge sent, so neither lands inside the other.
      const out = (await actionFrames()) + buf;
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
  return upstream.pipeThrough(transform);
}
