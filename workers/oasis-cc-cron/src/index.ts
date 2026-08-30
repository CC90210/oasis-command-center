/**
 * oasis-cc-cron — companion Worker that replaces the 28 vercel.json crons.
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

// Verbatim from vercel.json (2026-08-29). Do not "dedupe" or reformat —
// diffability against vercel.json is the review mechanism.
export const CRON_TABLE: ReadonlyArray<{ path: string; schedule: string }> = [
  { path: "/api/cron/materialize-plans", schedule: "0 3 * * *" },
  { path: "/api/cron/collect-outreach-intel?write=1", schedule: "0 * * * *" },
  { path: "/api/cron/collect-cc-metrics?write=1", schedule: "15 * * * *" },
  { path: "/api/cron/dispatch-scheduled-sends", schedule: "*/5 * * * *" },
  { path: "/api/cron/dispatch-founder-meeting-reminders", schedule: "*/5 * * * *" },
  { path: "/api/cron/enroll-drips", schedule: "*/15 * * * *" },
  { path: "/api/cron/scan-lender-replies?write=1", schedule: "*/10 * * * *" },
  { path: "/api/cron/dispatch-drips", schedule: "*/5 * * * *" },
  { path: "/api/cron/reconcile-drip-telemetry", schedule: "17 * * * *" },
  { path: "/api/cron/reconcile-website-sales-payments", schedule: "17 * * * *" },
  { path: "/api/cron/dispatch-scheduled-calls", schedule: "*/5 * * * *" },
  { path: "/api/cron/sync-tt-inbox", schedule: "*/30 * * * *" },
  { path: "/api/cron/sync-tt-inbox?account=followup", schedule: "*/30 * * * *" },
  { path: "/api/cron/operator-email-agent?write=1", schedule: "*/10 * * * *" },
  { path: "/api/cron/scan-bounces?write=1", schedule: "*/30 * * * *" },
  { path: "/api/cron/scan-bounces?write=1&brand=bluerise", schedule: "*/30 * * * *" },
  { path: "/api/cron/scan-funmate-replies?write=1", schedule: "*/30 * * * *" },
  { path: "/api/cron/sweep-stale-sent-app", schedule: "0 13 * * *" },
  { path: "/api/cron/kixie-compliance-scan", schedule: "10 13 * * *" },
  { path: "/api/cron/kixie-compliance-scan?mode=weekly", schedule: "40 13 * * 1" },
  { path: "/api/cron/enroll-accelerated", schedule: "*/15 * * * *" },
  { path: "/api/cron/tps-enroll?write=1", schedule: "*/10 * * * *" },
  { path: "/api/cron/tps-backlog-watch", schedule: "0 */6 * * *" },
  { path: "/api/cron/renewal-thresholds", schedule: "15 13 * * *" },
  { path: "/api/cron/health-check", schedule: "*/15 * * * *" },
  { path: "/api/cron/sync-sms-numbers", schedule: "0 6,18 * * *" },
  { path: "/api/cron/reconcile-sms", schedule: "*/15 * * * *" },
  { path: "/api/cron/dispatch-bulk-email", schedule: "*/5 * * * *" },
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

interface Env {
  APP_ORIGIN?: string;        // default https://oasisai.work
  CRON_FORWARD?: string;      // secret; anything but "on" => dry tick
  CRON_SECRET?: string;       // bearer, shared with the app
  CRON_ATTEST_SECRET?: string; // second leg replacing x-vercel-cron
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
  // route: the cutover gate (runbook Phase B) requires all 28 routes to be
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
      forwarding: env.CRON_FORWARD === "on",
      due,
    });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const at = new Date(controller.scheduledTime);
    const due = CRON_TABLE.filter((e) => cronMatches(e.schedule, at));
    const forwarding = env.CRON_FORWARD === "on";
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
