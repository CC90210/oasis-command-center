/**
 * lib/db-bool.ts - a yes/no flag read back from the database, read one strict way.
 *
 * WHY (PR #544 review, 2026-10-08). The store has no boolean type. SQLite keeps
 * a yes/no flag as the INTEGER 0 or 1 and the Turso adapter hands back that
 * number (lib/turso-postgrest.ts), while the old Postgres rows, test fixtures
 * and some RPC results carry real booleans. Every reader guessed at the shape,
 * and two guesses were wrong in opposite directions:
 *
 *   !!flag          reads the STRING "0" as yes, so a member whose is_owner came
 *                   back as "0" stood in for the workspace owner (full Forms
 *                   write access, among others).
 *   flag === true   reads the INTEGER 1 as no, so an admin's full-access grant
 *                   (admin_access) did nothing wherever it was compared that way.
 *
 * THE RULE. Exactly three shapes mean yes: true, 1 and "1". Everything else
 * means no: false, 0, "0", null, undefined, "", and anything stranger ("true",
 * " 1", "1.0", 2, NaN, an object). A permission that cannot be read for certain
 * is refused.
 *
 * Why the string "true" is no: nothing in the app writes it. The adapter binds a
 * boolean as 1 or 0 and both permission columns are INTEGER NOT NULL; the live
 * census on 2026-10-08 found every row stored as the integer 0 or 1. A "true"
 * string would have been written from outside the app, and a permission that
 * came from there is refused rather than guessed at.
 *
 * Every read of user_profiles.is_owner and user_profiles.admin_access in app/,
 * lib/ and components/ goes through dbBool: tests/db-bool.test.ts parses the
 * source and fails on a raw read.
 *
 * A leaf module with no imports, so route handlers, server pages and client
 * components can all use it.
 */
export function dbBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}
