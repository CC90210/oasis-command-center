/**
 * Apply and log the <dashboard-action> markers in a bridge (Coding harness)
 * reply (2026-09-30).
 *
 * The bridge's own prompt tells Claude Code that "the dashboard parses these
 * post-stream and applies them server-side, tenant-scoped, audit-logged". Only
 * the cloud path (/api/chat) ever did. /api/bridge/chat relayed the stream
 * untouched, so a change asked for in the harness was shown to the operator,
 * stripped from the bubble, and never applied or logged: /runs stayed empty.
 *
 * This wraps the relayed SSE body. Bytes pass through unchanged; a decoded copy
 * accumulates the assistant text. When the bridge's terminal `done` frame
 * arrives (or the stream ends without one), every marker is applied through
 * the same runAction the cloud path uses, logged through logAction, and an
 * `event: action` frame per result goes to the widget before `done`, which the
 * widget already renders as an action pill. Applied once, never twice.
 *
 * Gates, as /api/chat: the tenant and user come from the server's own bridge
 * authorization (never the request body); a role that may not write the CRM
 * gets forbidden_role for READ_ONLY_DENIED_MARKERS, logged like any other
 * result.
 */

import "server-only";

import { extractActionMarkers, runAction, type ActionResult } from "@/lib/agent-actions";
import { logAction } from "@/lib/action-log";
import { READ_ONLY_DENIED_MARKERS, canWriteCrm } from "@/lib/role-gates";

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

/** Apply every marker in `text`; returns the results in order. Never throws. */
export async function applyBridgeMarkers(
  text: string,
  ctx: BridgeActionContext,
  deps: BridgeActionDeps = {},
): Promise<ActionResult[]> {
  const run = deps.run ?? runAction;
  const log = deps.log ?? logAction;
  const isAdmin = ctx.teamRole === "owner" || ctx.teamRole === "admin";
  const results: ActionResult[] = [];
  for (const spec of extractActionMarkers(text)) {
    let result: ActionResult;
    if (!canWriteCrm(ctx.teamRole) && READ_ONLY_DENIED_MARKERS.has(spec.type)) {
      result = { ok: false, type: spec.type, error: "forbidden_role" };
    } else {
      try {
        result = await run(spec, { tenantId: ctx.tenantId, authUserId: ctx.userId, userId: ctx.userId, isAdmin });
      } catch (err) {
        console.error("[bridge.dashboard_action]", spec.type, err instanceof Error ? err.message : err);
        result = { ok: false, type: spec.type, error: err instanceof Error ? err.message : "action_failed" };
      }
    }
    results.push(result);
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
  return results;
}

/**
 * Wrap the relayed bridge SSE body: bytes unchanged, markers applied once at
 * the terminal frame (or at the end), one `event: action` frame per result.
 */
export function teeBridgeDashboardActions(
  upstream: ReadableStream<Uint8Array>,
  ctx: BridgeActionContext,
  deps: BridgeActionDeps = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let assistant = "";
  let applied = false;

  async function actionFrames(): Promise<Uint8Array[]> {
    if (applied) return [];
    applied = true;
    const results = await applyBridgeMarkers(assistant, ctx, deps);
    return results.map((r) => encoder.encode(`event: action\ndata: ${JSON.stringify(r)}\n\n`));
  }

  function readFrames(chunk: Uint8Array): boolean {
    let sawDone = false;
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (event === "done") {
        sawDone = true;
        continue;
      }
      if (event !== "delta" || !data) continue;
      try {
        const parsed = JSON.parse(data) as { text?: unknown };
        if (typeof parsed.text === "string") assistant += parsed.text;
      } catch (err) {
        console.error("[bridge.dashboard_action.frame]", err instanceof Error ? err.message : err);
      }
    }
    return sawDone;
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      const sawDone = readFrames(chunk);
      if (sawDone) for (const frame of await actionFrames()) controller.enqueue(frame);
      controller.enqueue(chunk);
    },
    async flush(controller) {
      for (const frame of await actionFrames()) controller.enqueue(frame);
    },
  });
  return upstream.pipeThrough(transform);
}
