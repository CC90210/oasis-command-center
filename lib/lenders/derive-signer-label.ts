/**
 * derive-signer-label.ts — Adon spec section 2.4 (2026-06-10).
 *
 * Pure function (no fs, no DB) so both client AND server can compute
 * the signer label from the same primitive: the post-checkbox CC list +
 * the agent roster. Splits the previously-duplicated logic between
 * lib/config/agents.ts (server, fs-touching) and the panel-client's
 * useMemo (client). Both now call this.
 *
 * Rule:
 *   - Exactly one agent on CC → THAT agent signs (name from roster).
 *   - Zero or multiple → "SunBiz Submissions" (the shared identity).
 *
 * Case-insensitive email comparison; whitespace trimmed.
 */

export type SignerRosterEntry = {
  /** Email used as the lookup key — case-insensitive. */
  email: string;
  /** Display name returned when this agent is the sole CC. */
  name: string;
};

/**
 * Return the signer display name implied by the current CC list.
 * Always returns a string — "SunBiz Submissions" is the safe fallback.
 */
export function deriveSignerName(
  ccEmails: string[],
  roster: SignerRosterEntry[],
): string {
  if (ccEmails.length === 1) {
    const target = ccEmails[0].trim().toLowerCase();
    for (const agent of roster) {
      if (agent.email.trim().toLowerCase() === target) return agent.name;
    }
  }
  return "SunBiz Submissions";
}
