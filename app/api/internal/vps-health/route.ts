/**
 * POST /api/internal/vps-health - the daemon VPS reports its two always-on workers (the Telegram
 * bridge and the inbox sweep) every minute, so the Automations panel shows their live health.
 * Machine-to-machine: HMAC with the Worker's CRON_SECRET, checked inside before anything is parsed.
 * The work: lib/automations/vps-health.ts.
 */
import { handleVpsHeartbeat } from "@/lib/automations/vps-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleVpsHeartbeat(req);
}
