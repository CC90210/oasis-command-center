-- Persist the successful end-to-end probe that authorized a saved
-- device-backed engine. Probe freshness is a save-time concurrency/safety
-- gate; once saved, the proof remains valid for exactly that engine-row
-- version while live pairing/runtime health is checked separately.

ALTER TABLE agent_model_config ADD COLUMN runtime_probe_job_id TEXT;
ALTER TABLE agent_model_config ADD COLUMN runtime_probe_pairing_id TEXT;
ALTER TABLE agent_model_config ADD COLUMN runtime_probe_engine_kind TEXT;
ALTER TABLE agent_model_config ADD COLUMN runtime_probe_engine_name TEXT;
ALTER TABLE agent_model_config ADD COLUMN runtime_probe_engine_version TEXT;
ALTER TABLE agent_model_config ADD COLUMN runtime_probe_verified_at TEXT;
