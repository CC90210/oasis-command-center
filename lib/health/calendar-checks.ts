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
 * So this check spends it and proves the target calendar accepts both event
 * creation and cleanup. The token exchange and redacted diagnostics stay in
 * the shared probe module so every surface classifies Google the same way.
 */

import "server-only";
import { systemCalendarConfig } from "@/lib/integrations/google-calendar";
import {
  probeCalendarWriteRoundTrip,
  type GoogleProbeErrorCode,
} from "@/lib/integrations/google-token-probe";
import type { DripCheck } from "./drip-checks";
import { isProductionRuntime } from "./runtime-environment";

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
const INVALID_GRANT = 2;
const INVALID_CLIENT = 3;
const CALENDAR_WRITE_REJECTED = 4;
const CALENDAR_CLEANUP_FAILED = 5;
const CALENDAR_PROBE_UNVERIFIED = 6;
const TOKEN_REJECTED = 7;

function rejectedObservation(code: GoogleProbeErrorCode | null): number {
  if (code === "invalid_grant") return INVALID_GRANT;
  if (code === "invalid_client") return INVALID_CLIENT;
  if (code === "calendar_write_rejected" || code === "calendar_access_rejected") {
    return CALENDAR_WRITE_REJECTED;
  }
  if (code === "calendar_cleanup_failed") return CALENDAR_CLEANUP_FAILED;
  if (code === "calendar_write_unverified" || code === "google_token_response_invalid" || code === null) {
    return CALENDAR_PROBE_UNVERIFIED;
  }
  return TOKEN_REJECTED;
}

export const CALENDAR_CHECKS: DripCheck[] = [
  {
    id: "calendar.workspace_credential_usable",
    severity: "critical",
    // OASIS's booking chain, so CC's lane -- not the SunBiz ops channel every
    // other check in this runner uses. Adon operates SunBiz; nobody there can
    // action a dead OASIS workspace credential, and an alert in the wrong room
    // is one nobody acts on.
    lane: "operator",
    rule: { kind: "must_be_zero" },
    observe: async () => {
      // Only production is doctrine-bound to hold a working workspace
      // credential. Previews and local dev legitimately run without one, and
      // grading those would be a standing false alarm that gets the whole
      // channel muted — the same reasoning as deploy.prod_serves_main.
      if (!isProductionRuntime()) return OK;

      const config = systemCalendarConfig();
      // Not a degraded state: with no workspace credential, EVERY host whose
      // personal Google is missing, wrong-scoped or revoked is unbookable, and
      // the fallback that exists to cover them cannot run at all.
      if (!config) return UNCONFIGURED;

      const result = await probeCalendarWriteRoundTrip({
        refreshToken: config.refreshToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        calendarId: config.calendarId,
        attendeeEmail: config.organizerEmail,
      });
      // This check makes a positive booking-readiness claim. Anything short of
      // a confirmed create/delete round trip is therefore non-green; an
      // upstream timeout is uncertainty, not evidence that booking works.
      return result.verdict === "live" ? OK : rejectedObservation(result.errorCode);
    },
    describe: (r) => {
      if (r.observed === OK) {
        return "the shared OASIS calendar is live — its create/Meet/delete check passed and founder audits can be booked.";
      }
      if (r.observed === UNCONFIGURED) {
        return (
          "THE SHARED OASIS CALENDAR IS NOT CONFIGURED — GOOGLE_SYSTEM_CALENDAR_CLIENT_ID, " +
          "_CLIENT_SECRET and _REFRESH_TOKEN must all be set in the production runtime. " +
          "Until they are, any host without a working personal Google connection cannot be " +
          "booked at all, because the fallback that covers them has nothing to run on."
        );
      }
      if (r.observed === INVALID_GRANT) {
        return (
          "THE SHARED OASIS CALENDAR CREDENTIAL WAS REJECTED BY GOOGLE [invalid_grant] — " +
          "nobody can book a founder audit through the shared calendar right now. Asking a " +
          "host to reconnect will NOT fix this: it is the workspace credential, not theirs. " +
          "An administrator must mint a new refresh credential with Calendar scope for " +
          "GOOGLE_SYSTEM_CALENDAR_ADDRESS using the SAME OAuth client named by " +
          "GOOGLE_SYSTEM_CALENDAR_CLIENT_ID. Verify with scripts/verify-workspace-calendar-live.ts."
        );
      }
      if (r.observed === INVALID_CLIENT) {
        return (
          "THE SHARED OASIS CALENDAR CREDENTIAL WAS REJECTED BY GOOGLE [invalid_client] — " +
          "the configured OAuth client ID/secret cannot spend this refresh credential. Pair " +
          "GOOGLE_SYSTEM_CALENDAR_CLIENT_ID and _CLIENT_SECRET with the SAME OAuth client that " +
          "minted GOOGLE_SYSTEM_CALENDAR_REFRESH_TOKEN; rotating only the token or reconnecting " +
          "a host will not repair a mismatched client pair."
        );
      }
      if (r.observed === CALENDAR_WRITE_REJECTED) {
        return (
          "THE SHARED OASIS CALENDAR WRITE CHECK FAILED [calendar_write_rejected] — the refresh " +
          "grant worked, but Google denied creating an event on the target calendar. Grant Calendar " +
          "events write scope and confirm GOOGLE_SYSTEM_CALENDAR_ADDRESS can edit " +
          "GOOGLE_SYSTEM_CALENDAR_ID before attempting another booking."
        );
      }
      if (r.observed === CALENDAR_CLEANUP_FAILED) {
        return (
          "THE SHARED OASIS CALENDAR CLEANUP CHECK FAILED [calendar_cleanup_failed] — the probe " +
          "could not confirm its private synthetic event was removed. Booking readiness is blocked " +
          "until Google accepts event deletion; inspect the target calendar for an OASIS calendar " +
          "readiness check event and verify Calendar events write scope."
        );
      }
      if (r.observed === CALENDAR_PROBE_UNVERIFIED) {
        return (
          "THE SHARED OASIS CALENDAR COULD NOT BE VERIFIED [calendar_write_unverified] — Google " +
          "did not complete the create/delete proof, so the system will not claim bookings are ready. " +
          "The monitor will retry on its next scheduled run."
        );
      }
      return (
        "THE SHARED OASIS CALENDAR TOKEN WAS REJECTED [google_token_rejected] — Google returned " +
        "a definitive client error that was not safe or useful to persist verbatim. Verify the " +
        "configured client pair and mint a fresh Calendar-scoped workspace credential."
      );
    },
  },
];
