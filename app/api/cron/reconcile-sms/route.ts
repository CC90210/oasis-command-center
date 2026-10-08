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
import { resolveAgentAlerts, writeAgentAlert } from "@/lib/notify/agent-alert";
import { reconcileReceipts, tenantsWithOpenReceipts } from "@/lib/sms/delivery-receipts";
import { smsSendAllowed, resetBreakerCache } from "@/lib/sms/send-breaker";
import { refreshDestinationHealth } from "@/lib/sms/destination-health";
import { isRetiredTenant } from "@/lib/tenant/retired";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300, not 60 (Pro plan ceiling headroom). This route 504'd on 7 of the last 12
// failed cron-driver runs — every 15 minutes, an email to CC each time. The
// receipts phase budgets itself (deadlineMs = start + 45s), but the
// destination-health loop after it re-scans 90 DAYS of receipts per tenant with
// NO deadline, inside whatever was left of 60s. Headroom here plus the loop
// deadline below ends the flood without touching the shared health lib.
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;
  const startedAt = Date.now();

  try {
    // Reconcile EVERY tenant with open receipts. The executor opens receipts
    // under each drip row's own tenant_id, so pinning this to one tenant would
    // leave every other tenant's receipts open forever — and an all-open
    // history reads as "nothing terminal yet", which the breaker permits.
    //
    // RETIRED TENANTS ARE SKIPPED (2026-09-28). SunBiz used to be forced into
    // this list; once it was retired, this route was still writing its
    // destination-health rows every 15 minutes (~539 after the freeze) into
    // tables that are about to be exported and deleted. A retired tenant sends
    // nothing, so it has no verdicts to wait for.
    const discovered = await tenantsWithOpenReceipts();
    if (discovered === null) {
      // Could not enumerate. Not the same as "no work": say so loudly rather
      // than reporting a clean run over a queue we never saw.
      return NextResponse.json(
        { ok: false, error: "could not enumerate tenants with open receipts" },
        { status: 500 },
      );
    }
    const all = [...new Set(discovered)].filter((t) => !isRetiredTenant(t)).sort();

    // ROTATE the order. Each thread costs a sequential API call, so a big
    // backlog on whichever tenant goes first can consume the whole 60s budget.
    // With a fixed order that tenant would starve every other one on EVERY
    // invocation, and a starved tenant's receipts stay open forever, which
    // leaves its breaker with no terminal evidence — the exact blindness this
    // subsystem removes. Rotating by the 15-minute slot gives every tenant the
    // front of the queue in turn.
    const slot = Math.floor(Date.now() / (15 * 60_000));
    const pivot = all.length ? slot % all.length : 0;
    const tenants = [...all.slice(pivot), ...all.slice(0, pivot)];

    // Leave headroom inside maxDuration for the breaker reads and alerts below.
    const deadlineMs = startedAt + 45_000;
    const perTenantLimit = Math.max(25, Math.floor(200 / Math.max(1, tenants.length)));

    const perTenant: Record<string, Awaited<ReturnType<typeof reconcileReceipts>>> = {};
    for (const t of tenants) {
      perTenant[t] = await reconcileReceipts(t, { limit: perTenantLimit, deadlineMs });
    }

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

    // DESTINATION HEALTH IS MATERIALISED HERE, and this is the only place it
    // happens (Codex P1, 2026-08-20: refreshDestinationHealth had no production
    // caller at all, so the landline gate would have stayed a permanent no-op —
    // a missing row reads as textable by design).
    //
    // This is the right seam: the verdicts it derives from have just landed, so
    // recomputing anywhere else would read a staler picture than the one that
    // exists at this instant.
    //
    // Failures are recorded, never thrown. Reconciliation is the load-bearing
    // job on this route and must not be taken down by a downstream refresh; a
    // stale destination table degrades to "text them and find out", which is
    // where we were before, not somewhere worse.
    // Deadlined like the receipts phase above, and for the same reason: this
    // loop re-scans a 90-day receipt window per tenant, and unbounded it is the
    // route's 504 (7 of the last 12 cron-driver failures). A tenant skipped for
    // deadline is RECORDED as skipped — visible in the response, never silent —
    // and health is a rolling refresh, so the next quarter-hour tick catches it
    // up. Narrowing the lib's 90-day window instead would change benching
    // semantics for every caller (shared substrate), so the bound lives here.
    const healthDeadlineMs = startedAt + (maxDuration - 60) * 1000;
    const destinationHealth: Record<string, { examined: number; untextable: number; error: string | null }> = {};
    for (const t of tenants) {
      if (Date.now() > healthDeadlineMs) {
        destinationHealth[t] = {
          examined: 0, untextable: 0,
          error: "skipped: health-refresh deadline reached; next tick catches up",
        };
        continue;
      }
      const res = await refreshDestinationHealth(t).catch((err) => ({
        examined: 0, untextable: 0, written: 0,
        error: err instanceof Error ? err.message : String(err),
      }));
      destinationHealth[t] = { examined: res.examined, untextable: res.untextable, error: res.error };
    }
    const breakers: Record<string, Awaited<ReturnType<typeof smsSendAllowed>>> = {};
    for (const t of tenants) breakers[t] = await smsSendAllowed(t, { force: true });
    const halted = tenants.filter((t) => breakers[t]?.halt);

    // Page through writeAgentAlert, NOT raw sendTelegram. This cron runs every
    // 15 minutes, so a raw send would produce up to 96 identical pages a day for
    // one ongoing outage. telegramOncePerOpen fires once per open condition and
    // goes quiet until it clears, which is the standing alert-decay rule. Whose
    // chat is paged is the workspace's (lib/notify/alert-route.ts); this route
    // named the SunBiz lane for every workspace until 2026-10-02.
    for (const t of halted) {
      const v = breakers[t];
      await writeAgentAlert({
        tenantId: t,
        alertType: "sms_carrier_route_dead",
        severity: "urgent",
        title: "SMS halted — the carrier is refusing our sends",
        body:
          `${v.reason}. Sample: ${v.sample} recent verdicts, ${Math.round(v.failRatio * 100)}% failed. ` +
          `Drip SMS is paused and rescheduling; TextTorrent returns HTTP 201 on these, so nothing ` +
          `else would catch it. One probe send is allowed every 30 minutes to detect recovery.`,
        telegramOncePerOpen: true,
      }).catch(() => undefined);
    }

    // RECOVERY CLOSES THE CARD. A workspace whose breaker no longer halts has a
    // route that delivers again, so its open card is closed and the next
    // outage opens a new card and pages. Left open, telegramOncePerOpen would
    // keep every later outage silent.
    const recovered: string[] = [];
    for (const t of tenants) {
      if (breakers[t]?.halt) continue;
      const closed = await resolveAgentAlerts({
        tenantId: t,
        alertType: "sms_carrier_route_dead",
        resolvedBy: "auto: the carrier route delivers again",
      });
      if (closed > 0) recovered.push(t);
    }

    // Each workspace's reconcile errors are that workspace's card and its own
    // audience, once per open card. They used to go, every tick and every
    // workspace's together, to the SunBiz chat.
    for (const t of tenants) {
      const errors = perTenant[t]?.errors ?? [];
      if (errors.length === 0) {
        await resolveAgentAlerts({ tenantId: t, alertType: "sms_reconcile_errors", resolvedBy: "auto: reconcile ran clean" });
        continue;
      }
      await writeAgentAlert({
        tenantId: t,
        alertType: "sms_reconcile_errors",
        severity: "warn",
        title: "Text delivery checks had errors",
        body: errors.slice(0, 3).join("; ").slice(0, 400),
        telegramOncePerOpen: true,
      }).catch(() => undefined);
    }

    return NextResponse.json({
      ok: true, tenants: tenants.length, ...r, breakers, halted, recovered, destination_health: destinationHealth,
    });
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
