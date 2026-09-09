/**
 * Operator-friendly descriptions for scheduled automations.
 *
 * The cron_jobs table is seeded by scripts/core/cron_engine.py with
 * descriptions written for engineers — they reference internal paths
 * ("brain/AGENTIC_OS_REFERENCE.md §3"), table names ("upsert
 * user_profiles.mrr_current_usd"), and other implementation detail
 * that operators don't need to think about.
 *
 * This registry maps job names to operator-friendly text that answers
 * three plain-English questions:
 *   • What does this do?
 *   • When does it run?
 *   • What do I see as a result?
 *
 * The UI prefers FRIENDLY_DESCRIPTIONS[name] when present and falls
 * back to the raw DB description otherwise — so a job that doesn't
 * have an override still renders something rather than blank.
 *
 * Add an entry when:
 *   • An operator asks "what does X actually do?"
 *   • The DB description references an internal file/table name
 *   • The DB description is over ~150 chars (operators skim, not read)
 *
 * Job names mirror the `name` column of cron_jobs — exactly as it
 * appears in scripts/core/cron_engine.py's SEED_JOBS.
 */
export const FRIENDLY_DESCRIPTIONS: Record<string, string> = {
  // Daily 06:00 — narrated morning briefing pushed to CC's phone.
  // No revenue line, and no hardcoded MRR target. Bravo does not report
  // revenue — Atlas owns it — and this copy named a $5K goal that was passed in
  // June, so the tab was quoting a stale number as the thing to beat. A target
  // written into UI copy is a target that goes stale silently; the brief itself
  // reads the live one.
  "Daily Bravo Brief":
    "Sends you a Telegram every morning with today's pipeline, the follow-ups that need a reply, and what's blocking the current goal. Read it before you open the dashboard.",

  // 05:45 — every unscored OASIS lead gets a numeric score so the
  // pipeline view sorts the hot ones to the top.
  "OASIS Auto-Score Leads":
    "Looks at every lead in your pipeline that hasn't been scored yet and assigns it a number out of 100 (higher = closer to closing). Runs early so the pipeline view sorts the hot leads to the top when you open it.",

  // Booking reminder.
  "Booking Reminders":
    "Reminds you (and the prospect) about tomorrow's calls so nobody no-shows. Runs the evening before.",

  // 06:30 — MRR + snapshot row.
  "Daily MRR Auto-Sync":
    "Calculates your current MRR from active Stripe subscriptions and saves a snapshot for the day. Powers the MRR tile on Today and the trend on Analytics.",

  // Hourly.
  "Nurture Sequence Check":
    "Sends the next scheduled drip email/SMS for any lead currently in a nurture sequence. Runs every hour so steps fire close to their scheduled time.",

  // Funnel poll.
  "Funnel Fast-Poll":
    "Watches your CC Funnel form for new submissions every 2 minutes. The moment someone fills out the lead form on Instagram/social, you get a high-priority Telegram ping — usually within 60 seconds.",

  // Briefing snapshot.
  "Daily Briefing Snapshot":
    "Pre-computes tomorrow's briefing in the background so when Bravo writes your morning brief he's reading a single ready-made file instead of running four live queries (3-5x faster).",

  // Daily client alerts.
  "Daily Client Alerts Snapshot":
    "Every morning at 7am, scans your active clients for risk signals (low engagement, missed payments, support tickets) and flags the ones marked RED or ORANGE so Chief-of-Staff can address them early.",

  // State backup.
  "Daily State DB Backup":
    "Backs up your local state database every night at 2am. Keeps the last 7 nights. Catches corruption early — checks integrity after every backup.",

  // Memory consolidation.
  "Bravo — Sleep Agent (Memory Consolidation)":
    "Reads your past 24 hours of activity, identifies new lessons (what worked, what didn't, decisions made), and appends them to your agent's permanent memory. The agent gets smarter over time without manual training.",

  // ── SunBiz Funding scheduled jobs ─────────────────────────────────────
  // Operator-facing copy for the SunBiz tenant. These run on the VPS (polled
  // every ~60s) and report results IN THE DASHBOARD — SunBiz has no Telegram
  // (its outbound channels are Kixie calls + TextTorrent SMS via send_gateway).
  // Keys MUST match tenant_cron_jobs.name exactly.
  "SunBiz Follow-up Generator":
    "Every morning at 6am, scans your leads for ones that have gone quiet — stuck deals, missing paperwork, no reply yet — and builds that day's follow-up task list. You work the list from the Follow-Up Machine tab.",
  "SunBiz Daily Plan Generator":
    "Every morning at 6:30am (right after the follow-up list), sorts the day's work into buckets — priority calls, missing info, stuck deals, new offers, deals to shop today, renewals coming due — and fills the Daily Plan tab so the team opens to a ready-made plan.",
  "SunBiz Renewal Reminder":
    "Every morning at 9am, checks funded deals that are 40-50% through their term and flags them on the Daily Plan (under \"renewal eligible\") so the team can re-shop them before a competitor does. No alert is sent anywhere else — it shows up in the dashboard.",
  // Rewritten 2026-08-04: underwriting no longer runs on its own. The old copy
  // promised a deal would be "graded without anyone clicking Run Underwriting",
  // which is now the opposite of the truth — leaving it would have had the
  // dashboard telling the team to wait for something that is never coming.
  "SunBiz Underwriting Orchestrator":
    "Every 15 minutes, picks up underwriting runs that someone has actually requested and works through them — parses the statements, finds existing debt/positions, drafts the sales angle. It does NOT pick deals on its own: underwriting starts when you press \"Start underwriting\" or \"Re-run\" on a lead. Nothing is sent out; results land on the deal.",
  "SunBiz Shop-Out Sender":
    "Every minute, sends any lender submissions you've queued in Shopping Out — one email per lender, through the compliance gates (suppression, daily cap, send window). Turn it off here to pause all outbound lender sends instantly.",
  "SunBiz Cold Outreach Runner":
    "Every 15 minutes, works through your active cold-outreach campaigns and sends the next due touch (call/SMS) to each prospect — capped per day and screened against opt-outs and the do-not-contact list. Turn it off to pause cold outreach.",
  "SunBiz Health Check":
    "Every 30 minutes, runs a read-only self-check of the whole SunBiz system — are the scheduled jobs firing on time, are any queues backed up or erroring, is the data clean. If it finds a serious problem it raises an alert in the dashboard. It never sends or changes anything.",
};

/**
 * Pick the description the UI should render for a job. Friendly version
 * if we have one, raw DB description otherwise, empty string if the row
 * had nothing.
 */
export function friendlyDescription(name: string, dbDescription?: string | null): string {
  return FRIENDLY_DESCRIPTIONS[name] || (dbDescription || "").trim();
}
