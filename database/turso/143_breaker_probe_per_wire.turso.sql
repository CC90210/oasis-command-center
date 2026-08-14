-- 143 — one half-open probe lease PER WIRE, not per tenant.
--
-- WHY. As of 2026-08-14 a tenant can have more than one independent TextTorrent
-- account: the main SunBiz SID (three rep wires) and the Legacy parent, whose
-- "AI Follow-Up" sub-account carries Live Subs. They are separately registered
-- with the carrier and they recover independently.
--
-- The lease was keyed on tenant_id alone, so whichever wire the dispatch loop
-- reached first took the only probe every interval and the other route could be
-- wedged indefinitely — never permitted to test whether it had come back.
-- Caught by Codex in review of the AI-wire change.
--
-- SQLite cannot widen a PRIMARY KEY in place, so this is a table rebuild.
-- Existing rows become the "main" wire, which is what they were.

-- No explicit BEGIN/COMMIT: turso_sql.mjs runs a file as one batch, which is
-- already transactional, and a nested BEGIN errors out.

CREATE TABLE "sms_breaker_probes_new" (
  "tenant_id"     TEXT NOT NULL,
  -- Which sending wire this lease governs. "main" = the SunBiz SID rep
  -- wires; "ai_followup" = the Legacy parent AI Follow-Up sub-account.
  -- Defaulted so any caller that predates the per-wire split still lands on
  -- the same lease as before, rather than silently creating a second one.
  "wire"          TEXT NOT NULL DEFAULT 'main',
  "last_probe_at" TEXT NOT NULL DEFAULT '1970-01-01 00:00:00+00',
  "updated_at"    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("tenant_id", "wire"),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
);

-- Carry the existing leases across as the main wire. Preserving last_probe_at
-- matters: resetting it to the epoch would hand out a free probe to every
-- tenant on the first dispatch after deploy, which is a burst of sends into a
-- route the breaker had deliberately halted.
INSERT INTO "sms_breaker_probes_new" ("tenant_id", "wire", "last_probe_at", "updated_at")
SELECT "tenant_id", 'main', "last_probe_at", "updated_at" FROM "sms_breaker_probes";

DROP TABLE "sms_breaker_probes";
ALTER TABLE "sms_breaker_probes_new" RENAME TO "sms_breaker_probes";
