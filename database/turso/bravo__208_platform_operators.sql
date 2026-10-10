-- bravo__208_platform_operators.sql
--
-- Platform operators keyed by AUTH USER ID (doc 02 P0-7, the durable fix named in
-- lib/platform-operator.ts). An operator was an email alias in a Worker secret plus a
-- founder seat in the OASIS tenant; a founder whose email is not an alias (Adon, an
-- equal owner) had no operator console. A row here stands in for the alias, keyed by
-- the auth user id, never by an email a stranger could register. The founder-seat half
-- of the check is unchanged and still required.
--
-- No route writes this table. Rows are added and revoked by hand by an operator with
-- direct database access; revoke by setting revoked_at, never by deleting the row, so
-- the history of who held operator power survives.
-- House rules: IF NOT EXISTS everywhere; no CHECK; timestamps are ISO-8601 TEXT.

CREATE TABLE IF NOT EXISTS platform_operators (
  auth_user_id  TEXT PRIMARY KEY,
  added_by      TEXT NOT NULL,
  added_at      TEXT NOT NULL,
  note          TEXT,
  revoked_at    TEXT
);
