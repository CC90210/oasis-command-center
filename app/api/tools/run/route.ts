/**
 * POST /api/tools/run - run one Toolkit tool for the signed-in person's
 * workspace, or queue it for the runner. Body: {"tool","input","idempotency_key"}.
 *
 * The gate, the validation and the run are lib/tools/session-handlers.ts
 * (handleToolRun); this file only wires the production dependencies. Anyone the
 * gate refuses gets 404, for every verb (lib/founders/method-guard.ts).
 */
import { methodNotHere } from "@/lib/founders/method-guard";
import { resolveToolsViewer } from "@/lib/tools/access";
import { r2ToolStorage } from "@/lib/tools/runner-handlers";
import { handleToolRun } from "@/lib/tools/session-handlers";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  if (!tursoConfigured()) {
    return Response.json({ ok: false, error: "not_set_up", message: "Tools are not set up yet." }, { status: 503 });
  }
  try {
    return await handleToolRun(req, { db: getTursoClient(), now: () => new Date(), viewer: resolveToolsViewer, storage: r2ToolStorage });
  } catch (err) {
    console.error("[tools.run] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "run_failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

export const GET = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
