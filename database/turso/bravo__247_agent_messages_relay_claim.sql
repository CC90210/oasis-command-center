-- bravo__247_agent_messages_relay_claim.sql (2026-10-28)
--
-- A directive is reserved for ONE computer before it is handed over (Codex
-- review of Command Center #768): two approved computers of the agents owner
-- polling at the same moment must not both write it into their agents' inboxes.
--
--   relay_claimed_at   when delivered_pairing_id reserved the directive
--                      (app/api/bridge/inbox GET pending, one UPDATE ... RETURNING).
--                      A reservation older than 5 minutes with no delivery may
--                      be taken by another computer: the first one stopped
--                      partway.
--
-- Additive only.

ALTER TABLE agent_messages ADD COLUMN relay_claimed_at TEXT;
