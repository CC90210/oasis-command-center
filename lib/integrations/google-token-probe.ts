/**
 * lib/integrations/google-token-probe.ts — is this Google refresh credential
 * still spendable? One implementation, because there is exactly one right
 * answer and more than one caller.
 *
 * WHY THIS EXISTS. The 2026-08-26 outage was caused, in the operator's words,
 * by "the readiness check and the booking asking different questions": the
 * handoff banner tested that a credential STRING EXISTED while the booking
 * tested whether Google would honour it. Two askers, two answers, one green
 * banner over a dead credential.
 *
 * By 2026-08-27 there were about to be three. The per-host readiness probe in
 * app/api/team/members and the workspace-credential watchdog in
 * lib/health/calendar-checks each had their own copy of the same request and
 * the same status-code reasoning. Copies drift, and the drift is silent: tune
 * the 5xx handling in one and the banner and the watchdog quietly disagree
 * about whether OASIS can book, which is the exact failure this codebase
 * already paid for once.
 *
 * ═══ MECHANISM IS SHARED. POLICY IS NOT. ═══════════════════════════════════
 *
 * This returns a three-state verdict and deliberately stops there. `unknown`
 * is a real and distinct answer -- Google had a bad minute, the socket hung up
 * -- and callers legitimately treat it DIFFERENTLY:
 *
 *   the readiness banner  preserves the previous belief, because telling a rep
 *                         to reconnect an account that is fine sends them off
 *                         to re-authorise something that was never broken.
 *
 *   the health watchdog   scores it healthy, because paging an operator every
 *                         time Google wobbles is how a channel gets muted, and
 *                         a muted monitor is worse than no monitor.
 *
 * Collapsing those into a boolean here would force one of them to be wrong.
 * What must not differ is the CLASSIFICATION, and that is what lives here.
 */

import "server-only";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_TIMEOUT_MS = 8_000;

export type TokenProbeVerdict =
  /** Google honoured the grant. */
  | "live"
  /** Google definitively refused it: revoked, wrong client, malformed. */
  | "dead"
  /** Google could not be asked. NOT a synonym for either of the above. */
  | "unknown";

/**
 * Spend the credential and report what Google said.
 *
 * Presents `clientId`/`clientSecret` as given: a refresh grant is only valid
 * from the client that MINTED it, so the caller must pass the credential's own
 * client rather than whichever one happens to be in the environment. Getting
 * that wrong is #331 and it presents as `invalid_client`, a 4xx -- correctly
 * reported here as `dead`, because from the caller's side a credential that
 * cannot be spent with the client it has IS dead.
 */
export async function probeRefreshToken(args: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<TokenProbeVerdict> {
  // Nothing to spend, and no network call worth making. Missing configuration
  // is the caller's to interpret -- it is not evidence about Google.
  if (!args.refreshToken || !args.clientId || !args.clientSecret) return "dead";

  const doFetch = args.fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: args.refreshToken,
        client_id: args.clientId,
        client_secret: args.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (res.ok) return "live";
    // 4xx is Google's definitive "this credential is no good".
    // 5xx is Google's problem and says nothing about the credential.
    return res.status >= 400 && res.status < 500 ? "dead" : "unknown";
  } catch {
    // Timeout, DNS, socket. We did not get an answer; we did not get a "no".
    return "unknown";
  }
}
