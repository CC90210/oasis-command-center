/**
 * lib/automations/cloud-jobs.ts - what each scheduled cloud job is, in plain
 * English (2026-10-31, CC: "the names are filled with developer jargon").
 *
 * One entry per workers/oasis-cc-cron CRON_TABLE path. Names say what the job
 * does for the business; descriptions were written from each route's own code,
 * not from its URL. `noLiveUse` marks a job that no live workspace uses (the
 * 2026-10-31 audit counted zero rows for OASIS and every other non-retired
 * workspace): it is safe to pause, and a candidate for removal.
 *
 * PURE: no database, no session. tests/cloud-job-switches.test.ts holds this map
 * to CRON_TABLE exactly, so a new schedule cannot ship without a plain name.
 * A description names the work that pausing the job stops, side work
 * included (a retention purge, an intake repair), not only its headline.
 */
import { CRON_TABLE } from "@/workers/oasis-cc-cron/src/index";

export type CloudJobInfo = {
  /** Plain-English name shown on the Automations board. */
  name: string;
  /** One sentence: what it does for the business. */
  description: string;
  /** Why the job can be paused: nothing live uses it. */
  noLiveUse?: string;
};

export const CLOUD_JOBS: Readonly<Record<string, CloudJobInfo>> = {
  "/api/cron/dispatch-engine-fallbacks": {
    name: "Cloud AI Backup Runner",
    description:
      "Finishes agent work on your cloud AI account when it was set to fall back from your computer, even if the browser or computer went away.",
  },
  "/api/cron/dispatch-automations": {
    name: "Operations Workflow Engine",
    description: "Starts the department tasks you scheduled (for example a daily 8:00 report) on time, and notes any slot it had to skip.",
  },
  "/api/cron/maven-publish-queue": {
    name: "Maven Content Publisher",
    description: "Hands the posts you approved in the Library to Maven's publishing queue.",
  },
  "/api/cron/materialize-plans": {
    name: "Daily Business Plan Generator",
    description: "Each night, builds tomorrow's daily plan from your weekday or weekend template.",
  },
  "/api/cron/collect-cc-metrics?write=1": {
    name: "Constant Contact Campaign Stats",
    description: "Copies email-blast stats and unsubscribes from Constant Contact into the dashboard.",
    noLiveUse: "SunBiz-era. No live workspace has ever stored a campaign stat or a Constant Contact unsubscribe.",
  },
  "/api/cron/dispatch-scheduled-sends": {
    name: "Scheduled Message Sender",
    description: "Sends emails and texts that were scheduled for later from a lead.",
    noLiveUse: "No live workspace has ever scheduled a message, and its texts go through TextTorrent, SunBiz's SMS provider.",
  },
  "/api/cron/dashboard-email-sender": {
    name: "Dashboard Email Sender",
    description: "Sends the emails you write in a lead's drawer and the AI Audit's emails once its send switch is on. It replaced the old sender on your PC.",
  },
  "/api/cron/dispatch-founder-meeting-reminders": {
    name: "Lead Meeting Reminders",
    description:
      "Reminds leads about booked calls (at booking, the day before, 1 hour and 15 minutes before), gives you a 15-minute heads-up, sends a rebook link after a missed call, and repairs half-finished bookings.",
  },
  "/api/cron/sms-reply-agent": {
    name: "SMS Auto-Responder",
    description: "Reads texts that arrive at your business numbers and answers or hands them off, for example a lead moving their call.",
  },
  "/api/cron/enroll-drips": {
    name: "Nurture Sequence Enrollment",
    description: "Signs leads up for a nurture sequence when they reach the stage that starts it.",
  },
  "/api/cron/dispatch-drips": {
    name: "Nurture Sequence Sender",
    description: "Sends the next email or text in each lead's nurture sequence, respecting quiet hours.",
  },
  "/api/cron/reconcile-drip-telemetry": {
    name: "Nurture Email Records Repair",
    description: "Fills in missing tracking records for nurture emails that were already sent.",
  },
  "/api/cron/reconcile-website-sales-payments": {
    name: "Website Sale Payment Check",
    description: "Re-checks website-sale payments with Stripe and finishes what should happen after a payment.",
  },
  "/api/cron/dispatch-scheduled-calls": {
    name: "Booked Call Status Updater",
    description: "Marks booked sales calls as due, and as missed when they pass without a call.",
    noLiveUse: "SunBiz-era (sales-rep calls). No live workspace has ever booked a call here.",
  },
  "/api/cron/operator-email-agent?write=1": {
    name: "Agent Mailbox Monitor",
    description: "Reads an agent's connected work or personal inbox and files deal emails on the matching lead.",
    noLiveUse: "No agent has it switched on.",
  },
  "/api/cron/health-check": {
    name: "Platform Health Watchdog",
    description:
      "Checks that the booking calendar, dashboard email queue, worker status reports, live site, alert delivery, forms and department chats are working, and alerts you on Telegram when one is not.",
  },
  "/api/cron/sla-check": {
    name: "Support Response-Time Watch",
    description:
      "Flags support tickets not answered in time (one alert each), repairs support requests that half-failed, alerts you when support@ goes unread for 20 minutes, and clears old non-ticket mail after 30 days.",
  },
  "/api/cron/reconcile-sms": {
    name: "Text Delivery Check",
    description: "Confirms texts sent through TextTorrent were really delivered, and alerts when a sending number stops working.",
    noLiveUse: "SunBiz-era (TextTorrent). No live workspace has ever recorded a TextTorrent delivery receipt.",
  },
  "/api/cron/connection-health": {
    name: "Connection Health Check",
    description:
      "Re-tests each connected service (Stripe, Google and the rest) so Settings only shows green when it really works, and deletes Slack messages after 90 days and browser crash reports after 30.",
  },
  "/api/cron/finance-books?job=fx-refresh": {
    name: "Exchange Rate Update",
    description: "Pulls the Bank of Canada USD/CAD rates into your books.",
  },
  "/api/cron/finance-books?job=stripe-reconcile": {
    name: "Stripe Payment Reconciliation",
    description: "Copies the last 7 days of Stripe payments, refunds, fees and payouts into your books, as a safety net under Stripe's live updates.",
  },
  "/api/cron/finance-books?job=wise-reconcile": {
    name: "Wise Invoice Matching (preview)",
    description: "Lists Wise deposits that exactly pay an open invoice. It records nothing until you approve automatic recording.",
  },
  "/api/cron/finance-books?job=wise-sync": {
    name: "Wise Bank Feed Sync (preview)",
    description: "Reads your Wise bank feed for the books. Preview only: it writes nothing until the feed is switched on.",
  },
  "/api/cron/meet-relay": {
    name: "Meeting Room Cleanup",
    description: "Ends Oasis Meet calls that everyone left without ending, and deletes call audio once it is transcribed or 30 days old.",
  },
  "/api/cron/ai-audit-tick": {
    name: "AI Audit Pipeline Engine",
    description:
      "Moves each Free AI Audit along: research and drafting (paid AI runs), pre-call briefs from the client's site, PDFs for your Mac to print, your delivery approval, payments, refunds, disputes, onboarding, Pipeline stages and stall flags. Never contacts a client.",
  },
};

/** The plain-English entry for a CRON_TABLE path, or null for an unknown one. */
export function cloudJobInfo(path: string): CloudJobInfo | null {
  return CLOUD_JOBS[path] ?? null;
}

function jobParam(path: string): string | null {
  return new URL(path, "https://oasisai.work").searchParams.get("job");
}

/**
 * The CRON_TABLE path a request to a scheduled route belongs to, or null when
 * the route is not a scheduled cloud job. The four books jobs share one route
 * and are told apart by ?job=; a mode flag such as ?write=1 does not matter
 * (a manual dry run of a paused job is the same job).
 */
export function cronTableKeyFor(url: URL): string | null {
  const candidates = CRON_TABLE.filter((entry) => new URL(entry.path, url.origin).pathname === url.pathname);
  if (candidates.length === 0) return null;
  const job = url.searchParams.get("job");
  const byJob = candidates.find((entry) => job !== null && jobParam(entry.path) === job);
  if (byJob) return byJob.path;
  const plain = candidates.filter((entry) => jobParam(entry.path) === null);
  return plain.length === 1 ? plain[0].path : null;
}
