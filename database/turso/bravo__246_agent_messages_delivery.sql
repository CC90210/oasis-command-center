-- bravo__246_agent_messages_delivery.sql (2026-10-28)
--
-- Admin > Agent ops: what happened to a directive after it was posted.
--
--   relay_eligible        1 = the agents owner's computer may write this note into
--                         its agent's local inbox (tmp/agent_inbox/inbox/). Set
--                         only for a directive the operator posts from the
--                         dashboard to an agent that has a local reader. Every
--                         row that exists when this runs keeps 0, so an old
--                         note is never sent again.
--   delivered_at,         the first computer that wrote it there (first writer
--   delivered_pairing_id, wins: the delivery update matches delivered_at IS NULL).
--   delivered_label
--   acked_at              the agent moved it to its read/ folder; reported by
--                         the computer that delivered it.
--   read_via              who marked it read: dashboard | cloud_chat | agent.
--
-- Additive only. No row is rewritten except the explicit relay_eligible = 0 below.

ALTER TABLE agent_messages ADD COLUMN relay_eligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_messages ADD COLUMN delivered_at TEXT;
ALTER TABLE agent_messages ADD COLUMN delivered_pairing_id TEXT;
ALTER TABLE agent_messages ADD COLUMN delivered_label TEXT;
ALTER TABLE agent_messages ADD COLUMN acked_at TEXT;
ALTER TABLE agent_messages ADD COLUMN read_via TEXT;

UPDATE agent_messages SET relay_eligible = 0 WHERE relay_eligible <> 0;

CREATE INDEX IF NOT EXISTS idx_agent_messages_relay_pending
  ON agent_messages (tenant_id, relay_eligible, delivered_at, created_at);
