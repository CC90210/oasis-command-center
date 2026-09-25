-- 179 - deactivate teammates instead of deleting them (2026-09-24).
--
-- CC retired the OASIS sales team but wants the people reactivatable, with
-- their history intact. A deactivated profile keeps every row it ever touched;
-- lib/team.ts drops it from every live roster (assign lists, rep chips, the
-- sales scorecard, commissions, form routing) and lib/team-activation.ts bans
-- the login and bumps the session epoch so open cookies die immediately.
--
-- Additive and nullable: NULL means active, so every existing row stays active
-- and older code that never selects these columns is unaffected.

ALTER TABLE user_profiles ADD COLUMN deactivated_at TEXT;
ALTER TABLE user_profiles ADD COLUMN deactivated_by TEXT;
ALTER TABLE user_profiles ADD COLUMN deactivation_reason TEXT;
