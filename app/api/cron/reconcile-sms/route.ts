/**
 * GET+POST /api/cron/reconcile-sms — closes the loop on SMS delivery.
 *
 * TextTorrent returns HTTP 201 for a message the carrier will refuse. The real
 * verdict lands on the message object afterwards. This run reads it, closes the
 * receipts, and pages if the route has gone dead.
 *
 * Between 2026-07-27 and 2026-08-07 that gap hid 51 consecutive failed sends
 * across ten days, all billed, all recorded as 'sent'. Every fifteen minutes is
 * enough to catch the next one within one dispatch cycle.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { sendTelegram } from "@/lib/notify/telegram";
import { reconcileReceipts } from "@/lib/sms/delivery-receipts";
import { smsSendAllowed, resetBreakerCache } from "@/lib/sms/send-breaker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUNBIZ_TENANT_ID = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  try {
    const r = await reconcileReceipts(SUNBIZ_TENANT_ID);

    // Fresh verdicts landed, so the cached one is stale. Forcing a re-read here
    // means a recovered route resumes on the next dispatch rather than up to a
    // minute later, and a newly dead one halts just as fast.
    resetBreakerCache(SUNBIZ_TENANT_ID);
    const breaker = await smsSendAllowed(SUNBIZ_TENANT_ID, { force: true });

    if (breaker.halt) {
      // The breaker itself pages through writeAgentAlert on the send path, which
      // dedupes per open condition. This line is the reconciler's own summary so
      // the numbers behind the halt are visible without opening the database.
      await sendTelegram(
        `🔴 <b>SMS carrier route is refusing sends</b>\n` +
          `${esc(breaker.reason)}\n` +
          `sample: ${breaker.sample} recent verdicts, ${Math.round(breaker.failRatio * 100)}% failed\n` +
          `<i>drip SMS is halted and rescheduling; TextTorrent returns HTTP 201 on these</i>`,
        { lane: "sunbiz-ops" },
      ).catch(() => undefined);
    }

    if (r.errors.length) {
      await sendTelegram(
        `⚪ <b>SMS reconcile had errors</b>\n${esc(r.errors.slice(0, 3).join("; ")).slice(0, 400)}`,
        { lane: "sunbiz-ops" },
      ).catch(() => undefined);
    }

    return NextResponse.json({ ok: true, ...r, breaker });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reconcile-sms] failed", message);
    // A reconciler that cannot run is not a pass. Surface it as a non-200 so the
    // cron shows red rather than reporting a quiet success with zero work done.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
