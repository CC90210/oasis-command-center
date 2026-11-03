/**
 * POST /api/internal/vps-control - the daemon VPS's switch applier (BEA
 * scripts/ops/vps_unit_control.py, root timer every 30 s) reports what it did and fetches CC's
 * on/off switches for its workers. Machine-to-machine: HMAC with the Worker's CRON_SECRET, checked
 * inside before anything is parsed. The work: lib/automations/vps-unit-control.ts.
 */
import { handleVpsControlPoll } from "@/lib/automations/vps-unit-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleVpsControlPoll(req);
}
