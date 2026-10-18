/**
 * The booking agent API (lib/booking/agent-booking.ts, lib/booking/agent-auth.ts): an agent outside the app (the
 * Instagram DM setter) books a founder call on /book's engine. Every dependency is a fake, so each path is driven
 * without Google, Turso or Telegram.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  handleAgentBook,
  handleAgentOffers,
  handleAgentSlots,
  type AgentBookingDeps,
  type AgentLead,
} from "../lib/booking/agent-booking";
import { MEET_RECORDING_NOTICE } from "../lib/meet/recording-notice";
import type { PublicBookingHost, PublicBookingSlot } from "../lib/forms/public-booking";

const SECRET = "s".repeat(40);
const NOW = new Date("2026-10-20T12:00:00.000Z");
const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const SLOT = "2026-10-21T14:00:00.000Z";
const LATER_SLOT = "2026-10-30T14:00:00.000Z";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const MEET = "https://oasisai.work/meet/abc-defg-hjk";

const CC: PublicBookingHost = { userId: "cc", email: "conaugh@oasisai.work", displayName: "CC", role: "organizer", targetCalendarId: "meetings" } as PublicBookingHost;
const ADON: PublicBookingHost = { userId: "adon", email: "adon@oasisai.work", displayName: "Adon", role: "attendee", targetCalendarId: null } as PublicBookingHost;

function signed(path: string, body: unknown, opts: { secret?: string; ts?: number; producer?: string; raw?: string } = {}): Request {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(NOW.getTime() / 1000));
  const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${raw}`).digest("hex");
  return new Request(`https://oasisai.work${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-booking-producer": opts.producer ?? "bea",
      "x-booking-timestamp": ts,
      "x-booking-signature": sig,
    },
    body: raw,
  });
}

type Calls = {
  createLead: Array<Record<string, unknown>>;
  meetings: Array<Record<string, unknown>>;
  mirrors: Array<Record<string, unknown>>;
  rpc: Array<Record<string, unknown>>;
  compensated: string[];
  activated: string[];
  alerts: Array<Record<string, unknown>>;
  readLead: string[];
  findLead: number;
};

function fakeDeps(overrides: Partial<AgentBookingDeps> & { lead?: AgentLead | null; matched?: AgentLead | null; recorded?: boolean; slots?: PublicBookingSlot[] } = {}) {
  const calls: Calls = { createLead: [], meetings: [], mirrors: [], rpc: [], compensated: [], activated: [], alerts: [], readLead: [], findLead: 0 };
  const later: Array<() => Promise<void>> = [];
  const deps: AgentBookingDeps = {
    env: { BOOKING_AGENT_SECRET_BEA: SECRET },
    now: () => NOW,
    db: {
      rpc: async (_name: string, args: Record<string, unknown>) => {
        calls.rpc.push(args);
        return { data: { ok: true }, error: null };
      },
    } as unknown as AgentBookingDeps["db"],
    baseUrl: "https://oasisai.work/",
    availability: async () => overrides.slots ?? [
      { start: SLOT, hosts: [CC, ADON] },
      { start: LATER_SLOT, hosts: [CC] },
    ],
    hostsById: async (_t, ids) => (ids.length ? [CC, ADON].filter((h) => ids.includes(h.userId)) : [CC]),
    liveOffers: async () => [{ slug: "ai-audit", name: "AI Automation Audit" }, { slug: "command", name: "COMMAND" }],
    readLead: async (_t, id) => {
      calls.readLead.push(id);
      return overrides.lead === undefined ? null : overrides.lead;
    },
    findLead: async () => {
      calls.findLead += 1;
      return overrides.matched ?? null;
    },
    createLead: async (_t, data) => {
      calls.createLead.push(data);
      return { id: "new-lead" };
    },
    createMeeting: async (input) => {
      calls.meetings.push(input as unknown as Record<string, unknown>);
      return {
        appointmentId: "appt-1",
        requestId: input.requestId,
        meetingAt: input.meetingAt,
        durationMinutes: 30,
        offerLabel: "discovery call",
        timezone: "America/Toronto",
        contact: {} as never,
        receipt: { calendarId: "primary", eventId: "evt-1", htmlLink: "https://calendar.google.com/e/1", meetLink: MEET, iCalUID: "ical-1", organizerEmail: CC.email } as never,
        revision: 1,
      };
    },
    compensate: async ({ appointmentId }) => {
      calls.compensated.push(appointmentId);
      return true;
    },
    mirror: async (input) => {
      calls.mirrors.push(input as unknown as Record<string, unknown>);
    },
    activate: async (_t, id) => {
      calls.activated.push(id);
    },
    callRecorded: async () => overrides.recorded ?? true,
    alert: async (input) => {
      calls.alerts.push(input as unknown as Record<string, unknown>);
    },
    later: (work) => {
      later.push(work);
    },
    ...overrides,
  };
  return { deps, calls, later };
}

const BOOK = {
  request_id: REQUEST,
  starts_at: SLOT,
  source: "instagram_dm",
  lead_id: null,
  contact: { name: "Taylor Smith", email: "Taylor@Example.com", phone: "+1 514 555 0101", company: "North Star" },
  instagram_handle: "@northstar.dental",
  note: "Wants the DMs answered after hours.",
};

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function testAuth() {
  const { deps } = fakeDeps();
  let res = await handleAgentSlots(signed("/api/internal/booking/slots", {}, { producer: "apex" }), deps);
  assert.equal(res.status, 401, "an unknown producer");
  res = await handleAgentSlots(signed("/api/internal/booking/slots", {}), { ...deps, env: {} });
  assert.equal(res.status, 503);
  assert.deepEqual(await json(res), { ok: false, error: "not_installed", detail: "secret_not_set" });
  res = await handleAgentSlots(signed("/api/internal/booking/slots", {}, { secret: "x".repeat(40) }), deps);
  assert.equal(res.status, 401, "a wrong secret");
  res = await handleAgentSlots(signed("/api/internal/booking/slots", {}, { ts: Math.floor(NOW.getTime() / 1000) - 301 }), deps);
  assert.equal(res.status, 401);
  assert.equal((await json(res)).error, "stale_timestamp");
  res = await handleAgentSlots(signed("/api/internal/booking/slots", null, { raw: "x".repeat(9000) }), deps);
  assert.equal(res.status, 413);
  res = await handleAgentSlots(signed("/api/internal/booking/slots", null, { raw: "{not json" }), deps);
  assert.equal(res.status, 422);
  // A signature over a different body than the one sent is refused.
  const good = signed("/api/internal/booking/slots", {});
  const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: JSON.stringify({ days: 2 }) });
  assert.equal((await handleAgentSlots(tampered, deps)).status, 401);
}

async function testSlotsAndOffers() {
  const { deps } = fakeDeps();
  let res = await handleAgentSlots(signed("/api/internal/booking/slots", { duration_minutes: 30, days: 8 }), deps);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body.slots, [{ start: SLOT, end: "2026-10-21T14:30:00.000Z" }], "a time past `days` is left out");
  assert.equal(body.time_zone, "America/Toronto");
  res = await handleAgentSlots(signed("/api/internal/booking/slots", { tenant_id: "other" }), deps);
  assert.equal(res.status, 422, "a smuggled tenant is refused, never ignored");
  res = await handleAgentSlots(signed("/api/internal/booking/slots", { days: 30 }), deps);
  assert.equal(res.status, 422);
  res = await handleAgentSlots(signed("/api/internal/booking/slots", {}), { ...deps, availability: async () => { throw new Error("calendar_read_failed"); } });
  assert.equal(res.status, 503);

  res = await handleAgentOffers(signed("/api/internal/booking/offers", {}), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), {
    ok: true,
    offers: [
      { slug: "ai-audit", name: "AI Automation Audit", url: "https://oasisai.work/f/oasis-ai-cc/ai-audit" },
      { slug: "command", name: "COMMAND", url: "https://oasisai.work/f/oasis-ai-cc/command" },
    ],
    booking_url: "https://oasisai.work/book",
  });
}

async function testBookNewLead() {
  const { deps, calls, later } = fakeDeps();
  const res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), deps);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.deepEqual(body, {
    ok: true,
    replayed: false,
    lead_id: "new-lead",
    appointment_id: "appt-1",
    starts_at: SLOT,
    ends_at: "2026-10-21T14:30:00.000Z",
    meet_url: MEET,
    calendar_url: "https://calendar.google.com/e/1",
    google_event_id: "evt-1",
    time_zone: "America/Toronto",
    call_recorded: true,
    recording_notice: MEET_RECORDING_NOTICE,
  });
  assert.equal(calls.findLead, 1, "an unnamed lead is matched by email or phone first");
  assert.equal(calls.createLead.length, 1);
  const created = calls.createLead[0];
  assert.equal(created.source, "instagram_dm");
  assert.equal(created.stage, "researched");
  assert.equal(created.email, "taylor@example.com");
  assert.equal(created.instagram_handle, "northstar.dental");
  const meeting = calls.meetings[0];
  assert.equal(meeting.hostUserId, "cc");
  assert.equal(meeting.durationMinutes, 30);
  assert.equal(meeting.smsConsent, false);
  assert.deepEqual(meeting.openerAttendee, { email: ADON.email, displayName: "Adon" }, "the on-duty attendee is invited");
  assert.equal(meeting.handoffNote, BOOK.note);
  assert.equal((meeting.contact as Record<string, unknown>).phone, "+1 514 555 0101");
  assert.equal(calls.mirrors[0].formName, "Instagram DM call");
  assert.deepEqual((calls.mirrors[0].hosts as PublicBookingHost[]).map((h) => h.userId), ["cc", "adon"]);
  const transition = calls.rpc[0];
  assert.equal(transition.p_expected_stage, "researched");
  const patch = transition.p_patch as Record<string, unknown>;
  assert.equal(patch.stage, "founder_meeting_booked");
  assert.equal(patch.google_meet_link, MEET);
  assert.equal(patch.public_booking_request_id, REQUEST);
  assert.equal(patch.booking_source, "instagram_dm");
  assert.match(String(transition.p_content), /from Instagram DM .*Video call: https:\/\/oasisai\.work\/meet\//);
  assert.deepEqual(calls.activated, ["appt-1"]);
  assert.equal(calls.alerts.length, 0, "the alert waits for after()");
  await later[0]();
  assert.equal(calls.alerts[0].note, BOOK.note);
}

async function testBookNamedOrMatchedLead() {
  const named = fakeDeps({ lead: { id: "crm-lead", data: { stage: "qualified", assigned_to: "adon" } } });
  let res = await handleAgentBook(signed("/api/internal/booking/book", { ...BOOK, lead_id: "abcdef12-0000-4000-8000-000000000001" }), named.deps);
  assert.equal(res.status, 200);
  assert.equal((await json(res)).lead_id, "crm-lead");
  assert.equal(named.calls.findLead, 0, "a named lead is used as named");
  assert.equal(named.calls.createLead.length, 0);
  assert.equal(named.calls.rpc[0].p_expected_owner_id, "adon");
  assert.equal((named.calls.rpc[0].p_patch as Record<string, unknown>).assigned_to, "adon", "the lead's owner keeps the deal");

  const matched = fakeDeps({ matched: { id: "form-lead", data: { stage: "researched" } } });
  res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), matched.deps);
  assert.equal((await json(res)).lead_id, "form-lead", "a prospect who filled a form is not split in two");
  assert.equal(matched.calls.createLead.length, 0);
}

async function testBookRefusals() {
  // A time that is not open: refused before any lead or meeting is made.
  const closed = fakeDeps();
  let res = await handleAgentBook(signed("/api/internal/booking/book", { ...BOOK, starts_at: "2026-10-21T15:00:00.000Z" }), closed.deps);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).error, "slot_unavailable");
  assert.equal(closed.calls.createLead.length, 0, "a refused time leaves no lead behind");
  assert.equal(closed.calls.meetings.length, 0);

  // Another booking already on the lead.
  const booked = fakeDeps({ matched: { id: "l", data: { stage: "founder_meeting_booked", calendar_appointment_id: "appt-0", public_booking_request_id: "other" } } });
  res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), booked.deps);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).error, "already_booked");

  // A lead past the founder handoff.
  const lost = fakeDeps({ matched: { id: "l", data: { stage: "lost" } } });
  res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), lost.deps);
  assert.equal((await json(res)).error, "lead_stage_not_bookable");

  // Fields.
  const fields = fakeDeps();
  for (const [body, field] of [
    [{ ...BOOK, contact: { ...BOOK.contact, phone: "" } }, "contact.phone"],
    [{ ...BOOK, contact: { ...BOOK.contact, email: "nope" } }, "contact.email"],
    [{ ...BOOK, source: "website" }, "source"],
    [{ ...BOOK, request_id: "not-a-uuid" }, "request_id"],
    [{ ...BOOK, tenant_id: "x" }, "tenant_id"],
    [{ ...BOOK, instagram_handle: "bad handle!" }, "instagram_handle"],
  ] as const) {
    res = await handleAgentBook(signed("/api/internal/booking/book", body), fields.deps);
    assert.equal(res.status, 422, field);
    assert.equal((await json(res)).field, field);
  }
  assert.equal(fields.calls.meetings.length, 0);

  // The meeting service refuses the contact: a 422 naming it, nothing to undo.
  const phone = fakeDeps({ createMeeting: async () => { throw new Error("invalid_client_phone"); } });
  res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), phone.deps);
  assert.equal(res.status, 422);
  assert.equal((await json(res)).error, "invalid_client_phone");
  assert.deepEqual(phone.calls.compensated, []);
}

async function testBookFailuresCompensate() {
  // The Schedule copy fails after the meeting exists: the meeting is undone.
  const mirror = fakeDeps({ mirror: async () => { throw new Error("public_booking_schedule_write_failed"); } });
  let res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), mirror.deps);
  assert.equal(res.status, 503);
  assert.deepEqual(mirror.calls.compensated, ["appt-1"]);
  assert.equal(mirror.calls.rpc.length, 0, "the lead never moves for a booking that was undone");

  // The pipeline move fails: the meeting is undone and the setter is told to try a new request.
  const transition = fakeDeps();
  transition.deps.db = { rpc: async () => ({ data: { ok: false, error: "stage_changed" }, error: null }) } as unknown as AgentBookingDeps["db"];
  res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), transition.deps);
  assert.equal(res.status, 503);
  assert.equal((await json(res)).error, "retry_required");
  assert.deepEqual(transition.calls.compensated, ["appt-1"]);
  assert.deepEqual(transition.calls.activated, [], "an undone booking is never activated");

  // The slot was taken between the read and the write (the database's overlap guard).
  const raced = fakeDeps({ createMeeting: async () => { throw new Error("meeting_intent_insert_failed: founder_slot_overlap"); } });
  res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), raced.deps);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).error, "slot_unavailable");
}

async function testReplayAndNotice() {
  const replay = fakeDeps({
    matched: {
      id: "l",
      data: {
        stage: "founder_meeting_booked",
        calendar_appointment_id: "appt-1",
        public_booking_request_id: REQUEST,
        founder_meeting_at: SLOT,
        google_meet_link: MEET,
        google_calendar_event_url: "https://calendar.google.com/e/1",
        google_calendar_event_id: "evt-1",
        audit_duration_minutes: 30,
        public_booking_host_ids: ["cc"],
      },
    },
  });
  let res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), replay.deps);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.replayed, true);
  assert.equal(body.meet_url, MEET);
  assert.equal(replay.calls.meetings.length, 0, "a replay never books twice");
  assert.deepEqual((replay.calls.mirrors[0].hosts as PublicBookingHost[]).map((h) => h.userId), ["cc"], "it repairs the copies it first wrote");
  assert.deepEqual(replay.calls.activated, ["appt-1"]);
  res = await handleAgentBook(signed("/api/internal/booking/book", { ...BOOK, starts_at: LATER_SLOT }), replay.deps);
  assert.equal((await json(res)).error, "booking_request_mismatch");

  // A room that does not record (or a Google link) carries no notice.
  const quiet = fakeDeps({ recorded: false });
  res = await handleAgentBook(signed("/api/internal/booking/book", BOOK), quiet.deps);
  const quietBody = await json(res);
  assert.equal(quietBody.call_recorded, false);
  assert.equal(quietBody.recording_notice, null);
}

async function main() {
  await testAuth();
  await testSlotsAndOffers();
  await testBookNewLead();
  await testBookNamedOrMatchedLead();
  await testBookRefusals();
  await testBookFailuresCompensate();
  await testReplayAndNotice();
  console.log("internal-booking-agent: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
