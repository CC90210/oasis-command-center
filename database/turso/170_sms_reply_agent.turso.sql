-- 170 - durable inbound-SMS queue, per-number conversation state, and worker
-- health for the founder-meeting reply agent. Additive only.

CREATE TABLE IF NOT EXISTS "sms_agent_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenant_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_message_id" TEXT NOT NULL,
  "from_phone" TEXT NOT NULL,
  "to_phone" TEXT NOT NULL,
  "phone_last10" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "lead_id" TEXT,
  "appointment_id" TEXT,
  "interaction_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending','running','done','escalated','dead_letter')),
  "intent" TEXT
    CHECK ("intent" IS NULL OR "intent" IN
      ('confirm','reschedule','cancel','running_late','question','opt_out','unknown')),
  "intent_confidence" TEXT
    CHECK ("intent_confidence" IS NULL OR "intent_confidence" IN ('high','low')),
  "intent_source" TEXT NOT NULL DEFAULT 'none'
    CHECK ("intent_source" IN ('rules','llm','none')),
  "proposed_action" TEXT,
  "executed_action" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "lease_token" TEXT,
  "lease_expires_at" TEXT,
  "last_error" TEXT,
  "received_at" TEXT NOT NULL
    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "completed_at" TEXT,
  UNIQUE ("tenant_id", "provider", "provider_message_id")
);

CREATE INDEX IF NOT EXISTS "sms_agent_jobs_status_received_idx"
  ON "sms_agent_jobs" ("status", "received_at");
CREATE INDEX IF NOT EXISTS "sms_agent_jobs_tenant_phone_received_idx"
  ON "sms_agent_jobs" ("tenant_id", "phone_last10", "received_at");

CREATE TABLE IF NOT EXISTS "sms_agent_conversations" (
  "tenant_id" TEXT NOT NULL,
  "phone_last10" TEXT NOT NULL,
  "lead_id" TEXT,
  "appointment_id" TEXT,
  "state" TEXT NOT NULL DEFAULT 'idle'
    CHECK ("state" IN ('idle','awaiting_slot_choice','awaiting_rep','closed')),
  "proposed_slots" TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid("proposed_slots")),
  "state_expires_at" TEXT,
  "last_inbound_sid" TEXT,
  "last_outbound_at" TEXT,
  "agent_turns_24h" INTEGER NOT NULL DEFAULT 0 CHECK ("agent_turns_24h" >= 0),
  "turn_window_started_at" TEXT,
  "automation_paused" INTEGER NOT NULL DEFAULT 0
    CHECK ("automation_paused" IN (0,1)),
  "paused_reason" TEXT,
  PRIMARY KEY ("tenant_id", "phone_last10")
);

CREATE TABLE IF NOT EXISTS "sms_agent_worker_health" (
  "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
  "status" TEXT NOT NULL CHECK ("status" IN ('healthy','degraded')),
  "last_run_at" TEXT NOT NULL,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "failed" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "updated_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
