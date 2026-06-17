/**
 * SunBiz VPS background daemons — the single source of truth for both the
 * background-workers status route (GET /api/automations/background-workers) and
 * the control proxy (POST .../control). Keeping one list means the displayed
 * workers and the control allowlist can never drift apart.
 *
 * Service strings match what the VPS bridge reports to integrations_health
 * (verified live 2026-06-17). Mirrors the daemon set in
 * SunBiz-Agent/ecosystem.config.js + the shared CEO-Agent bridge daemons.
 */

export type BgWorkerDef = {
  service: string;
  label: string;
  purpose: string;
  /** False for non-pm2 standalones; omitted = pm2-managed. */
  manageable_via_pm2?: boolean;
  archived_on?: string;
  archived_reason?: string;
};

export const SUNBIZ_WORKERS: BgWorkerDef[] = [
  {
    service: "pm2.sunbiz-sequence-runner",
    label: "Sequence + underwriting runner",
    purpose: "Runs the drip sequences and auto-fires underwriting when a deal is fully submitted. The heart of the follow-up + underwriting automation.",
  },
  {
    service: "pm2.sunbiz-lender-response-classifier",
    label: "Lender reply classifier",
    purpose: "Reads inbound lender email replies and classifies them (offer / decline / info-requested) onto each deal's lender threads.",
  },
  {
    service: "pm2.sunbiz-cold-outreach-runner",
    label: "Cold outreach runner",
    purpose: "Drains active cold-outreach campaigns and fires due steps via send_gateway (CASL + opt-out enforced).",
  },
  {
    service: "pm2.sunbiz-sentinel",
    label: "Conversation sentinel",
    purpose: "Watches conversations for frustration / STOP signals and pauses sequences before they annoy a lead.",
  },
  {
    service: "pm2.claude-bridge",
    label: "Chat bridge",
    purpose: "The VPS chat bridge — powers the Agents chat and the agent tool proxy.",
  },
  {
    service: "pm2.claude-bridge-ping",
    label: "Bridge heartbeat + cron poller",
    purpose: "Heartbeats every 60s and polls tenant_cron_jobs for due work — this is what runs the scheduled automations.",
  },
  {
    service: "pm2.event-router",
    label: "Event router",
    purpose: "Streams agent events into the activity log that feeds the dashboard.",
  },
];

/**
 * pm2 process names (service string minus the "pm2." prefix) the control proxy
 * is allowed to act on. Derived from SUNBIZ_WORKERS so the allowlist can never
 * drift from the displayed worker set.
 */
export const SUNBIZ_WORKER_NAMES: ReadonlySet<string> = new Set(
  SUNBIZ_WORKERS.map((w) => w.service.replace(/^pm2\./, "")),
);
