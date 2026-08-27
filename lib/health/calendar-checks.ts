/**
 * lib/health/calendar-checks.ts — can the shared OASIS calendar still book?
 *
 * WHY. Between 2026-08-25 and 2026-08-27 the founder-handoff "Book meeting &
 * send invite" button did not work for anyone, and the way that was discovered
 * was a rep clicking it. Nothing watched the credential the whole chain rests
 * on, so the outage was found by the failure it caused rather than announced
 * before anyone hit it.
 *
 * WHAT MAKES THIS ONE WORTH A CHECK. Google reports refresh-credential
 * revocation the same way it reports every other bad grant: only when you try
 * to spend it. There is NO local signal. An `expires_at` column would not have
 * caught the 2026-08-26 case, because the credential had not expired — it had
 * been withdrawn. Every cheap, local way of asking "is the calendar ok" returns
 * a confident yes over a dead credential, which is exactly what the handoff
 * banner did for two days (#322, then again at the workspace level in #331).
 *
 * So this check spends it, through the same probe the readiness banner uses.
 * That shared probe is deliberate: the incident this exists to prevent was two
 * surfaces asking Google different questions and getting different answers.
 */

import "server-only";
import { systemCalendarConfig } from "@/lib/integrations/google-calendar";
import { probeRefreshToken } from "@/lib/integrations/google-token-probe";
import type { DripCheck } from "./drip-checks";

/**
 * Observed values double as the failure MODE, so `describe` can stay a pure
 * function of its CheckResult.
 *
 * The first version of this cached the mode in a module-level variable that
 * `observe` wrote and `describe` read. Two things were wrong with that. It is
 * not the pattern the other checks use — DEPLOY_CHECKS re-derives everything in
 * `describe` and holds no state — and `runCheck` awaits between observe and
 * describe, so a second invocation landing in the same warm process could
 * rewrite the mode under the first one and print the wrong remedy. A monitor
 * that names the wrong fix under load is worse than one that says less.
 *
 * Any non-zero fails `must_be_zero`, so both modes alert, and the distinction
 * now also persists into health_check_runs.observed — the history can answer
 * "was it ever misconfigured, or only ever rejected?"
 */
const OK = 0;
const UNCONFIGURED = 1;
const REJECTED = 2;

export const CALENDAR_CHECKS: DripCheck[] = [
  {
    id: "calendar.workspace_credential_usable",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: async () => {
      // Only production is doctrine-bound to hold a working workspace
      // credential. Previews and local dev legitimately run without one, and
      // grading those would be a standing false alarm that gets the whole
      // channel muted — the same reasoning as deploy.prod_serves_main.
      if (process.env.VERCEL_ENV !== "production") return OK;

      const config = systemCalendarConfig();
      // Not a degraded state: with no workspace credential, EVERY host whose
      // personal Google is missing, wrong-scoped or revoked is unbookable, and
      // the fallback that exists to cover them cannot run at all.
      if (!config) return UNCONFIGURED;

      const verdict = await probeRefreshToken({
        refreshToken: config.refreshToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      });
      // POLICY ON THE THIRD ANSWER, stated where it applies: `unknown` scores
      // healthy. Paging an operator every time Google has a bad minute is how a
      // channel gets muted, and a muted monitor is worse than none. This
      // credential fails permanently, not intermittently, so a real outage is
      // delayed by one 15-minute tick at worst — a far better trade than a
      // recurring false alarm. The readiness banner takes `unknown` differently
      // and says so at its own call site; that divergence is intentional.
      return verdict === "dead" ? REJECTED : OK;
    },
    describe: (r) => {
      if (r.observed === OK) {
        return "the shared OASIS calendar credential is live — founder audits can be booked.";
      }
      if (r.observed === UNCONFIGURED) {
        return (
          "THE SHARED OASIS CALENDAR IS NOT CONFIGURED — GOOGLE_SYSTEM_CALENDAR_CLIENT_ID, " +
          "_CLIENT_SECRET and _REFRESH_TOKEN must all be set in Vercel production. " +
          "Until they are, any host without a working personal Google connection cannot be " +
          "booked at all, because the fallback that covers them has nothing to run on."
        );
      }
      return (
        "THE SHARED OASIS CALENDAR CREDENTIAL WAS REJECTED BY GOOGLE — nobody can book a " +
        "founder audit through the shared calendar right now. Asking a host to reconnect " +
        "will NOT fix this: it is the workspace credential, not theirs. An administrator " +
        "must mint a new one with Calendar scope for the account in " +
        "GOOGLE_SYSTEM_CALENDAR_ADDRESS, minted by the SAME OAuth client as " +
        "GOOGLE_SYSTEM_CALENDAR_CLIENT_ID — a credential from a different client is " +
        "rejected however new it is. Verify with scripts/verify-workspace-calendar-live.ts."
      );
    },
  },
];
