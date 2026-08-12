-- 142_sequence_daily_email_cap.turso.sql — the libSQL form of migration 142.
--
-- WHY A SECOND FILE. The live oasis data plane is Turso (bravo-empire), reached
-- through lib/turso-postgrest.ts behind getServiceSupabase() and gated on
-- EMPIRE_DATA_BACKEND=turso_cloud. The Postgres file next door cannot run here:
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, no `DO $$ ... $$` blocks, no
-- `COMMENT ON`, and no `ALTER TABLE ... ADD CONSTRAINT`.
--
-- Verified before writing this, rather than assumed: `drip_sequences` in
-- bravo-empire holds the live 11 sequences and already carries `email_class`
-- from migration 119, so this is the plane the app actually reads.
--
-- Keep the two files in step. If the estate ever moves back, 142 (Postgres) is
-- the same change in that dialect.

-- The cap. NULL = uncapped, which is the default and every existing row, so
-- this changes the behaviour of nothing until an operator sets a number.
-- 0 is a REAL value distinct from NULL: "send nothing from this sequence",
-- a pause that does not disable the sequence or lose its enrolments.
--
-- The CHECK rides along with ADD COLUMN because SQLite cannot add a table
-- constraint afterwards without rebuilding the table. 2000 mirrors
-- MAX_SEQUENCE_DAILY_CAP in lib/drips/sequence-volume-core.ts — a typo guard,
-- not a safety limit; the brand ceilings in governor.ts are the safety limit.
alter table drip_sequences
  add column daily_email_cap integer
  check (daily_email_cap is null or (daily_email_cap >= 0 and daily_email_cap <= 2000));

-- Serves the per-sequence daily count in lib/drips/sequence-volume.ts.
-- Attribution is by metadata.sequence_id, which the email send path already
-- stamps, with agent_source 'sequence:<name>' as the fallback for older rows —
-- a name is editable, so keying on it alone would let a rename silently reset a
-- sequence's day to zero.
create index if not exists lead_interactions_sequence_volume_idx
  on lead_interactions (created_at desc, type, direction);
