/**
 * POST /api/os/runs/<id>/stop - stop one of your runs.
 *
 * Queued: cancelled at once; it never called a model, so it writes nothing to
 * the AI usage ledger. Running: the driver is asked; it ends the model call
 * (which records `cancelled` in the ledger) and finishes the run as cancelled,
 * with the part of the reply already written kept. Messages queued behind it
 * still run: Stop is for this one run.
 */
import { type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { RunsUnavailableError, requestCancel } from "@/lib/os/runs/store";
import { resolveRunScope, json } from "@/lib/os/runs/scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const scoped = await resolveRunScope();
  if (!scoped.ok) return json(scoped.status, { ok: false, error: scoped.error });
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });
  try {
    const result = await requestCancel(getTursoClient(), scoped.scope, id, new Date());
    if (result === "not_found") return json(404, { ok: false, error: "run_not_found" });
    return json(200, { ok: true, result });
  } catch (err) {
    if (err instanceof RunsUnavailableError) return json(503, { ok: false, error: "chat_history_unavailable" });
    console.error("[os.runs.stop]", { runId: id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return json(500, { ok: false, error: "stop_failed" });
  }
}
