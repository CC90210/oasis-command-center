/**
 * GET /api/os/runs/<id>/stream?after=<seq> - follow a run you already have.
 *
 * How a page that left comes back: it asks for everything after the last seq it
 * saw (0 for a page that never saw the run), gets the saved events in order,
 * then the live ones. The stream lasts TAIL_WINDOW_MS and ends with a `window`
 * frame; the browser asks again from the last seq. A run that is over ends the
 * stream with an `end` frame carrying its final answer (the reply events are
 * dropped when a run ends).
 *
 * Read-only for the run, with one exception: a queued run whose driver is gone
 * (the tab that sent it closed) gets a driver here, so the message still runs.
 * That follower then stays until the run ends, because a driver must keep its
 * connection open.
 */
import { type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { RunsUnavailableError, getRun } from "@/lib/os/runs/store";
import { resolveRunScope, json } from "@/lib/os/runs/scope";
import { resolveRunSession } from "@/lib/os/runs/session";
import { executorDepsFor } from "@/lib/os/runs/turn-starter";
import { driveConversation } from "@/lib/os/runs/executor";
import { keepAlive } from "@/lib/os/runs/keepalive";
import { followRun } from "@/lib/os/runs/follow";
import { sseResponse } from "@/lib/os/runs/sse";
import { TAIL_WINDOW_MS } from "@/lib/os/runs/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** A driver started here keeps the connection this long at most. */
const MAX_DRIVE_MS = 14 * 60_000;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const scoped = await resolveRunScope();
  if (!scoped.ok) return json(scoped.status, { ok: false, error: scoped.error });
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });
  const afterRaw = Number(req.nextUrl.searchParams.get("after") ?? "0");
  const after = Number.isInteger(afterRaw) && afterRaw >= 0 ? afterRaw : 0;

  try {
    const db = getTursoClient();
    const run = await getRun(db, scoped.scope, id);
    if (!run) return json(404, { ok: false, error: "run_not_found" });

    let gone = false;
    let driving = false;
    const frames = followRun({
      db,
      scope: scoped.scope,
      runId: id,
      afterSeq: after,
      windowMs: () => (driving ? MAX_DRIVE_MS : TAIL_WINDOW_MS),
      gone: () => gone,
      needDriver: async () => {
        // The full session is needed only to START a turn; resolved here, in the request.
        const resolved = await resolveRunSession({ department: run.department });
        if (!resolved.ok) return;
        driving = true;
        await keepAlive(driveConversation(executorDepsFor(resolved.session, db), run.conversationId), `drive:${run.conversationId}`);
      },
    });
    return sseResponse(frames, { onGone: () => (gone = true) });
  } catch (err) {
    if (err instanceof RunsUnavailableError) return json(503, { ok: false, error: "chat_history_unavailable" });
    console.error("[os.runs.stream]", { runId: id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return json(500, { ok: false, error: "stream_failed" });
  }
}
