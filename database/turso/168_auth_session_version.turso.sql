-- 168 - revoke every older browser session when an account password changes.
--
-- Existing cookies are treated as version zero, so this migration is
-- non-disruptive. Password reset/change increments the account epoch and new
-- cookies carry the incremented value; every prior cookie then fails the
-- database-backed session check.

ALTER TABLE "_supabase_auth_users"
  ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0;
