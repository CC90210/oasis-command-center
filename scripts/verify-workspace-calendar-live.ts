/**
 * verify-workspace-calendar-live — book a real founder audit through the
 * calendar adapter, against the REAL Google Calendar API, using the same
 * workspace credentials that are set in Vercel production.
 *
 * ═══ WHAT THIS PROVES, AND WHAT IT DOES NOT ════════════════════════════════
 *
 * PROVES: the workspace credential is spendable, with the client it is paired
 * with; the adapter creates an event, provisions a Meet link, attaches the
 * attendee list, and cancels cleanly. Every previous check either inspected the
 * SHAPE of a credential -- which is what "presence is not validity" kept
 * getting wrong -- or stubbed Google out entirely. This spends it.
 *
 * DOES NOT PROVE that a rep can book. It calls createGoogleFounderMeeting
 * directly and stubs getBundle/setValue, so it never touches the HTTP route
 * (POST /api/website-sales/[leadId]), session auth, tenant scoping, the
 * createVerifiedFounderMeeting saga, or any database write. A green run here
 * with a broken route is entirely possible.
 *
 * That distinction is the whole reason this file exists, so do not quietly
 * widen the claim: a check that asserts more than it verifies is the exact
 * defect that put a green "Ready to book" banner over a dead credential twice
 * (#322, #331). For the rep journey, drive the UI or read a real booking's
 * calendar receipt off tenant_records.
 *
 * It forces the WORKSPACE FALLBACK specifically: getBundle returns an empty
 * bundle, so the host has no personal connection and the shared OASIS calendar
 * identity has to carry the booking on its own.
 *
 * Every attendee is the OASIS operator address, so a verification run never
 * emails a prospect. Run:
 *
 *   node --conditions=react-server --import tsx scripts/verify-workspace-calendar-live.ts
 *
 * Requires GOOGLE_SYSTEM_CALENDAR_* in the environment. Exits non-zero on any
 * failure, and always attempts to cancel the event it created.
 */
import {
  createGoogleFounderMeeting,
  cancelGoogleFounderMeeting,
  systemCalendarConfig,
  GoogleCalendarIntegrationError,
  type GoogleCalendarDependencies,
} from "../lib/integrations/google-calendar";

const OPERATOR = (process.env.GOOGLE_SYSTEM_CALENDAR_ADDRESS || "conaugh@oasisai.work").toLowerCase();
const TENANT = "verify-tenant";
const HOST = "verify-host";
/**
 * UNIQUE PER RUN, DELIBERATELY.
 *
 * The event id is derived deterministically from this, and Google KEEPS a
 * cancelled event at its id. So a fixed value works exactly once: the second
 * run's insert 409s, the adapter reconciles by reading the existing event,
 * finds it `cancelled`, and fails `event_not_active` -- a green gate that turns
 * permanently red the moment you use it twice, reporting a fault in the
 * booking chain when the only thing wrong is the gate's own bookkeeping.
 *
 * VERIFY_RUN_ID pins it when a run needs to be reproducible; otherwise every
 * invocation gets its own slot and this stays runnable on demand, forever.
 */
const REQUEST_ID = `workspace-calendar-verify-${
  process.env.VERIFY_RUN_ID || new Date().toISOString().replace(/[^0-9]/gu, "")
}`;

function fail(message: string): never {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const config = systemCalendarConfig();
  if (!config) {
    fail(
      "systemCalendarConfig() is null — GOOGLE_SYSTEM_CALENDAR_CLIENT_ID / _CLIENT_SECRET / " +
        "_REFRESH_TOKEN must all be set. This is the exact state in which the booking button " +
        "has nothing to fall back to.",
    );
  }
  console.log(`[1] workspace config resolved`);
  console.log(`      organizer  : ${config.organizerEmail || "(unset)"}`);
  console.log(`      calendarId : ${config.calendarId}`);
  console.log(`      client     : ${config.clientId.split("-")[0]} (project number)`);

  // An EMPTY bundle: the host has no personal Google connection at all, so the
  // workspace identity is the only thing that can book. That is the path the
  // whole fallback exists for and the one that was dying in production.
  const overrides = {
    getBundle: async () => ({}) as Record<string, string>,
    // Never persist during a verification run. Returns the real result shape
    // rather than void, so this stays honest against the dependency contract.
    setValue: async () => ({ ok: true as const, id: "verification-noop" }),
  } satisfies Partial<GoogleCalendarDependencies>;

  // 09:00 UTC three days out — a real future slot, cancelled moments later.
  const meetingAt = new Date(Date.now() + 3 * 86_400_000);
  meetingAt.setUTCHours(9, 0, 0, 0);

  console.log(`[2] booking as the workspace identity (host has NO personal connection)…`);
  const receipt = await createGoogleFounderMeeting(
    {
      tenantId: TENANT,
      hostUserId: HOST,
      expectedOrganizerEmail: OPERATOR,
      requestId: REQUEST_ID,
      meetingAt: meetingAt.toISOString(),
      timezone: "America/Toronto",
      durationMinutes: 15,
      clientEmail: OPERATOR,
      clientName: "Workspace Calendar Verification",
      company: "OASIS internal verification",
      clientAgenda: "Automated verification of the OASIS booking chain. Safe to ignore.",
    },
    overrides,
  );

  console.log(`[3] booked`);
  console.log(`      eventId   : ${receipt.eventId}`);
  console.log(`      organizer : ${receipt.organizerEmail}`);
  console.log(`      meet      : ${receipt.meetLink}`);
  console.log(`      calendar  : ${receipt.calendarId}`);

  const problems: string[] = [];
  if (!receipt.meetLink.includes("meet.google.com")) problems.push("no Google Meet link was provisioned");
  if (!receipt.htmlLink) problems.push("no htmlLink on the receipt");
  if (!receipt.iCalUID) problems.push("no iCalUID on the receipt");
  if (receipt.organizerEmail.toLowerCase() !== OPERATOR) {
    problems.push(
      `organizer is ${receipt.organizerEmail}, expected ${OPERATOR} — ` +
        "GOOGLE_SYSTEM_CALENDAR_ADDRESS must match the account that owns the refresh credential, " +
        "or the booking's identity assertion rejects Google's echoed organizer attendee",
    );
  }

  console.log(`[4] cancelling the verification event…`);
  try {
    await cancelGoogleFounderMeeting(
      {
        tenantId: TENANT,
        hostUserId: HOST,
        expectedOrganizerEmail: OPERATOR,
        eventId: receipt.eventId,
      } as Parameters<typeof cancelGoogleFounderMeeting>[0],
      overrides,
    );
    console.log(`      cancelled`);
  } catch (error) {
    // Cleanup failure is worth reporting but must not mask a successful booking.
    console.log(`      cleanup failed (remove ${receipt.eventId} by hand): ${String(error)}`);
  }

  if (problems.length) fail(problems.join("\n      "));
  console.log(`\nPASS — the workspace calendar booked, provisioned Meet, and invited attendees.`);
}

main().catch((error) => {
  if (error instanceof GoogleCalendarIntegrationError) {
    console.error(`\nFAIL: [${error.code}] ${error.message}`);
    if (error.code === "workspace_calendar_token_invalid") {
      console.error(
        "      The shared workspace credential was rejected. A host reconnecting will NOT help — " +
          "an administrator must mint a workspace credential with Calendar scope.",
      );
    }
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
