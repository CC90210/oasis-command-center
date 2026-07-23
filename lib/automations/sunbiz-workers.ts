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
  /**
   * B4 (2026-07-23): which operator this worker belongs to. "adon" = the
   * Breeze/MCA underwriting line; "cc" = SunBiz core infra (drip/outreach/
   * sentinel/bridge/event-router); "shared" = touches both and either
   * operator may control it. Used by BackgroundWorkersPanel to group the
   * list and by the control route to gate start/stop/restart so one
   * operator can't kill the other's daemon by accident.
   */
  owner: "cc" | "adon" | "shared";
};

export const SUNBIZ_WORKERS: BgWorkerDef[] = [
  {
    service: "pm2.sunbiz-sequence-runner",
    label: "Sequence + underwriting runner",
    purpose: "Runs the drip sequences and auto-fires underwriting when a deal is fully submitted. The heart of the follow-up + underwriting automation.",
    owner: "cc",
  },
  {
    service: "pm2.sunbiz-lender-response-classifier",
    label: "Lender reply classifier",
    purpose: "Reads inbound lender email replies and classifies them (offer / decline / info-requested) onto each deal's lender threads.",
    owner: "cc",
  },
  {
    service: "pm2.sunbiz-cold-outreach-runner",
    label: "Cold outreach runner",
    purpose: "Drains active cold-outreach campaigns and fires due steps via send_gateway (CASL + opt-out enforced).",
    owner: "cc",
  },
  {
    service: "pm2.mca-lead-scrubber",
    label: "Breeze UW sheet scrubber",
    purpose: "Polls the shared Breeze/SunBiz Google Drive for UW sheets, scores deals, and stages qualified ones for Ezra approval.",
    owner: "adon",
  },
  {
    service: "pm2.ezra-telegram-bridge",
    label: "Ezra approval bridge",
    purpose: "Long-polls Ezra's Telegram approval buttons and creates Live Subs leads after he approves a staged UW deal.",
    owner: "adon",
  },
  {
    service: "pm2.uw-lead-enricher",
    label: "UW lead enricher",
    purpose: "Refreshes approved UW leads from their source Google Sheet, enriches missing contact channels, and asks Ezra to verify newly sourced email or phone data.",
    owner: "adon",
  },
  {
    service: "pm2.sunbiz-sentinel",
    label: "Conversation sentinel",
    purpose: "Watches conversations for frustration / STOP signals and pauses sequences before they annoy a lead.",
    owner: "cc",
  },
  {
    service: "pm2.claude-bridge",
    label: "Chat bridge",
    purpose: "The VPS chat bridge — powers the Agents chat and the agent tool proxy.",
    owner: "cc",
  },
  {
    service: "pm2.claude-bridge-ping",
    label: "Bridge heartbeat + cron poller",
    purpose: "Heartbeats every 60s and polls tenant_cron_jobs for due work — this is what runs the scheduled automations.",
    owner: "cc",
  },
  {
    service: "pm2.event-router",
    label: "Event router",
    purpose: "Streams agent events into the activity log that feeds the dashboard.",
    owner: "cc",
  },
];

/**
 * B4 (2026-07-23): OpenCode is a local CLI runtime CC also runs against this
 * VPS/machine set, but it is NOT one of the 10 pm2-managed SUNBIZ_WORKERS
 * above — it has no daemon entry in ecosystem.config.js and this dashboard
 * has no visibility or control surface for it. Recorded here (not as a
 * BgWorkerDef, since manageable_via_pm2:false workers still get a status
 * tile — this one has NO status source at all) purely so worker-cycle
 * accounting across the fleet doesn't silently miss it when someone asks
 * "what's running." If OpenCode ever gets pm2-managed + a bridge heartbeat,
 * promote this into SUNBIZ_WORKERS with manageable_via_pm2:false (or true).
 */
export const UNTRACKED_MANUAL_RUNTIMES = [
  {
    name: "opencode",
    manageable_via_pm2: false,
    purpose: "Local OpenCode terminal runtime CC runs manually — untracked by pm2/bridge, no dashboard visibility or control.",
    owner: "cc" as const,
  },
] as const;

/**
 * pm2 process names (service string minus the "pm2." prefix) the control proxy
 * is allowed to act on. Derived from SUNBIZ_WORKERS so the allowlist can never
 * drift from the displayed worker set.
 */
export const SUNBIZ_WORKER_NAMES: ReadonlySet<string> = new Set(
  SUNBIZ_WORKERS.map((w) => w.service.replace(/^pm2\./, "")),
);
