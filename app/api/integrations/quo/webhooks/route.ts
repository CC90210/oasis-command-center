import { resolveConnectionsActor } from "@/lib/connections/route-helpers";
import { publicAppBaseUrl } from "@/lib/api-helpers";
import { quoWebhookReadiness, quoWebhookUrl } from "@/lib/integrations/quo-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function handle(verify: boolean) {
  const resolved = await resolveConnectionsActor();
  if (!resolved.ok) return resolved.response;
  const tenantId = resolved.actor.tenantId;
  try {
    const origin = publicAppBaseUrl();
    const status = await quoWebhookReadiness(tenantId, origin, verify);
    return Response.json({ ok: true, ...status, inbound_url: quoWebhookUrl(origin, tenantId) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false, error: "quo_webhook_check_unavailable" }, { status: 503 });
  }
}
export async function GET() { return handle(false); }
/** Explicit owner/admin check: provider GETs only, no registration or message. */
export async function POST() { return handle(true); }
