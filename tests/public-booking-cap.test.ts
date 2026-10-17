/**
 * A daily cap per visitor on public bookings (lib/forms/public-booking-cap.ts,
 * migrations bravo__228 and bravo__229). Since #667 a real Google slot (an
 * invite to CC) can be taken after the contact step alone; the booking POST's
 * own rate limit is in memory per isolate and never caps a day.
 *
 * Real SQL on a throwaway libSQL file with the real migrations applied.
 *
 * Run: node --conditions=react-server --import tsx tests/public-booking-cap.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import {
  claimPublicBooking,
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
  const migrate = async (client: Client, ...names: string[]) => {
    for (const name of names) await client.executeMultiple(readFileSync(join(ROOT, "database", "turso", name), "utf8"));
  };
  const db = createClient({ url: `file:${file}` });
  await migrate(db, "bravo__228_public_booking_daily_cap.sql", "bravo__229_public_booking_claim_attempts.sql");
  const now = new Date("2026-10-16T15:00:00.000Z");
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const key = publicBookingVisitorKey("203.0.113.7");
  const held = async (visitorKey: string, day?: string) =>
    Number((await db.execute({
      sql: `SELECT count(*) AS n FROM public_booking_claims WHERE visitor_key = ?${day ? " AND day = ?" : ""}`,
      args: day ? [visitorKey, day] : [visitorKey],
    })).rows[0].n);
  const attempts = async (requestId: string) =>
    Number((await db.execute({ sql: "SELECT attempts FROM public_booking_claims WHERE request_id = ?", args: [requestId] })).rows[0]?.attempts ?? 0);
  const claimFor = (visitorKey: string, requestId: string, at = now, client: Client = db) =>
    claimPublicBooking(client, { tenantId: OASIS, visitorKey, requestId, now: at });
  const release = async (claim: Awaited<ReturnType<typeof claimPublicBooking>>, client: Client = db) => {
    assert.ok(claim.ok, "released a refused claim");
    if (claim.ok) await releasePublicBooking(client, claim);
  };

  await check("three calls a day per visitor, then a refusal", async () => {
    assert.equal(PUBLIC_BOOKING_DAILY_CAP, 3);
    for (let i = 1; i <= 3; i += 1) {
      assert.equal((await claimFor(key, req())).ok, true, `call ${i} refused`);
    }
    assert.deepEqual(await claimFor(key, req()), { ok: false, reason: "daily_cap_reached" });
  });

  await check("a retry of the same booking request holds the same place, even at the cap (Codex review of #670)", async () => {
    const visitor = publicBookingVisitorKey("198.51.100.10");
    const first = req();
    const took = await claimFor(visitor, first);
    assert.ok(took.ok && took.requestId === first);
    for (let i = 0; i < 3; i += 1) {
      const retry = await claimFor(visitor, first);
      assert.ok(retry.ok && retry.requestId === first, "a retry was refused");
    }
    assert.equal(await held(visitor), 1, "a retry took a second place");
    assert.equal(await attempts(first), 4);
    // The cap is still 3 distinct bookings: two more fit.
    assert.equal((await claimFor(visitor, req())).ok, true);
    assert.equal((await claimFor(visitor, req())).ok, true);
    // And a retry of a booking at the cap still passes.
    assert.equal((await claimFor(visitor, first)).ok, true);
  });

  await check("the place is freed only once every attempt holding it gave it back", async () => {
    const visitor = publicBookingVisitorKey("198.51.100.11");
    const id = req();
    const first = await claimFor(visitor, id);
    const retry = await claimFor(visitor, id);
    await release(retry);
    assert.equal(await held(visitor), 1, "a retry's failure freed the place of an attempt still booking");
    await release(first);
    assert.equal(await held(visitor), 0, "a booking that never happened kept its place");
    // In the other order too: the first attempt's give-back leaves the retry's hold.
    const id2 = req();
    const a = await claimFor(visitor, id2);
    const b = await claimFor(visitor, id2);
    await release(a);
    assert.equal(await held(visitor), 1, "the first attempt's failure freed the place of a retry still booking");
    await release(b);
    assert.equal(await held(visitor), 0);
    assert.equal((await claimFor(visitor, req())).ok, true);
  });

  await check("a place no attempt holds never counts, even when its delete is late or failed (Codex review of #670)", async () => {
    const visitor = publicBookingVisitorKey("198.51.100.17");
    const stuck = req();
    assert.equal((await claimFor(visitor, stuck)).ok, true);
    // The give-back's decrement landed; its delete did not.
    await db.execute({ sql: "UPDATE public_booking_claims SET attempts = 0 WHERE request_id = ?", args: [stuck] });
    for (let i = 0; i < 3; i += 1) assert.equal((await claimFor(visitor, req())).ok, true, `call ${i + 1} refused: an unheld place counted`);
    // At the cap, a retry of the unheld place is a new booking, so it is refused.
    assert.equal((await claimFor(visitor, stuck)).ok, false, "a retry of an unheld place slipped past the cap");
  });

  await check("a sibling's give-back never frees a place a booking still holds (Codex review of #670)", async () => {
    const visitor = publicBookingVisitorKey("198.51.100.12");
    const id = req();
    const first = await claimFor(visitor, id);
    const sibling = await claimFor(visitor, id); // goes on to book: never released
    assert.ok(first.ok && sibling.ok);
    await release(first); // the first attempt failed before Google
    assert.equal(await held(visitor), 1, "the booking that completed holds no place");
    // So nothing can take its place: two more fit, then a refusal (not a fourth call).
    assert.equal((await claimFor(visitor, req())).ok, true);
    assert.equal((await claimFor(visitor, req())).ok, true);
    assert.equal((await claimFor(visitor, req())).ok, false, "another booking took the place a completed booking holds");
    assert.equal(await held(visitor), 3);
  });

  await check("a retry after the UTC day changed counts against today, under today's limit (Codex review of #670)", async () => {
    const visitor = publicBookingVisitorKey("198.51.100.13");
    const kept = req(); // yesterday's attempt left its place held (an unknown outcome)
    assert.equal((await claimFor(visitor, kept)).ok, true);
    assert.equal((await claimFor(visitor, kept, tomorrow)).ok, true);
    const today = tomorrow.toISOString().slice(0, 10);
    assert.equal(await held(visitor, today), 1, "the retry took none of today's places");
    assert.equal((await claimFor(visitor, req(), tomorrow)).ok, true);
    assert.equal((await claimFor(visitor, req(), tomorrow)).ok, true);
    assert.equal((await claimFor(visitor, req(), tomorrow)).ok, false, "a fourth call fit today");
    // A visitor already at today's cap cannot bring yesterday's request back in.
    const full = publicBookingVisitorKey("198.51.100.14");
    const old = req();
    assert.equal((await claimFor(full, old)).ok, true);
    for (let i = 0; i < 3; i += 1) assert.equal((await claimFor(full, req(), tomorrow)).ok, true);
    assert.equal((await claimFor(full, old, tomorrow)).ok, false, "yesterday's request slipped past today's cap");
    // Retried today from another connection: it counts against the one today's cap checked.
    const moved = publicBookingVisitorKey("198.51.100.15");
    const roaming = req();
    assert.equal((await claimFor(publicBookingVisitorKey("198.51.100.16"), roaming)).ok, true);
    assert.equal((await claimFor(moved, roaming, tomorrow)).ok, true);
    assert.equal(await held(moved, today), 1, "the moved place still counts against yesterday's connection");
  });

  await check("a missing claims table or column books uncapped instead of failing every booking (Codex review of #670)", async () => {
    const bare = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "booking-cap-bare-")), "bare.db")}` });
    const claim = await claimFor(key, req(), now, bare);
    assert.ok(claim.ok && claim.uncapped, "a missing table refused the booking");
    await release(claim, bare);
    // 228 applied, 229 not: the attempts column is missing.
    const half = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "booking-cap-half-")), "half.db")}` });
    await migrate(half, "bravo__228_public_booking_daily_cap.sql");
    const partial = await claimFor(key, req(), now, half);
    assert.ok(partial.ok && partial.uncapped, "a missing column refused the booking");
    half.close();
    // Any other failure still refuses: a closed client throws, never "uncapped".
    bare.close();
    await assert.rejects(claimFor(key, req(), now, bare));
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
    assert.equal(await held(retrier), 1, "concurrent retries took more than one place");
    assert.equal(await attempts(same), 6);
    // Retries racing give-backs of the same request are never refused while
    // the visitor has room (Codex review of #670: a claim that read the place
    // after a sibling freed it said "daily limit").
    const busy = publicBookingVisitorKey("192.0.2.57");
    assert.equal((await claimFor(busy, req())).ok, true);
    assert.equal((await claimFor(busy, req())).ok, true);
    const churn = req();
    let previous = await claimFor(busy, churn);
    for (let i = 0; i < 20; i += 1) {
      const [next] = await Promise.all([claimFor(busy, churn, now, i % 2 ? a : b), release(previous, i % 2 ? b : a)]);
      assert.ok(next.ok, `a retry racing a give-back was refused (round ${i})`);
      previous = next;
    }
    assert.ok((await held(busy)) <= 3);
    a.close();
    b.close();
  });

  await check("each visitor, workspace and day has its own places", async () => {
    assert.equal((await claimFor(publicBookingVisitorKey("203.0.113.8"), req())).ok, true);
    assert.equal((await claimPublicBooking(db, { tenantId: OTHER, visitorKey: key, requestId: req(), now })).ok, true, "another workspace shared OASIS's cap");
    assert.equal((await claimFor(key, req(), tomorrow)).ok, true, "yesterday's places carried over");
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
    assert.match(route, /if \(!meeting && \(PRE_PROVIDER_ERRORS\.has\(errorCode\) \|\| calendarNeverAsked\(error\)\)\) await giveBackClaim\(\);/, "a failure before Google kept its place, or a later step's error gave one back (Codex review of #670)");
    assert.match(route, /if \(!meeting\) \{[\s\S]{0,200}await giveBackClaim\(\);/);
    assert.match(route, /if \(compensated\) await giveBackClaim\(\);/, "a booking left standing gave its place back");
    // Six give-backs, each on a path that returns at once, so no attempt gives back twice.
    assert.equal(route.match(/await giveBackClaim\(\)/g)?.length, 6, "a give-back in an unexpected place");
    for (const at of [...route.matchAll(/await giveBackClaim\(\);/g)].map((m) => m.index ?? 0)) {
      assert.match(route.slice(at, at + 160), /^await giveBackClaim\(\);\s*(?:const code = [^\n]+\s*)?return NextResponse\.json/, "a give-back that does not end the request");
    }
    // The pre-Google list names only codes the meeting service really throws
    // before its Google call, and never an in-flight or shared-request one.
    const service = readFileSync(join(ROOT, "lib", "website-sales-founder-meeting.ts"), "utf8");
    const meeting = readFileSync(join(ROOT, "lib", "website-sales-meeting.ts"), "utf8");
    const list = route.slice(route.indexOf("const PRE_PROVIDER_ERRORS = new Set(["), route.indexOf("]);", route.indexOf("const PRE_PROVIDER_ERRORS")));
    const codes = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(codes.length >= 10, "the pre-Google list is gone");
    for (const code of codes) assert.ok(service.includes(code) || meeting.includes(code), `"${code}" is not thrown by the meeting service`);
    for (const never of ["calendar_create_failed", "meeting_receipt_write_failed", "meeting_notification_insert_failed", "meeting_failure_write_failed"]) {
      assert.ok(!codes.includes(never), `"${never}" may leave a booking`);
    }
    const createAt = service.indexOf("providerReceipt = await deps.createCalendar(calendarInput);");
    const fnAt = service.indexOf("export async function createVerifiedFounderMeeting(");
    for (const code of ["meeting_intent_insert_failed", "meeting_must_be_in_future", "sms_consent_requires_phone"]) {
      const at = service.indexOf(code, fnAt);
      assert.ok(at > fnAt && at < createAt, `"${code}" is no longer thrown before the Google call`);
    }
    // A racing retry's two codes (Codex review of #670): every throw of them in
    // the booking function comes before its Google call, and so does the
    // takeover helper that throws them too.
    const takeoverAt = service.indexOf("async function reserveBookingTakeover(");
    const takeoverEnd = service.indexOf("export async function activateVerifiedFounderMeeting(");
    assert.ok(fnAt < createAt && createAt < takeoverAt && takeoverAt < takeoverEnd, "the meeting service moved");
    const takeoverCall = service.indexOf("await reserveBookingTakeover(", fnAt);
    assert.ok(takeoverCall > fnAt && takeoverCall < createAt, "the takeover runs after the Google call");
    for (const code of ["meeting_transition_pending", "meeting_notification_in_progress"]) {
      assert.ok(codes.includes(code), `a racing retry's "${code}" keeps its hold`);
      const thrown = new RegExp(`throw new Error\\("${code}"\\)`, "g");
      for (const m of service.slice(fnAt, takeoverAt).matchAll(thrown)) {
        assert.ok(fnAt + (m.index ?? 0) < createAt, `"${code}" is thrown after the Google call`);
      }
      assert.ok(thrown.test(service.slice(fnAt, takeoverEnd)), `"${code}" is no longer thrown by the booking`);
    }
    // Every code the booking throws before its Google call (in the function or
    // the takeover it runs first) is handled: given back as pre-Google, a
    // contact refusal, or a cancelled request (Codex review of #670, pass 5).
    const contactList = route.slice(route.indexOf("const CONTACT_ERRORS = new Set(["), route.indexOf("]);", route.indexOf("const CONTACT_ERRORS")));
    const handled = new Set([...codes, ...[...contactList.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]), "booking_request_cancelled"]);
    const preGoogle = service.slice(fnAt, createAt) + service.slice(takeoverAt, takeoverEnd);
    const thrownBefore = [...preGoogle.matchAll(/throw new Error\((?:"([a-z_]+)"|`([a-z_]+)[:`])/g)].map((m) => m[1] || m[2]);
    assert.ok(thrownBefore.length >= 8, "the pre-Google throws are gone");
    for (const code of thrownBefore) assert.ok(handled.has(code), `"${code}" is thrown before Google but keeps its hold`);
    assert.ok(service.indexOf("assertSameRequest(appointment", fnAt) < createAt && codes.includes("booking_request_mismatch"), "a reused request id with a changed booking keeps its hold");
    // A calendar failure in its setup gives back too (Codex review of #670, pass 6),
    // but only for codes the calendar code throws before it can send any request:
    // never in the authorized fetch, the token refresh it reruns on a 401, or the
    // create path once the session is open (lib/integrations/google-calendar.ts).
    const google = readFileSync(join(ROOT, "lib", "integrations", "google-calendar.ts"), "utf8").replace(/\r\n/g, "\n");
    const between = (start: string, end: string) => {
      const from = google.indexOf(start);
      const to = google.indexOf(end, from + start.length);
      assert.ok(from >= 0 && to > from, `google-calendar.ts moved: ${start}`);
      return google.slice(from, to);
    };
    const afterRequestCanGoOut = [
      between("const refresh = async () => {", "const authorizedFetch: AuthorizedCalendarFetch"),
      between("const authorizedFetch: AuthorizedCalendarFetch", "return { dependencies, bundle: sessionBundle, authorizedFetch"),
      between("async function refreshAccessToken(", "\nasync function "),
      between("export async function createFounderMeetingCalendarEvent(", "export async function listGoogleCalendarBusy(")
        .split("await openAuthorizedCalendarSession(")[1] ?? "",
      between("const receipt = await createFounderMeetingCalendarEvent(", "export function updateGoogleFounderMeeting("),
    ];
    assert.ok(afterRequestCanGoOut.every((part) => part.length > 200), "a google-calendar.ts section is empty");
    const setupList = route.slice(route.indexOf("const CALENDAR_SETUP_ERRORS = new Set(["), route.indexOf("]);", route.indexOf("const CALENDAR_SETUP_ERRORS")));
    const setupCodes = [...setupList.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(setupCodes.sort(), ["calendar_organizer_mismatch", "calendar_scope_required", "google_calendar_not_connected", "invalid_request"]);
    for (const code of setupCodes) {
      assert.ok(google.includes(`"${code}"`), `"${code}" is not a calendar code`);
      for (const part of afterRequestCanGoOut) assert.ok(!part.includes(`"${code}"`), `"${code}" can be thrown after a request went out`);
    }
    for (const token of ["token_refresh_failed", "workspace_calendar_token_invalid", "google_oauth_config_missing"]) {
      assert.ok(!setupCodes.includes(token), `"${token}" can come from a refresh in the middle of a call`);
    }
    assert.match(
      route,
      /return cause instanceof GoogleCalendarIntegrationError && !cause\.eventId && CALENDAR_SETUP_ERRORS\.has\(cause\.code\);/,
      "a setup give-back must come from the calendar code itself, with no event behind it",
    );
    // A handoff note over the service's limit would refuse every booking for that lead.
    const serviceMax = service.match(/boundedRequired\(input\.handoffNote, (\d+), "handoff_note_required"\)/)?.[1];
    assert.equal(route.match(/const HANDOFF_NOTE_MAX = (\d+);/)?.[1], serviceMax, "the route's handoff limit is not the service's");
    assert.match(route, /handoffNote: \(bottleneck \|\| `Public \$\{context\.formSlug\} booking\.`\)\.slice\(0, HANDOFF_NOTE_MAX\),/, "a long answer can block a lead's every booking");
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
