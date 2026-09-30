/**
 * oasis-cc-cron — companion Worker that replaces the 29 registered crons.
 * Design + cutover choreography: Business-Empire-Agent
 * brain/WAVE3_OASIS_CC_RUNBOOK.md.
 *
 * One every-minute trigger; each tick evaluates the verbatim schedule table
 * below and fans out HTTPS calls to the app. FAIL-CLOSED kill switch: unless
 * the CRON_FORWARD secret is exactly "on", ticks are DRY — the due list is
 * logged and nothing is called. Auth: bearer CRON_SECRET plus
 * x-oasis-cron-attest (the two-secret successor to Vercel's unforgeable
 * x-vercel-cron header — see lib/cron-auth.ts).
 */

import { cronMatches } from "./cron-match";

// Verbatim from config/cron-registry.json. Do not "dedupe" or reformat — the
// coverage test compares this live table with the inert registry exactly.
//
// 2026-09-28, SunBiz retired (runbook C-6a): the routes that served SunBiz and
// no other tenant are no longer scheduled — collect-outreach-intel,
// scan-lender-replies, sync-tt-inbox (x2), scan-bounces (x2),
// scan-funmate-replies, sweep-stale-sent-app, kixie-compliance-scan (x2),
// enroll-accelerated, tps-enroll, tps-backlog-watch, renewal-thresholds,
// sync-sms-numbers and dispatch-bulk-email. Multi-tenant routes stay and skip
// retired tenants (lib/tenant/retired.ts). Re-adding one of these would restart
// writes for a tenant whose data is being exported and deleted.
//
// 2026-09-29, the books' daily upkeep (lib/founders-finances/books-cron.ts):
// exchange rates, the Stripe reconcile (payouts included), Wise invoice
// matches, then the Wise bank feed, in that order, once a day each.
export const CRON_TABLE: ReadonlyArray<{ path: string; schedule: string }> = [
  { path: "/api/cron/materialize-plans", schedule: "0 3 * * *" },
  { path: "/api/cron/collect-cc-metrics?write=1", schedule: "15 * * * *" },
  { path: "/api/cron/dispatch-scheduled-sends", schedule: "*/5 * * * *" },
  { path: "/api/cron/dispatch-founder-meeting-reminders", schedule: "*/5 * * * *" },
  { path: "/api/cron/sms-reply-agent", schedule: "*/5 * * * *" },
  { path: "/api/cron/enroll-drips", schedule: "*/15 * * * *" },
  { path: "/api/cron/dispatch-drips", schedule: "*/5 * * * *" },
  { path: "/api/cron/reconcile-drip-telemetry", schedule: "17 * * * *" },
  { path: "/api/cron/reconcile-website-sales-payments", schedule: "17 * * * *" },
  { path: "/api/cron/dispatch-scheduled-calls", schedule: "*/5 * * * *" },
  { path: "/api/cron/operator-email-agent?write=1", schedule: "*/10 * * * *" },
  { path: "/api/cron/health-check", schedule: "*/15 * * * *" },
  { path: "/api/cron/sla-check", schedule: "*/15 * * * *" },
  { path: "/api/cron/reconcile-sms", schedule: "*/15 * * * *" },
  { path: "/api/cron/connection-health", schedule: "*/15 * * * *" },
  { path: "/api/cron/finance-books?job=fx-refresh", schedule: "47 21 * * *" },
  { path: "/api/cron/finance-books?job=stripe-reconcile", schedule: "53 21 * * *" },
  { path: "/api/cron/finance-books?job=wise-reconcile", schedule: "7 22 * * *" },
  { path: "/api/cron/finance-books?job=wise-sync", schedule: "29 22 * * *" },
];

// Self-contained runtime types: this dir sits inside the Next app's tsconfig
// sweep, which has no Cloudflare Workers globals — and must not need them.
interface ScheduledController {
  scheduledTime: number;
  cron: string;
}
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  APP_ORIGIN?: string;        // default https://oasisai.work
  CRON_FORWARD?: string;      // "on"|"true"|"1"|"yes" => forward; anything else => dry
  CRON_SECRET?: string;       // bearer, shared with the app
  CRON_ATTEST_SECRET?: string; // second leg replacing x-vercel-cron
}

