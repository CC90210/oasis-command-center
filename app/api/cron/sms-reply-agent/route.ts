import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { runSmsReplyAgentWorker, smsAgentSafeErrorCode } from "@/lib/sms/reply-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  try {
    const result = await runSmsReplyAgentWorker();
    return NextResponse.json(result, { status: result.failed > 0 ? 503 : 200 });
  } catch (error) {
    const code = smsAgentSafeErrorCode(error);
    console.error("[sms-reply-agent] worker failed", { code }, error);
    return NextResponse.json({ ok: false, error: code }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
