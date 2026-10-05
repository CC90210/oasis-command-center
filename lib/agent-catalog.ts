/**
 * Per-agent operational catalog: highlighted cron jobs, backend processes,
 * and workflows each agent owns. `/automations` remains the complete live
 * schedule and control source; every cron highlight here must name a real row.
 *
 * The Agents page renders one card per enabled agent so the operator sees
 * exactly what's running for them, not a generic "AI agents page."
 *
 * Display rule: an entry is shown EVEN IF its host machine is offline.
 * The catalog says what the agent CAN run; the worker-tick badges on
 * /operations say what's actually firing right now.
 */

export type CatalogEntry = {
  name: string;
  /** "cron" / "process" / "workflow" / "skill-bundle" */
  kind: "cron" | "process" | "workflow" | "skill-bundle";
  description: string;
  /** Where the entry runs. */
  location: "vercel" | "local" | "n8n" | "supabase" | "browser";
  /** Cron-style schedule when applicable. */
  schedule?: string;
};

export type AgentCatalog = {
  crons: CatalogEntry[];
  processes: CatalogEntry[];
  workflows: CatalogEntry[];
};

const EMPTY: AgentCatalog = { crons: [], processes: [], workflows: [] };

export const AGENT_CATALOG: Record<string, AgentCatalog> = {
  bravo: {
    crons: [
      {
        name: "Daily Bravo Brief",
        kind: "cron",
        description: "AI-narrated pipeline, follow-up, and client-health brief for CC.",
        location: "local",
        schedule: "0 6 * * *",
      },
      {
        name: "Inbound Email Sweep",
        kind: "cron",
        description: "Classifies unread Gmail and routes support, opportunity, and financial work.",
        location: "local",
        schedule: "*/5 * * * *",
      },
      {
        name: "Bravo — Hourly Cron Health Check",
        kind: "cron",
        description: "Alerts CC when any registered scheduled job reports an error.",
        location: "local",
        schedule: "0 * * * *",
      },
    ],
    processes: [
      { name: "lead_engine", kind: "process", description: "CRM, scoring, pipeline, follow-ups.", location: "local" },
      { name: "outreach_engine", kind: "process", description: "Cold outreach + reply handling.", location: "local" },
      { name: "send_gateway", kind: "process", description: "Email chokepoint with 8-gate safety pipeline.", location: "local" },
      { name: "client_health", kind: "process", description: "Client-health scoring + churn alerts.", location: "local" },
      { name: "ceo_dashboard", kind: "process", description: "Daily KPI rollup + briefing.", location: "local" },
      { name: "telegram bridge", kind: "process", description: "Mobile control surface; routes back to chat.", location: "local" },
    ],
    workflows: [
      { name: "n8n inbound qualifier", kind: "workflow", description: "Classifies inbound email + posts to /api/inbound/n8n.", location: "n8n" },
      { name: "agent inbox", kind: "workflow", description: "Cross-agent async messages (Codex/Atlas/Maven post here).", location: "supabase" },
    ],
  },

  lex: {
    crons: [],
    processes: [
      { name: "contract-draft", kind: "skill-bundle", description: "Draft OASIS-favorable contracts from the clause library, with governing law + disclaimer.", location: "local" },
      { name: "contract-review", kind: "skill-bundle", description: "Adversarial review of inbound agreements; every risk clause ranked walk/negotiate/accept.", location: "local" },
      { name: "send_gateway", kind: "process", description: "Outbound chokepoint — blocks any send missing the not-legal-advice disclaimer.", location: "local" },
    ],
    workflows: [
      { name: "clause library", kind: "skill-bundle", description: "Reusable OASIS-favorable clause bank + seed templates (mutual NDA, SOW).", location: "local" },
      { name: "lex_matters", kind: "workflow", description: "Multi-tenant matters/contracts/versions store (RLS-scoped). Schema staged in Lex-Agent/database/migrations.", location: "supabase" },
    ],
  },

  atlas: {
    crons: [
      { name: "Atlas — Inbound Financial Email", kind: "cron", description: "Consumes financial-email handoffs and books verified receipts/invoices.", location: "local", schedule: "*/15 * * * *" },
      { name: "Atlas — Daily Tax Deadline Scan", kind: "cron", description: "Checks critical filing deadlines and alerts inside the configured lead window.", location: "local", schedule: "0 7 * * *" },
      { name: "Atlas — Pulse Refresh", kind: "cron", description: "Refreshes the CFO pulse from connected finance sources.", location: "local", schedule: "0 */4 * * *" },
      { name: "Atlas — Wealthsimple Balance Nudge", kind: "cron", description: "Prompts CC when a registered-account balance is stale.", location: "local", schedule: "0 18 * * SUN" },
    ],
    processes: [
      { name: "trade_engine", kind: "process", description: "12+ strategies, conviction scoring, stop-loss enforcement.", location: "local" },
      { name: "tax_calculator", kind: "process", description: "CRA / cross-jurisdiction tax engine.", location: "local" },
      { name: "financial_advisor", kind: "process", description: "FIRE projections, wealth tracker, budget enforcement.", location: "local" },
      { name: "wealth_tracker", kind: "process", description: "Net-worth + liquidity dashboard.", location: "local" },
    ],
    workflows: [
      { name: "broker reconcile", kind: "workflow", description: "Pulls Kraken / Wise / IBKR balances daily.", location: "local" },
      { name: "spend_gate", kind: "workflow", description: "Pre-spend checkpoint Maven hits before any ad-budget commit.", location: "supabase" },
    ],
  },

  maven: {
    crons: [
      { name: "Marketing Publish Drain", kind: "cron", description: "Publishes approved Library intents through Maven's guarded send path.", location: "local", schedule: "* * * * *" },
      { name: "Training Corpus Ingest", kind: "cron", description: "Turns Train Maven links into brand-style exemplars.", location: "local", schedule: "*/5 * * * *" },
      { name: "Library Post Linker", kind: "cron", description: "Links Library assets to the posts that actually published.", location: "local", schedule: "17 * * * *" },
      { name: "Post Analytics Sync", kind: "cron", description: "Pulls real per-platform post performance into the founders Library.", location: "local", schedule: "17 * * * *" },
      { name: "Maven — Carousel Post", kind: "cron", description: "Runs the complete GEN-10 author, render, plan, delivery, and Library chain.", location: "local", schedule: "0 8 * * *" },
      { name: "Carousel Media Retention", kind: "cron", description: "Safely prunes old unbooked carousel renders after the 60-day retention window.", location: "local", schedule: "50 3 * * *" },
    ],
    processes: [
      { name: "content_pipeline", kind: "process", description: "Video pipeline (Remotion + FFmpeg + Whisper + ElevenLabs).", location: "local" },
      { name: "ad_engine", kind: "process", description: "Meta + Google paid ads orchestration.", location: "local" },
      { name: "competitive_intel", kind: "process", description: "Tracks competitor ads + content + battlecards.", location: "local" },
      { name: "lead_scraper", kind: "process", description: "Firecrawl-driven prospect research.", location: "local" },
    ],
    workflows: [
      { name: "brand_voice_check", kind: "workflow", description: "Pre-publish gate against brand-voice corpus.", location: "local" },
      { name: "captions_pipeline", kind: "workflow", description: "Whisper word-level → SRT → cinematic captions.", location: "local" },
    ],
  },

  aura: {
    // No registered Aura schedule exists in either cron table today. Keep
    // capabilities below, but do not invent runnable cards.
    crons: [],
    processes: [
      { name: "home_assistant_bridge", kind: "process", description: "ESP32 + Pi 5 hub, scenes, automations.", location: "local" },
      { name: "voice_agent", kind: "process", description: "Local-first voice loop, no cloud audio leave-the-device.", location: "local" },
      { name: "habits_log", kind: "process", description: "Append-only habit + workout journal.", location: "local" },
    ],
    workflows: [
      { name: "morning_scene", kind: "workflow", description: "Wake routine: lights + climate + briefing.", location: "local" },
      { name: "wind_down", kind: "workflow", description: "Evening routine: dim, lock, prep tomorrow.", location: "local" },
    ],
  },

  hermes: {
    crons: [
      { name: "po_inbox_scan", kind: "cron", description: "Scans Emmanuel's PO inbox for new files; parses + queues.", location: "local", schedule: "*/10 * * * *" },
      { name: "chargeback_watch", kind: "cron", description: "Pre-emptive compliance check across active orders.", location: "local", schedule: "0 */2 * * *" },
    ],
    processes: [
      { name: "a2000_takeover", kind: "process", description: "pywinauto-driven order entry into the A2000 desktop ERP.", location: "local" },
      { name: "edi_processor", kind: "process", description: "EDI 856/810/940/820 round-trip handling.", location: "local" },
      { name: "label_printer", kind: "process", description: "GS1-128 + UCC-128 SSCC label generation.", location: "local" },
      { name: "audit_log", kind: "process", description: "Append-only log of every order action.", location: "local" },
    ],
    workflows: [
      { name: "po_to_pos_to_invoice", kind: "workflow", description: "End-to-end commerce ops happy path.", location: "local" },
      { name: "chargeback_dispute", kind: "workflow", description: "Auto-builds dispute packet from audit log.", location: "local" },
    ],
  },

  solara: {
    crons: [
      {
        name: "sunbiz-daily-brief",
        kind: "cron",
        description: "Summarizes hot leads, missing docs, expiring offers, and renewal candidates for the morning dashboard.",
        location: "vercel",
        schedule: "0 12 * * 1-5",
      },
      {
        name: "sunbiz-renewal-sweep",
        kind: "cron",
        description: "Finds funded deals moving into the 40-60% payback window and queues the next renewal action.",
        location: "vercel",
        schedule: "0 15 * * *",
      },
      {
        name: "sunbiz-lender-followup",
        kind: "cron",
        description: "Checks lender response SLA by application and flags files that need a nudge.",
        location: "vercel",
        schedule: "0 */4 * * 1-5",
      },
    ],
    processes: [
      { name: "funding-record-actions", kind: "process", description: "Creates and updates leads, funded deals, renewals, lenders, and commissions through manifest-validated dashboard actions.", location: "supabase" },
      { name: "lender-match-ranker", kind: "process", description: "Ranks lenders by product type, revenue floor, FICO floor, and response SLA.", location: "local" },
      { name: "sunbiz-import-dedupe", kind: "process", description: "Normalizes CSV imports and de-duplicates by business, phone, and email before records enter the pipeline.", location: "local" },
    ],
    workflows: [
      { name: "funded-deal-to-renewal", kind: "workflow", description: "When a deal is logged as funded, prepares renewal timing and commission follow-up fields.", location: "supabase" },
      { name: "missing-info-triage", kind: "workflow", description: "Converts lender info requests into missing-info chips and next actions on the lead/application.", location: "supabase" },
    ],
  },

  helios: {
    crons: [
      {
        name: "sunbiz-followup-cadence",
        kind: "cron",
        description: "Builds draft follow-ups for hot leads, ghosted applications, and expired offers inside TCPA send windows.",
        location: "vercel",
        schedule: "*/30 9-20 * * 1-5",
      },
      {
        name: "sunbiz-stale-lead-revival",
        kind: "cron",
        description: "Finds leads with no touch in 72 hours and drafts a revival message for operator approval.",
        location: "vercel",
        schedule: "0 14 * * 1-5",
      },
    ],
    processes: [
      { name: "outreach-draft-engine", kind: "process", description: "Drafts SMS and email copy; never sends directly without the send gateway / operator approval path.", location: "supabase" },
      { name: "tcpa-guard", kind: "process", description: "Applies opt-out language, weekend policy, and local send-window rules to every outreach draft.", location: "supabase" },
    ],
    workflows: [
      { name: "ghosted-application-revival", kind: "workflow", description: "Creates a 3-touch sequence for signed applications that stopped responding.", location: "supabase" },
      { name: "expired-offer-close-loop", kind: "workflow", description: "Drafts a direct but human close-the-loop note when an approved offer expires.", location: "supabase" },
    ],
  },
  // Life Preservation catalog stays empty until the repo ships real
  // processes — CC noted data ingestion + persona tuning are still
  // active work. CLAUDE.md rule: "Do not fake agent status. Unknown
  // must show as unknown." The /agents capabilities card skips empty
  // agents (total === 0 => return null) so this just won't render
  // until there's something real to show.
  "life-preservation": EMPTY,
};

export function catalogFor(agentKey: string): AgentCatalog {
  return AGENT_CATALOG[agentKey] || EMPTY;
}
