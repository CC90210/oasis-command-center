import assert from "node:assert/strict";
import { declineCheckForRun, readInviteDecision, type DeclineCheckAppointment, type InviteStore, type InviteObservation } from "../lib/booking/lead-declined";

const BOOKED: DeclineCheckAppointment = { id: "appt-1", tenant_id: "synthetic-tenant", revision: 1,
  assigned_to: "host-1", google_event_id: "event-1", organizer_email_snapshot: "operator@example.com", client_email_snapshot: "guest@example.com" };
function memoryStore(): InviteStore {
  const rows = new Map<string, InviteObservation>();
  const key = (a: DeclineCheckAppointment) => JSON.stringify([a.tenant_id, a.id, a.revision, a.google_event_id]);
  return { read: async (a) => rows.get(key(a)) ?? null, write: async (a, value) => { rows.set(key(a), value); } };
}

async function main() {
  let clock = Date.parse("2026-11-08T12:00:00Z");
  const store = memoryStore();
  const now = () => clock;
  const declined = await readInviteDecision(BOOKED, { store, now, read: async (input) => {
    assert.equal(input.attendeeEmail, "guest@example.com"); assert.equal(input.tenantId, BOOKED.tenant_id);
    return "declined";
  } });
  assert.equal(declined.status, "declined");
  clock += 1000;
  const unavailable = async () => { throw new Error("synthetic provider outage"); };
  const held = await readInviteDecision(BOOKED, { store, now, read: unavailable });
  assert.equal(held.status, "declined", "a confirmed decline survives provider outage");
  assert.equal(held.retryAt, new Date(clock + 60_000).toISOString());
  let reads = 0;
  assert.equal((await readInviteDecision(BOOKED, { store, now, read: async () => { reads++; return "accepted"; } })).status, "declined");
  assert.equal(reads, 0, "durable retry deadline prevents hot looping");
  clock += 60_000;
  assert.equal((await readInviteDecision(BOOKED, { store, now, read: async () => "accepted" })).status, "not_declined", "verified reacceptance clears the decline");

  const unknownStore = memoryStore();
  for (const delay of [1, 3, 5, 30]) {
    const result = await readInviteDecision(BOOKED, { store: unknownStore, now, read: unavailable });
    assert.equal(result.status, "unknown", "an outage cannot authorize a reminder or no-show");
    assert.equal(Date.parse(result.retryAt!) - clock, delay * 60_000);
    assert.equal(Boolean(result.needsReview), delay === 30);
    clock = Date.parse(result.retryAt!);
  }
  assert.equal((await readInviteDecision(BOOKED, { store: memoryStore(), now, read: async () => "missing" })).status, "unknown");
  assert.equal((await readInviteDecision({ ...BOOKED, google_event_id: null }, { store: memoryStore(), now, read: async () => { throw new Error("must not read"); } })).reason, "rsvp_configuration_missing");

  const independentStore = memoryStore();
  let count = 0;
  const check = declineCheckForRun({ store: independentStore, now, budgetMs: 5, read: async (input) => {
    count++;
    if (input.eventId === "event-1") return new Promise<"declined">(() => undefined);
    return "declined";
  } });
  assert.equal((await check(BOOKED)).status, "unknown");
  assert.equal((await check({ ...BOOKED, id: "appt-2", google_event_id: "event-2" })).status, "declined", "one slow event cannot poison another meeting");
  await check({ ...BOOKED, id: "appt-2", google_event_id: "event-2" });
  assert.equal(count, 2, "one provider read per meeting revision per pass");
  await check({ ...BOOKED, id: "appt-2", google_event_id: "event-2", revision: 2 });
  await check({ ...BOOKED, id: "appt-2", google_event_id: "event-2", tenant_id: "other-tenant" });
  assert.equal(count, 4, "tenant and revision are separate observations");

  const unavailableStore: InviteStore = { read: async () => { throw new Error("db down"); }, write: async () => undefined };
  assert.equal((await readInviteDecision(BOOKED, { store: unavailableStore, now })).reason, "rsvp_state_unavailable");
  const superseded: InviteStore = { read: async () => null, write: async () => { throw new Error("newer declined observation won"); } };
  assert.equal((await readInviteDecision(BOOKED, { store: superseded, now, read: async () => "accepted" })).status, "unknown", "a superseded observation cannot authorize sending");
  const staleDecline: InviteStore = { read: async () => ({ response: "declined", observedAt: new Date(clock - 1000).toISOString(), failures: 0, retryAt: null }),
    write: async () => { throw new Error("newer acceptance won the CAS"); } };
  assert.equal((await readInviteDecision(BOOKED, { store: staleDecline, now, read: unavailable })).status, "unknown", "a superseded cached decline cannot authorize decline/rebook messages");
  console.log("lead-declined: OK (durable tri-state, isolation, 1/3/5 retry, tenant/revision scope)");
}
main().catch((error) => { console.error(error); process.exit(1); });
