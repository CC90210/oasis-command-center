import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { cronPauseGate } from "@/lib/automations/cron-switches";
import { runSmsReplyAgentWorker, smsAgentSafeErrorCode } from "@/lib/sms/reply-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const paused = await cronPauseGate(req);
  if (paused) return paused;
  try {
    const result = await runSmsReplyAgentWorker();
    // Dead-letter/attempt state already advanced. Let the next scheduled pass
    // own retries rather than masking this failure with a second empty run.
    return NextResponse.json({ ...result, ok: result.failed === 0 }, { status: result.failed > 0 ? 409 : 200 });
  } catch (error) {
    const code = smsAgentSafeErrorCode(error);
    console.error("[sms-reply-agent] worker failed", { code }, error);
    return NextResponse.json({ ok: false, error: code }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
