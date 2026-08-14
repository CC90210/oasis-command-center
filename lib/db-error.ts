/**
 * Turn a database driver error into a real `Error` that keeps its reason.
 *
 * THE BUG THIS EXISTS FOR (2026-08-14). Every team invite had failed since the
 * Turso cutover and the screen said only `invite_create_failed`. The cause was a
 * NOT NULL violation the database reported perfectly well:
 *
 *   NOT NULL constraint failed: tenant_invites.expires_at
 *
 * That message was thrown away at a boundary. `lib/team.ts` did:
 *
 *   throw error ?? new Error("invite_create_failed");
 *
 * A PostgREST / libSQL error is a PLAIN OBJECT, not an `Error`. The route then
 * did the idiomatic-looking thing:
 *
 *   err instanceof Error ? err.message : "invite_create_failed"
 *
 * — false for a plain object, so it fell through to the fallback string. The
 * diagnosis was sitting in memory and nobody could see it, for months.
 *
 * `throw error` is not wrong because throwing is wrong. It is wrong because what
 * comes back from these drivers is not an Error, and every generic handler in a
 * TypeScript codebase narrows on `instanceof Error`.
 *
 * USE THIS at any point where a driver error leaves the function that made the
 * query. `tests/db-error-contract.test.ts` fails the build on new bare throws and
 * lists the pre-existing ones as declared debt.
 */

/** The shape both the PostgREST client and the libSQL bridge return. */
export type DriverError = {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};

/**
 * @param label  where it happened, e.g. "invite.create" — survives into the log
 *               line and the operator-facing message, so a support ticket names
 *               the query rather than the screen.
 */
export function dbError(label: string, error: DriverError | null | undefined): Error {
  const message = error?.message ?? "the query returned no row and no error";
  const code = error?.code ? ` [${error.code}]` : "";
  // details/hint are where Postgres puts the actually-useful part of a
  // constraint violation; libSQL leaves them undefined and that is fine.
  const extra = [error?.details, error?.hint].filter(Boolean).join(" ");
  const err = new Error(`${label}: ${message}${code}${extra ? ` — ${extra}` : ""}`);
  err.name = "DbError";
  // Keep the original reachable for anything that wants to branch on the code
  // rather than parse English.
  (err as Error & { cause?: unknown }).cause = error ?? undefined;
  return err;
}

/** True when `e` came from dbError() — lets a caller branch without string matching. */
export function isDbError(e: unknown): e is Error {
  return e instanceof Error && e.name === "DbError";
}
