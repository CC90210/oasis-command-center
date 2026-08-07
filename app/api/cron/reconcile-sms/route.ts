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
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { reconcileReceipts, tenantsWithOpenReceipts } from "@/lib/sms/delivery-receipts";
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
    // Reconcile EVERY tenant with open receipts, not just SunBiz. The executor
    // opens receipts under each drip row's own tenant_id, so pinning this to one
    // tenant would leave every other tenant's receipts open forever — and an
    // all-open history reads as "nothing terminal yet", which the breaker
    // permits. The protection would silently cover one tenant on a multi-tenant
    // platform. SunBiz is always included so a run still happens when the queue
    // is empty.
    const discovered = await tenantsWithOpenReceipts();
    if (discovered === null) {
      // Could not enumerate. Not the same as "no work": say so loudly rather
      // than reporting a clean run over a queue we never saw.
      return NextResponse.json(
        { ok: false, error: "could not enumerate tenants with open receipts" },
        { status: 500 },
      );
    }
    const tenants = [...new Set([SUNBIZ_TENANT_ID, ...discovered])];

    const perTenant: Record<string, Awaited<ReturnType<typeof reconcileReceipts>>> = {};
    for (const t of tenants) perTenant[t] = await reconcileReceipts(t);

    const r = Object.values(perTenant).reduce(
      (acc, x) => ({
        examined: acc.examined + x.examined,
        resolved: acc.resolved + x.resolved,
        delivered: acc.delivered + x.delivered,
        failed: acc.failed + x.failed,
        stillOpen: acc.stillOpen + x.stillOpen,
        abandoned: acc.abandoned + x.abandoned,
        errors: [...acc.errors, ...x.errors],
      }),
      { examined: 0, resolved: 0, delivered: 0, failed: 0, stillOpen: 0, abandoned: 0, errors: [] as string[] },
    );

    // Fresh verdicts landed, so every cached one is stale. Forcing a re-read
    // means a recovered route resumes on the next dispatch rather than up to a
    // minute later, and a newly dead one halts just as fast.
    for (const t of tenants) resetBreakerCache(t);
    const breakers: Record<string, Awaited<ReturnType<typeof smsSendAllowed>>> = {};
    for (const t of tenants) breakers[t] = await smsSendAllowed(t, { force: true });
    const breaker = breakers[SUNBIZ_TENANT_ID];
    const halted = tenants.filter((t) => breakers[t]?.halt);

    // Page through writeAgentAlert, NOT raw sendTelegram. This cron runs every
    // 15 minutes, so a raw send would produce up to 96 identical pages a day for
    // one ongoing outage. telegramOncePerOpen fires once per open condition and
    // goes quiet until it clears, which is the standing alert-decay rule.
    for (const t of halted) {
      const v = breakers[t];
      await writeAgentAlert({
        tenantId: t,
        alertType: "sms_carrier_route_dead",
        lane: "sunbiz-ops",
        severity: "urgent",
        title: "SMS halted — the carrier is refusing our sends",
        body:
          `${v.reason}. Sample: ${v.sample} recent verdicts, ${Math.round(v.failRatio * 100)}% failed. ` +
          `Drip SMS is paused and rescheduling; TextTorrent returns HTTP 201 on these, so nothing ` +
          `else would catch it. One probe send is allowed every 30 minutes to detect recovery.`,
        telegramOncePerOpen: true,
      }).catch(() => undefined);
    }

    if (r.errors.length) {
      await sendTelegram(
        `⚪ <b>SMS reconcile had errors</b>\n${esc(r.errors.slice(0, 3).join("; ")).slice(0, 400)}`,
        { lane: "sunbiz-ops" },
      ).catch(() => undefined);
    }

    return NextResponse.json({ ok: true, tenants: tenants.length, ...r, breaker, halted });
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
