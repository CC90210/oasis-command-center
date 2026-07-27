/**
 * The CLEAR capability check — "may this bridge call spend a regulated query?"
 *
 * Pure and server-only-free ON PURPOSE, exactly like bridge-target-resolver.ts:
 * lib/bridge-proxy.ts carries `import "server-only"`, so a predicate that lives
 * there cannot be unit-tested. The rule matters too much to be untested, so it
 * lives here and bridge-proxy calls it with a session it resolved itself.
 *
 * WHY THIS EXISTS AT THE TRANSPORT AND NOT ONLY IN THE ROUTE.
 * Codex review 2026-07-27 [P2]: the static test that pins "clair_report is
 * named in exactly two files" reads source text, so it sees "clair_report" and
 * 'clair_report' but not a backtick literal, a concatenation, or a shared
 * constant. A grep-shaped guard only ever catches the spellings it anticipated.
 * This check runs on the RESOLVED runtime value inside callBridgeExecTool — the
 * single door every bridge caller must pass through — so spelling is irrelevant.
 *
 * WHY THE SESSION IS AN ARGUMENT AND NOT PART OF `body`.
 * Codex review 2026-07-27 [P1]: the first version of this gate only checked
 * that `requested_by` / `requested_by_email` were non-empty strings. That is
 * caller-supplied data — a cron passing `requested_by: "system"` satisfied it
 * and still spent a billable query. Attribution the caller writes about itself
 * is not authorization. The identity now comes from `getSessionUser()`, which
 * @supabase/ssr derives from the REQUEST COOKIES, and the caller's claimed
 * attribution must MATCH it. A cron, worker or queue has no user cookie (and
 * often no request scope at all), so it cannot produce a session and fails
 * closed here — before the network call and before any spend.
 *
 * WHAT THIS STILL DOES NOT COVER: someone operating with a real logged-in
 * operator's browser session. That is an authenticated human acting, which is
 * what "manual" means; it is not the accidental automation this defends.
 */

/** The bridge tool name the VPS dispatches a Thomson Reuters CLEAR pull on. */
export const CLAIR_TOOL_NAME = "clair_report";

/** The operator identity as resolved SERVER-SIDE from the request session. */
export type ClairSession = { userId: string | null; email: string | null } | null;

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Shape precondition: the body carries attribution at all. Split out so the
 * "must be attributed" rule can be read and tested on its own — it is NOT
 * sufficient by itself, and callers must use clairCapabilityError().
 */
export function clairAttributionError(body: Record<string, unknown>): string | null {
  if (body?.tool_name !== CLAIR_TOOL_NAME) return null;
  if (!nonEmpty(body.requested_by) || !nonEmpty(body.requested_by_email)) {
    return "clair_requires_operator_attribution";
  }
  return null;
}

/**
 * The real gate. Returns an error code when this bridge body is a CLEAR pull
 * that is not backed by the authenticated operator it claims, or null when the
 * call may proceed. Non-CLEAR tools are never affected.
 *
 * @param session identity resolved from the request cookies by the CALLER of
 *   this function (bridge-proxy), never taken from `body`. Pass null when there
 *   is no session or it could not be resolved — both mean "no human here".
 */
export function clairCapabilityError(
  body: Record<string, unknown>,
  session: ClairSession,
): string | null {
  if (body?.tool_name !== CLAIR_TOOL_NAME) return null;

  const shape = clairAttributionError(body);
  if (shape) return shape;

  // No authenticated operator behind this request → this is an automated
  // caller, whatever it wrote about itself.
  if (!session || !nonEmpty(session.userId)) {
    return "clair_requires_authenticated_operator";
  }

  // Attribution must name the ACTUAL session user. Otherwise a caller inside a
  // request could still spend the query in someone else's name.
  if (String(body.requested_by).trim() !== session.userId.trim()) {
    return "clair_attribution_mismatch";
  }
  if (
    nonEmpty(session.email) &&
    String(body.requested_by_email).trim().toLowerCase() !== session.email.trim().toLowerCase()
  ) {
    return "clair_attribution_mismatch";
  }

  return null;
}
