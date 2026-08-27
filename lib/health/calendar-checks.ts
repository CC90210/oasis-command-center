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
 * So this check spends it. That is the only question whose answer is worth
 * anything, and it is the same question the booking asks.
 *
 * DELIBERATELY FAILS SOFT ON "UNKNOWN". A 4xx from Google is definitive: the
 * credential is dead and nobody can book. A 5xx or a transport failure means we
 * do not know, and paging Adon because Google had a bad minute trains people to
 * ignore the channel. Unknown scores 0 here, matching the per-host probe in
 * app/api/team/members. Not knowing is not the same as broken, and it is also
 * not the same as healthy — but between a false page every time Google wobbles
 * and a real page delayed by 15 minutes, the second is the better trade for a
 * credential that fails permanently, not intermittently.
 */

import "server-only";
import { systemCalendarConfig } from "@/lib/integrations/google-calendar";
import type { DripCheck } from "./drip-checks";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Distinguishes the two failures, which have OPPOSITE remedies. */
let lastFailureMode: "unconfigured" | "rejected" | null = null;

export const CALENDAR_CHECKS: DripCheck[] = [
  {
    id: "calendar.workspace_credential_usable",
    severity: "critical",
    rule: { kind: "must_be_zero" },
    observe: async () => {
      // Only production is doctrine-bound to hold a working workspace
      // credential. Previews and local dev legitimately run without one, and
      // grading them would be a standing false alarm that gets the whole
      // channel muted -- the same reasoning as deploy.prod_serves_main.
      if (process.env.VERCEL_ENV !== "production") return 0;

      const config = systemCalendarConfig();
      if (!config) {
        // Not a degraded state: with no workspace credential, EVERY host whose
        // personal Google is missing, wrong-scoped or revoked is unbookable,
        // and the fallback that exists to cover them cannot run at all.
        lastFailureMode = "unconfigured";
        return 1;
      }

      try {
        const res = await fetch(GOOGLE_TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: config.refreshToken,
            client_id: config.clientId,
            client_secret: config.clientSecret,
          }).toString(),
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) {
          lastFailureMode = null;
          return 0;
        }
        if (res.status >= 400 && res.status < 500) {
          lastFailureMode = "rejected";
          return 1;
        }
        // 5xx is Google's problem, not ours. See the doc comment.
        lastFailureMode = null;
        return 0;
      } catch {
        // Timeout or transport failure: unknown, not dead.
        lastFailureMode = null;
        return 0;
      }
    },
    describe: (r) => {
      if (r.observed === 0) {
        return "the shared OASIS calendar credential is live — founder audits can be booked.";
      }
      if (lastFailureMode === "unconfigured") {
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
