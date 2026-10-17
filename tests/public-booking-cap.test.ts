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
  PUBLIC_BOOKING_DAILY_CAP,
  publicBookingCapDay,
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

async function main() {
  console.log("public booking daily cap");
  const file = join(mkdtempSync(join(tmpdir(), "booking-cap-")), "test.db");
  const db = createClient({ url: `file:${file}` });
  await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__228_public_booking_daily_cap.sql"), "utf8"));
  const now = new Date("2026-10-16T15:00:00.000Z");
  const key = publicBookingVisitorKey("203.0.113.7");

  await check("three calls a day per visitor, then a refusal", async () => {
    assert.equal(PUBLIC_BOOKING_DAILY_CAP, 3);
    for (let i = 1; i <= 3; i += 1) {
      const claim = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: key, now });
      assert.equal(claim.ok, true, `call ${i} refused`);
      if (claim.ok) assert.equal(claim.count, i);
    }
    const fourth = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: key, now });
    assert.deepEqual(fourth, { ok: false, reason: "daily_cap_reached" });
  });

  await check("a booking that did not complete gives its place back, never below zero", async () => {
    const day = publicBookingCapDay(now);
    await releasePublicBooking(db, { ok: true, tenantId: OASIS, visitorKey: key, day, count: 3 }, now);
    const again = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: key, now });
    assert.equal(again.ok, true, "a released place could not be taken again");
    const fresh = publicBookingVisitorKey("198.51.100.1");
    for (let i = 0; i < 3; i += 1) await releasePublicBooking(db, { ok: true, tenantId: OASIS, visitorKey: fresh, day, count: 0 }, now);
    const rows = await db.execute({ sql: "SELECT count(*) AS n FROM public_booking_daily_claims WHERE visitor_key = ?", args: [fresh] });
    assert.equal(Number(rows.rows[0].n), 0, "a release with nothing claimed made a row");
    const once = publicBookingVisitorKey("198.51.100.2");
    const claimed = await claimPublicBooking(db, { tenantId: OASIS, visitorKey: once, now });
    assert.ok(claimed.ok);
    if (claimed.ok) {
      await releasePublicBooking(db, claimed, now);
      await releasePublicBooking(db, claimed, now);
    }
    const left = await db.execute({ sql: "SELECT count FROM public_booking_daily_claims WHERE visitor_key = ?", args: [once] });
    assert.equal(Number(left.rows[0].count), 0, "a double release went below zero (a free extra place)");
  });

  await check("racing requests from two connections can never take more than the cap", async () => {
    const racer = publicBookingVisitorKey("192.0.2.55");
    const a = createClient({ url: `file:${file}` });
    const b = createClient({ url: `file:${file}` });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimPublicBooking(i % 2 ? a : b, { tenantId: OASIS, visitorKey: racer, now })),
    );
    assert.equal(results.filter((r) => r.ok).length, 3, "a count-then-book race let extra calls through");
    a.close();
    b.close();
  });

  await check("each visitor, workspace and day has its own places", async () => {
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: publicBookingVisitorKey("203.0.113.8"), now })).ok, true);
    assert.equal((await claimPublicBooking(db, { tenantId: OTHER, visitorKey: key, now })).ok, true, "another workspace shared OASIS's cap");
    const tomorrow = new Date(now.getTime() + 86_400_000);
    assert.equal((await claimPublicBooking(db, { tenantId: OASIS, visitorKey: key, now: tomorrow })).ok, true, "yesterday's places carried over");
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
      sql: "INSERT INTO public_booking_daily_claims (tenant_id, visitor_key, day, count, updated_at) VALUES (?, 'old', '2026-10-01', 2, ?)",
      args: [OASIS, now.toISOString()],
    });
    await claimPublicBooking(db, { tenantId: OASIS, visitorKey: publicBookingVisitorKey("203.0.113.9"), now });
    const old = await db.execute({ sql: "SELECT count(*) AS n FROM public_booking_daily_claims WHERE visitor_key = 'old'", args: [] });
    assert.equal(Number(old.rows[0].n), 0);
  });

  await check("the booking route claims after the slot check, before Google, and gives back only what never booked", () => {
    const route = readFileSync(join(ROOT, "app", "api", "forms", "booking", "route.ts"), "utf8").replace(/\r\n/g, "\n");
    const claimAt = route.indexOf("const claimed = await claimPublicBooking(getTursoClient(), {");
    assert.ok(claimAt > route.indexOf('return NextResponse.json({ ok: false, error: "slot_unavailable" }, { status: 409 });'), "the claim comes before the slot is known");
    assert.ok(claimAt < route.indexOf("meeting = await createVerifiedFounderMeeting({"), "Google is reached before the claim");
    assert.ok(claimAt > route.indexOf("if (priorAppointment && priorRequest === requestId) {"), "a replay of a booking already made claims a place");
    assert.match(route, /visitorKey: publicBookingVisitorKey\(getClientIp\(req\)\),/);
    assert.match(route, /if \(!claimed\.ok\) \{\s*return NextResponse\.json\(\{ ok: false, error: "daily_booking_limit" \}, \{ status: 429 \}\);/);
    assert.match(route, /console\.error\("\[public-booking\.cap\] claim failed", error\);\s*return NextResponse\.json\(\{ ok: false, error: "availability_unavailable" \}, \{ status: 503 \}\);/, "a claim the database cannot answer books uncapped");
    // Given back only when nothing was booked.
    assert.match(route, /if \(CONTACT_ERRORS\.has\(errorCode\)\) \{[\s\S]{0,200}await giveBackClaim\(\);\s*return/);
    assert.match(route, /founder_slot_overlap\)\/iu\.test\(error\.message\)\) \{\s*await giveBackClaim\(\);/);
    assert.match(route, /errorCode === "booking_request_cancelled"\) \{\s*await giveBackClaim\(\);/);
    assert.match(route, /if \(!meeting\) \{[\s\S]{0,200}await giveBackClaim\(\);/);
    assert.match(route, /if \(compensated\) await giveBackClaim\(\);/, "a booking left standing gave its place back");
    assert.equal(route.match(/await giveBackClaim\(\)/g)?.length, 5, "a give-back in an unexpected place");
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
