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
  "Daily Bravo Brief":
    "Sends you a Telegram every morning with last night's revenue, today's pipeline, the follow-ups that need a reply, and what's blocking $5K MRR. Read it before you open the dashboard.",

  // 05:45 — every unscored OASIS lead gets a numeric score so the
  // pipeline view sorts the hot ones to the top.
  "OASIS Auto-Score Leads":
    "Looks at every lead in your pipeline that hasn't been scored yet and assigns it a number out of 100 (higher = closer to closing). Runs early so the pipeline view sorts the hot leads to the top when you open it.",

  // 08:00 — short voice note from Aura.
  "Aura Morning Pow Wow":
    "Aura sends a short voice note to your Telegram every morning — about 120 words, a motivational kick to start the day. Costs about 2¢ per day in TTS.",

  // Booking reminder.
  "Booking Reminder":
    "Reminds you (and the prospect) about tomorrow's calls so nobody no-shows. Runs the evening before.",

  // Hourly Stripe sync.
  "Stripe Events Sync":
    "Pulls fresh payment events from Stripe so your MRR number stays current. Runs every hour in the background — you don't have to think about it.",

  // 06:30 — MRR + snapshot row.
  "Sync MRR":
    "Calculates your current MRR from active Stripe subscriptions and saves a snapshot for the day. Powers the MRR tile on Today and the trend on Analytics.",

  // Weekly Mon 06:00.
  "Weekly MRR Snapshot":
    "Logs your week-over-week MRR change every Monday morning so Analytics can chart growth (or decline).",

  // 12h.
  "Score All Leads":
    "Re-scores your entire pipeline twice a day. Catches new hot leads even if their score was stale.",

  // Hourly.
  "Process Nurture Sequences":
    "Sends the next scheduled drip email/SMS for any lead currently in a nurture sequence. Runs every hour so steps fire close to their scheduled time.",

  // Monthly.
  "Log Monthly Metrics":
    "On the 1st of each month, writes last month's MRR + lead totals to a permanent log. Powers year-over-year reporting later.",

  // Funnel poll.
  "Funnel Fast Poll":
    "Watches your CC Funnel form for new submissions every 2 minutes. The moment someone fills out the lead form on Instagram/social, you get a high-priority Telegram ping — usually within 60 seconds.",

  // Briefing snapshot.
  "Daily Briefing Snapshot":
    "Pre-computes tomorrow's briefing in the background so when Bravo writes your morning brief he's reading a single ready-made file instead of running four live queries (3-5x faster).",

  // Weekly leads snapshot.
  "Weekly Qualified-Leads Snapshot":
    "Every Saturday night, ranks the top qualified leads by potential MRR. Revenue-Hunter agent reads this list when prioritizing the week's outreach.",

  // Daily client alerts.
  "Daily Client Alerts Snapshot":
    "Every morning at 7am, scans your active clients for risk signals (low engagement, missed payments, support tickets) and flags the ones marked RED or ORANGE so Chief-of-Staff can address them early.",

  // State backup.
  "Nightly State DB Backup":
    "Backs up your local state database every night at 2am. Keeps the last 7 nights. Catches corruption early — checks integrity after every backup.",

  // Memory consolidation.
  "Nightly Memory Consolidation":
    "Reads your past 24 hours of activity, identifies new lessons (what worked, what didn't, decisions made), and appends them to your agent's permanent memory. The agent gets smarter over time without manual training.",

  // Cron watchdog.
  "Cron Watchdog":
    "Checks every other automation once a night for failures. If one of your daily jobs errored, you get a Telegram with the job name and the error — so silent breakage doesn't sit dead for days.",
};

/**
 * Pick the description the UI should render for a job. Friendly version
 * if we have one, raw DB description otherwise, empty string if the row
 * had nothing.
 */
export function friendlyDescription(name: string, dbDescription?: string | null): string {
  return FRIENDLY_DESCRIPTIONS[name] || (dbDescription || "").trim();
}
