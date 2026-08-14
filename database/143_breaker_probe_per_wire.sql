-- 143 — one half-open probe lease PER WIRE, not per tenant. (Postgres form.)
--
-- Companion to database/turso/143_breaker_probe_per_wire.turso.sql, which is
-- the one that has actually been APPLIED. Turso is the live data plane
-- (cutover 2026-08-09) and this file has deliberately not been run anywhere.
--
-- It exists because getServiceSupabase() still has a Postgres path when
-- EMPIRE_DATA_BACKEND is unset, and claimBreakerProbe now upserts and filters
-- on a `wire` column. Against the un-widened table both statements error, are
-- converted to `false`, and every half-open recovery probe is suppressed
-- forever — a halted wire could never test whether it had come back. Codex
-- caught that the pair was missing. Cheap insurance for a rollback; keeping the
-- two schemas in step is the repo convention (see 140/141/142).
--
-- WHY. As of 2026-08-14 a tenant can have more than one independent TextTorrent
-- account: the main SunBiz SID (three rep wires) and the Legacy parent, whose
-- AI Follow-Up sub-account carries Live Subs. They are separately registered
-- with the carrier and they recover independently. A lease keyed on tenant_id
-- alone let whichever wire the dispatch loop reached first take the only probe
-- every interval, wedging the other route indefinitely.

BEGIN;

ALTER TABLE public.sms_breaker_probes
  ADD COLUMN IF NOT EXISTS wire text NOT NULL DEFAULT 'main';

-- Widen the key. Existing rows already read wire='main' from the default, so
-- their leases carry across untouched — which matters: resetting last_probe_at
-- would hand every tenant a free probe on the first dispatch after deploy, a
-- burst of sends into a route the breaker had deliberately halted.
ALTER TABLE public.sms_breaker_probes
  DROP CONSTRAINT IF EXISTS sms_breaker_probes_pkey;

ALTER TABLE public.sms_breaker_probes
  ADD CONSTRAINT sms_breaker_probes_pkey PRIMARY KEY (tenant_id, wire);

COMMIT;
