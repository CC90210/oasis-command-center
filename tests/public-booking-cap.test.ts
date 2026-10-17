/**
 * A daily cap per visitor on public bookings (lib/forms/public-booking-cap.ts,
 * migration bravo__228). Since #667 a real Google slot (an invite to CC) can
 * be taken after the contact step alone; the booking POST's own rate limit is
 * in memory per isolate and never caps a day.
 *
 * Real SQL on a throwaway libSQL file with the real migration applied.
 *
 * Run: node --conditions=react-server --import tsx tests/public-booking-cap.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  claimPublicBooking,
  confirmPublicBooking,
  PUBLIC_BOOKING_DAILY_CAP,
  publicBookingVisitorKey,
  releasePublicBooking,
} from "../lib/forms/public-booking-cap";

async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`  ok - ${name}`);
}

const ROOT = join(__dirname, "..");
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "aaaaaaaa-0000-4000-8000-00000000000a";
let seq = 0;
const req = () => `00000000-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`;

async function main() {
  console.log("public booking daily cap");
  const file = join(mkdtempSync(join(tmpdir(), "booking-cap-")), "test.db");
  const db = createClient({ url: `file:${file}` });
  await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__228_public_booking_daily_cap.sql"), "utf8"));
  const now = new Date("2026-10-16T15:00:00.000Z");
  const key = publicBookingVisitorKey("203.0.113.7");
  const held = async (visitorKey: string) =>
    Number((await db.execute({ sql: "SELECT count(*) AS n FROM public_booking_claims WHERE visitor_key = ?", args: [visitorKey] })).rows[0].n);

  await check("three calls a day per visitor, then a refusal", async () => {
    assert.equal(PUBLIC_BOOKING_DAILY_CAP, 3);
    for (let i = 1; i <= 3; i += 1) {
      const claim = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: key, requestId: req(), now });
      assert.equal(claim.ok && claim.fresh, true, `call ${i} refused`);
    }
    const fourth = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: key, requestId: req(), now });
    assert.deepEqual(fourth, { ok: false, reason: "daily_cap_reached" });
  });

  await check("a retry of the same booking request counts once, even at the cap (Codex review of #670)", async () => {
    const visitor = publicBookingVisitorKey("198.51.100.10");
    const first = req();
    const took = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: first, now });
    assert.ok(took.ok && took.fresh && took.requestId === first);
    for (let i = 0; i < 3; i += 1) {
      const retry = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: first, now });
      assert.ok(retry.ok && !retry.fresh && retry.requestId === first, "a retry was refused or counted again");
    }
    assert.equal(await held(visitor), 1);
    // The cap is still 3 distinct bookings: two more fit.
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: req(), now })).ok, true);
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: req(), now })).ok, true);
    // And a retry of a booking at the cap still passes.
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: first, now })).ok, true);
  });

  await check("only the attempt that took the place gives it back", async () => {
    const visitor = publicBookingVisitorKey("198.51.100.11");
    const id = req();
    const fresh = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: id, now });
    const retry = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: id, now });
    assert.ok(fresh.ok && retry.ok);
    if (retry.ok) await releasePublicBooking(db, retry);
    assert.equal(await held(visitor), 1, "a retry's failure freed the place of an attempt still booking");
    if (fresh.ok) await releasePublicBooking(db, fresh);
    assert.equal(await held(visitor), 0, "a booking that never happened kept its place");
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: req(), now })).ok, true);
  });

  await check("a completed booking re-asserts its place after a sibling attempt gave it back (Codex review of #670)", async () => {
    const visitor = publicBookingVisitorKey("198.51.100.12");
    const id = req();
    const first = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: id, now });
    const sibling = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: id, now });
    assert.ok(first.ok && first.fresh && sibling.ok && !sibling.fresh);
    if (first.ok) await releasePublicBooking(db, first); // the first attempt failed before Google
    assert.equal(await held(visitor), 0);
    if (sibling.ok) await confirmPublicBooking(db, sibling, now); // the sibling booked
    assert.equal(await held(visitor), 1, "a booking that completed holds no place");
    if (sibling.ok) await confirmPublicBooking(db, sibling, now);
    assert.equal(await held(visitor), 1, "confirming twice took a second place");
    // So the cap still counts it: two more fit, then a refusal.
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: req(), now })).ok, true);
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: req(), now })).ok, true);
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: visitor, requestId: req(), now })).ok, false);
  });

  await check("a missing claims table books uncapped instead of failing every booking (Codex review of #670)", async () => {
    const bare = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "booking-cap-bare-")), "bare.db")}` });
    const claim = await claimPublicBooking(bare, { tenantId: OASIS, visitorKey: key, requestId: req(), now });
    assert.equal(claim.ok, true, "a missing table refused the booking");
    assert.ok(claim.ok && claim.uncapped && !claim.fresh);
    if (claim.ok) {
      await releasePublicBooking(bare, claim);
      await confirmPublicBooking(bare, claim, now);
    }
    // Any other failure still refuses: a closed client throws, never "uncapped".
    bare.close();
    await assert.rejects(claimPublicBooking(bare, { tenantId: OASIS, visitorKey: key, requestId: req(), now }));
  });

  await check("racing requests from two connections can never take more than the cap; racing retries count once", async () => {
    const racer = publicBookingVisitorKey("192.0.2.55");
    const a = createClient({ url: `file:${file}` });
    const b = createClient({ url: `file:${file}` });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimPublicBooking(i % 2 ? a : b, { tenantId: OASIS, visitorKey: racer, requestId: req(), now })),
    );
    assert.equal(results.filter((r) => r.ok).length, 3, "a count-then-book race let extra calls through");
    const retrier = publicBookingVisitorKey("192.0.2.56");
    const same = req();
    const retries = await Promise.all(
      Array.from({ length: 6 }, (_, i) => claimPublicBooking(i % 2 ? a : b, { tenantId: OASIS, visitorKey: retrier, requestId: same, now })),
    );
    assert.equal(retries.filter((r) => r.ok).length, 6, "a concurrent retry was refused");
    assert.equal(retries.filter((r) => r.ok && r.fresh).length, 1, "concurrent retries took more than one place");
    assert.equal(await held(retrier), 1);
    a.close();
    b.close();
  });

  await check("each visitor, workspace and day has its own places", async () => {
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: publicBookingVisitorKey("203.0.113.8"), requestId: req(), now })).ok, true);
    assert.equal((await claimPublicBooking(db, { tenantId: OTHER, visitorKey: key, requestId: req(), now })).ok, true, "another workspace shared OASIS's cap");
    const tomorrow = new Date(now.getTime() + 86_400_000);
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: key, requestId: req(), now: tomorrow })).ok, true, "yesterday's places carried over");
  });

  await check("no address is one shared key, so it cannot slip past; the address is never stored", async () => {
    assert.equal(publicBookingVisitorKey(null), publicBookingVisitorKey(""));
    assert.equal(publicBookingVisitorKey("  "), publicBookingVisitorKey(undefined));
    assert.equal(publicBookingVisitorKey("unknown"), publicBookingVisitorKey(null));
    assert.notEqual(publicBookingVisitorKey("203.0.113.7"), publicBookingVisitorKey("203.0.113.8"));
    assert.doesNotMatch(publicBookingVisitorKey("203.0.113.7"), /203/, "the address is stored as typed");
  });

  await check("week-old places are pruned by the claim", async () => {
    await db.execute({
      sql: "INSERT INTO public_booking_claims (tenant_id, request_id, visitor_key, day, created_at) VALUES (?, 'old-req', 'old', '2026-10-01', ?)",
      args: [OASIS, now.toISOString()],
    });
    await claimPublicBooking(db, { tenantId: OASIS, visitorKey: publicBookingVisitorKey("203.0.113.9"), requestId: req(), now });
    assert.equal(await held("old"), 0);
  });

  await check("the booking route claims after the slot check, before Google, and gives back only what never booked", () => {
    const route = readFileSync(join(ROOT, "app", "api", "forms", "booking", "route.ts"), "utf8").replace(/\r\n/g, "\n");
    const claimAt = route.indexOf("const claimed = await claimPublicBooking(getTursoClient(), {");
    assert.ok(claimAt > route.indexOf('return NextResponse.json({ ok: false, error: "slot_unavailable" }, { status: 409 });'), "the claim comes before the slot is known");
    assert.ok(claimAt < route.indexOf("meeting = await createVerifiedFounderMeeting({"), "Google is reached before the claim");
    assert.ok(claimAt > route.indexOf("if (priorAppointment && priorRequest === requestId) {"), "a replay of a booking already made claims a place");
    assert.match(route, /visitorKey: publicBookingVisitorKey\(getClientIp\(req\)\),\s*requestId,/, "the claim is not keyed by the booking request");
    assert.match(route, /if \(!claimed\.ok\) \{\s*return NextResponse\.json\(\{ ok: false, error: "daily_booking_limit" \}, \{ status: 429 \}\);/);
    assert.match(route, /console\.error\("\[public-booking\.cap\] claim failed", error\);\s*return NextResponse\.json\(\{ ok: false, error: "availability_unavailable" \}, \{ status: 503 \}\);/, "a claim the database cannot answer books uncapped");
    // Given back only when nothing was booked.
    assert.match(route, /if \(CONTACT_ERRORS\.has\(errorCode\)\) \{[\s\S]{0,200}await giveBackClaim\(\);\s*return/);
    assert.match(route, /founder_slot_overlap\)\/iu\.test\(error\.message\)\) \{\s*await giveBackClaim\(\);/);
    assert.match(route, /errorCode === "booking_request_cancelled"\) \{\s*await giveBackClaim\(\);/);
    assert.match(route, /if \(PRE_PROVIDER_ERRORS\.has\(errorCode\)\) await giveBackClaim\(\);/, "a failure before Google kept its place (Codex review of #670)");
    assert.match(route, /if \(!meeting\) \{[\s\S]{0,200}await giveBackClaim\(\);/);
    assert.match(route, /if \(compensated\) await giveBackClaim\(\);/, "a booking left standing gave its place back");
    // Re-asserted once the booking is recorded on the lead, before anything else.
    assert.equal(route.match(/await confirmPublicBooking\(getTursoClient\(\), claim, new Date\(\)\);/g)?.length, 1);
    const confirmAt = route.indexOf("await confirmPublicBooking(");
    assert.ok(confirmAt > route.indexOf("if (transition.error || transitionData?.ok === false) {"), "confirmed before the booking was recorded");
    assert.ok(confirmAt < route.indexOf("await activateVerifiedFounderMeeting(context.tenantId, meeting.appointmentId);"));
    assert.equal(route.match(/await giveBackClaim\(\)/g)?.length, 6, "a give-back in an unexpected place");
    // The pre-Google list names only codes the meeting service really throws
    // before its Google call, and never an in-flight or shared-request one.
    const service = readFileSync(join(ROOT, "lib", "website-sales-founder-meeting.ts"), "utf8");
    const meeting = readFileSync(join(ROOT, "lib", "website-sales-meeting.ts"), "utf8");
    const list = route.slice(route.indexOf("const PRE_PROVIDER_ERRORS = new Set(["), route.indexOf("]);", route.indexOf("const PRE_PROVIDER_ERRORS")));
    const codes = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(codes.length >= 10, "the pre-Google list is gone");
    for (const code of codes) assert.ok(service.includes(code) || meeting.includes(code), `"${code}" is not thrown by the meeting service`);
    for (const never of ["meeting_transition_pending", "booking_request_mismatch", "meeting_booking_conflict", "calendar_create_failed"]) {
      assert.ok(!codes.includes(never), `"${never}" may leave a booking or belong to another attempt`);
    }
    const createAt = service.indexOf("providerReceipt = await deps.createCalendar(calendarInput);");
    const fnAt = service.indexOf("export async function createVerifiedFounderMeeting(");
    for (const code of ["meeting_intent_insert_failed", "meeting_must_be_in_future", "sms_consent_requires_phone"]) {
      const at = service.indexOf(code, fnAt);
      assert.ok(at > fnAt && at < createAt, `"${code}" is no longer thrown before the Google call`);
    }
    const calendar = readFileSync(join(ROOT, "components", "forms", "PublicBookingCalendar.tsx"), "utf8");
    assert.match(calendar, /code === "daily_booking_limit"/, "the visitor sees the bare code");
  });

  db.close();
  console.log("public-booking-cap: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
