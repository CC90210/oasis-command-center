import { getTursoClient } from "@/lib/turso";
import { handleQuoInbound } from "@/lib/integrations/quo-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request, context: { params: Promise<{ tenantId: string }> }) {
  try {
    const { tenantId } = await context.params;
    return await handleQuoInbound(req, tenantId, { db: getTursoClient() });
  } catch {
    return Response.json({ ok: false, error: "quo_intake_unavailable" }, { status: 503 });
  }
}
