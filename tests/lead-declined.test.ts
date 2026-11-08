/**
 * lib/booking/lead-declined.ts: did the lead decline the invite, on Google's
 * word? 2026-11-07: a lead declined an audit at 05:11 and was reminded three
 * times, then told "Sorry we missed each other".
 *
 * Run: node --conditions=react-server --import tsx tests/lead-declined.test.ts
 */
import assert from "node:assert/strict";
import { declineCheckForRun, leadDeclinedInvite, type DeclineCheckAppointment } from "../lib/booking/lead-declined";
import type { ReadFounderMeetingResponseInput } from "../lib/integrations/google-calendar";

const BOOKED: DeclineCheckAppointment = {
  id: "appt-1",
  tenant_id: "ef8d389e-3f15-43f2-ae00-3660f69a1452",
  assigned_to: "host-cc",
  google_event_id: `oasis${"ab".repeat(32)}`,
  organizer_email_snapshot: "conaugh@oasisai.work",
  client_email_snapshot: "robin@example.com",
};

async function main() {
  const asked: ReadFounderMeetingResponseInput[] = [];
  const answers = async (input: ReadFounderMeetingResponseInput) => {
    asked.push(input);
    return "declined" as const;
  };
  assert.equal(await leadDeclinedInvite(BOOKED, answers), true);
  assert.deepEqual(asked[0], {
    tenantId: BOOKED.tenant_id,
    hostUserId: "host-cc",
    eventId: BOOKED.google_event_id,
    expectedOrganizerEmail: "conaugh@oasisai.work",
    attendeeEmail: "robin@example.com",
  }, "the lead's own address is the one read");

  for (const answer of ["accepted", "tentative", "needsAction", "missing"] as const) {
    assert.equal(await leadDeclinedInvite(BOOKED, async () => answer), false, answer);
  }

  // Fails open: an unreadable answer never stops a reminder that would have gone.
  const quiet = console.warn;
  console.warn = () => undefined;
  try {
    assert.equal(await leadDeclinedInvite(BOOKED, async () => { throw new Error("calendar_read_failed"); }), false);
  } finally {
    console.warn = quiet;
  }

  // A slow Google never holds up the reminder run: past the budget it reads "not declined".
  console.warn = () => undefined;
  try {
    const started = Date.now();
    const never = () => new Promise<"declined">(() => undefined);
    assert.equal(await leadDeclinedInvite(BOOKED, never, 30), false);
    assert.ok(Date.now() - started < 1_000, "answered within its budget, not Google's 15 s");
    const late = () => new Promise<"declined">((resolve) => setTimeout(() => resolve("declined"), 200));
    assert.equal(await leadDeclinedInvite(BOOKED, late, 20), false, "a late 'declined' is not waited for");
    assert.equal(await leadDeclinedInvite(BOOKED, late, 2_000), true, "inside the budget it counts");
  } finally {
    console.warn = quiet;
  }

  // Nothing to read: no Google call at all.
  let reads = 0;
  const counting = async () => {
    reads += 1;
    return "declined" as const;
  };
  for (const missing of ["google_event_id", "assigned_to", "organizer_email_snapshot", "client_email_snapshot"] as const) {
    assert.equal(await leadDeclinedInvite({ ...BOOKED, [missing]: null }, counting), false, missing);
  }
  assert.equal(reads, 0);

  // One read per meeting per run, however many of its rows fall due together.
  const check = declineCheckForRun(counting);
  assert.equal(await check(BOOKED), true);
  assert.equal(await check({ ...BOOKED }), true);
  assert.equal(reads, 1, "the second row of the same meeting reuses the answer");
  assert.equal(await check({ ...BOOKED, id: "appt-2" }), true);
  assert.equal(reads, 2, "another meeting is its own read");
  assert.equal(await declineCheckForRun(counting)(BOOKED), true);
  assert.equal(reads, 3, "a new run asks Google again: the lead may have changed their answer");

  console.log("lead-declined: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
