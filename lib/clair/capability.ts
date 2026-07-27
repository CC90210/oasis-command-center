/**
 * The CLEAR capability check — "may this bridge call spend a regulated query?"
 *
 * Pure and server-only-free ON PURPOSE, exactly like bridge-target-resolver.ts:
 * lib/bridge-proxy.ts carries `import "server-only"`, so a predicate that lives
 * there cannot be unit-tested. The rule matters too much to be untested, so it
 * lives here and bridge-proxy calls it.
 *
 * WHY THIS EXISTS AT THE TRANSPORT AND NOT ONLY IN THE ROUTE.
 * Codex review 2026-07-27 [P2]: the static test that pins "clair_report is
 * invoked from exactly one file" reads source text, so it recognises
 * "clair_report" and 'clair_report' but not a backtick literal, a concatenation,
 * or a shared constant. A grep-shaped guard can only ever catch the spellings it
 * anticipated. This check runs on the RESOLVED runtime value inside
 * callBridgeExecTool — the single door every bridge caller must pass through —
 * so how the caller spelled the tool name is irrelevant.
 *
 * WHAT IT GUARANTEES: a CLEAR pull cannot happen without a named operator
 * attached to it. Automated callers (cron, worker, queue, server-to-server)
 * have no operator to name, so they fail closed here, before the network call
 * and before any spend.
 *
 * WHAT IT DOES NOT GUARANTEE: it is not proof against a human who deliberately
 * forges an operator id. That is forgery, not the accident this defends.
 */

/** The bridge tool name the VPS dispatches a Thomson Reuters CLEAR pull on. */
export const CLAIR_TOOL_NAME = "clair_report";

function nonEmptyString(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Returns an error code when this bridge body is a CLEAR pull that lacks
 * operator attribution, or null when the call may proceed. Non-CLEAR tools are
 * never affected.
 */
export function clairCapabilityError(body: Record<string, unknown>): string | null {
  if (body?.tool_name !== CLAIR_TOOL_NAME) return null;
  if (!nonEmptyString(body.requested_by) || !nonEmptyString(body.requested_by_email)) {
    return "clair_requires_operator_attribution";
  }
  return null;
}
