import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { sameOrigin } from "@/lib/calendar/http";
import { deletePipelineLead } from "@/lib/pipeline/delete-lead";
import { rateLimit } from "@/lib/rate-limit";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ ok: false, error: "same_origin_required" }, { status: 403 });
  }

  const session = await resolveSessionContext();
  if (!session.ok || !session.isTrueAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Each delete is two requests (the dry run the page shows, then the delete),
  // and an owner clearing a handful of junk leads one by one must not be cut off
  // halfway: 40 at once, refilling one every 6 seconds.
  const limited = rateLimit({
    key: "pipeline-delete:" + session.userId,
    capacity: 40,
    refillPerSec: 1 / 6,
  });
  if (!limited.allowed) {
    return NextResponse.json(
      { ok: false, error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(limited.resetIn) } },
    );
  }

  let body: { confirm?: unknown; dry_run?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const dryRun = body.dry_run === true;
  if (!dryRun && body.confirm !== "delete") {
    return NextResponse.json({ ok: false, error: "confirmation_required" }, { status: 400 });
  }

  const { id } = await context.params;
  const result = await deletePipelineLead(getServiceSupabase(), {
    tenantId: session.tenantId,
    leadId: id,
    actorUserId: session.userId,
    dryRun,
  });
  if (result.ok) return NextResponse.json(result);
  if (result.code === "not_found") return NextResponse.json(result, { status: 404 });
  if (result.code === "blocked") return NextResponse.json(result, { status: 409 });
  return NextResponse.json(result, { status: 503 });
}