/** Accept any conventional truthy spelling. Still FAIL-CLOSED (unset/typo =>
 *  dry), but a cutover set to "true" must not silently no-op — the operator
 *  would see a quiet worker and no forwards and have nothing to debug. */
export function forwardingEnabled(env: Env): boolean {
  return ["on", "true", "1", "yes"].includes((env.CRON_FORWARD ?? "").trim().toLowerCase());
}

interface ForwardResult {
  path: string;
  status: number | string;
  ok: boolean;
  attempts: number;
}

async function callOnce(env: Env, origin: string, path: string): Promise<{ status: number | string; ok: boolean; retryable: boolean }> {
  try {
    const res = await fetch(origin + path, {
      method: "GET",
      headers: {
        authorization: `Bearer ${env.CRON_SECRET ?? ""}`,
        "x-oasis-cron-attest": env.CRON_ATTEST_SECRET ?? "",
        "user-agent": "oasis-cc-cron/1.0",
      },
      signal: AbortSignal.timeout(120_000),
    });
    // Cloudflare counts unread response bodies as live subrequests. A busy
    // minute can fan out more routes than the connection limit; cancel every
    // body we do not consume so later forwards cannot deadlock behind them.
    await res.body?.cancel().catch(() => undefined);
    // Non-2xx is a FAILED tick, never a success (codex audit 2026-08-30).
    // 5xx may be transient -> retryable; 4xx is a contract bug -> not.
    return { status: res.status, ok: res.ok, retryable: res.status >= 500 };
  } catch (err) {
    return { status: `error: ${String(err).slice(0, 120)}`, ok: false, retryable: true };
  }
}

async function forward(env: Env, origin: string, path: string): Promise<ForwardResult> {
  const first = await callOnce(env, origin, path);
  if (first.ok || !first.retryable) {
    return { path, status: first.status, ok: first.ok, attempts: 1 };
  }
  // One bounded retry with jitter for transient failures. Safe for every
  // route: the cutover gate (runbook Phase B) requires all 29 routes to be
  // double-fire-safe via CAS claims or the tick-lease before CRON_FORWARD=on.
  await new Promise((r) => setTimeout(r, 15_000 + Math.floor(Math.random() * 15_000)));
  const second = await callOnce(env, origin, path);
  return { path, status: second.status, ok: second.ok, attempts: 2 };
}

export default {
  /**
   * Read-only inspection surface (no auth needed — reveals only the public
   * schedule table): GET /simulate?at=<ISO> returns the due set the scheduled
   * handler would compute for that minute, straight from the deployed code.
   * Used by the Phase A gate to verify matcher behavior in production.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/simulate") return new Response("oasis-cc-cron", { status: 200 });
    const at = new Date(url.searchParams.get("at") || Date.now());
    if (Number.isNaN(at.getTime())) return new Response("bad ?at=", { status: 400 });
    const due = CRON_TABLE.filter((e) => cronMatches(e.schedule, at)).map((e) => e.path);
    return Response.json({
      at: at.toISOString(),
      forwarding: forwardingEnabled(env),
      due,
    });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const at = new Date(controller.scheduledTime);
    const due = CRON_TABLE.filter((e) => cronMatches(e.schedule, at));
    const forwarding = forwardingEnabled(env);
    if (!forwarding) {
      // Dry mode logs EVERY tick (due or not): the Phase A gate compares the
      // full due-minute stream against Vercel's cron log, and an all-quiet
      // tail must be distinguishable from a dead worker.
      console.log(JSON.stringify({ tick: at.toISOString(), mode: "dry", due: due.map((e) => e.path) }));
      return;
    }
    if (!due.length) return;
    const origin = env.APP_ORIGIN || "https://oasisai.work";
    ctx.waitUntil(
      Promise.all(due.map((e) => forward(env, origin, e.path))).then((results) => {
        const failed = results.filter((r) => !r.ok);
        console.log(JSON.stringify({ tick: at.toISOString(), mode: "forward", ok: results.length - failed.length, failed: failed.length, results }));
        if (failed.length) {
          // Error-level so Workers observability alerting can page on it.
          // Phase B wires this into the Telegram ops lane (needs the
          // OASIS_TELEGRAM secrets from CC's fill list).
          console.error(JSON.stringify({ cron_failures: failed, tick: at.toISOString() }));
        }
      }),
    );
  },
};
