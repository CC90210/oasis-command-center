import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  buildPublicFunnelLeadPatch,
  buildPublicBookingSlots,
  ensurePublicFunnelBookingEvent,
  isPublicFunnelReadyForBooking,
  isPublicBookingSlot,
  publicBookingOwnershipPatch,
  publicBookingAvailabilitySchema,
  publicBookingCreateSchema,
  PUBLIC_BOOKING_DEFAULT_DURATION_MINUTES,
  PUBLIC_BOOKING_TIME_ZONE,
} from "../lib/forms/public-booking";
import {
  isPublicBookingFormSlug,
  publicBookingDurationMinutes,
  publicBookingOfferLabel,
  PUBLIC_BOOKING_FORM_SLUGS,
} from "../lib/forms/public-booking-config";
import { patch_tenant_record_data } from "../lib/turso-rpc-shim";

async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`  ok - ${name}`);
}

console.log("public OASIS funnel booking");

const submitRoute = readFileSync("app/api/forms/submit/route.ts", "utf8");
const bookingRoute = readFileSync("app/api/forms/booking/route.ts", "utf8");
const bookingClient = readFileSync("components/forms/PublicBookingCalendar.tsx", "utf8");

async function main() {
await check("normalizes every CRM field named in the funnel brief", () => {
  assert.deepEqual(
    buildPublicFunnelLeadPatch({
      name: "  Test Lead  ",
      email: " Test@Example.com ",
      phone: " +1 514 555 0101 ",
      company: " Test Co ",
      website: " https://example.com ",
      monthly_revenue: "50k_250k",
      team_size: "6_20",
      bottleneck_detail: " Leads wait too long for a reply. ",
      automation_goal: "sales_leadgen",
      current_tools: " HubSpot and Zapier ",
      budget: " 2k_5k ",
      timeframe: "30_days",
    }, "audit_requested", "2026-10-12T12:00:00.000Z"),
    {
      name: "Test Lead",
      email: "test@example.com",
      phone: "+1 514 555 0101",
      phone_e164: "+15145550101",
      budget: "2k_5k",
      timeframe: "30_days",
      company: "Test Co",
      company_name: "Test Co",
      website: "https://example.com",
      revenue_band: "50k_250k",
      monthly_revenue: "50k_250k",
      team_size: "6_20",
      primary_bottleneck: "Leads wait too long for a reply.",
      current_tools: "HubSpot and Zapier",
      funnel_stage: "audit_requested",
      audit_requested_at: "2026-10-12T12:00:00.000Z",
    },
  );
});

await check("does not reveal booking when the audit_requested write failed", () => {
  assert.match(
    submitRoute,
    /forms\.submit\.public_booking_completion\.failed[\s\S]{0,500}funnel_stage_write_unavailable[\s\S]{0,100}503/,
  );
  assert.equal(isPublicFunnelReadyForBooking({ funnel_stage: "inbound_lead" }), false);
  assert.equal(isPublicFunnelReadyForBooking({ funnel_stage: "audit_requested" }), false);
  assert.equal(isPublicFunnelReadyForBooking({
    funnel_stage: "audit_requested",
    audit_requested_at: "2026-10-12T12:00:00.000Z",
  }), true);
  assert.equal(isPublicFunnelReadyForBooking({
    funnel_stage: "meeting_booked",
    meeting_booked_at: "2026-10-12T13:00:00.000Z",
  }), true);
  assert.match(submitRoute, /funnel_stage_write_unavailable/);
});

await check("keeps funnel lifecycle monotonic across a duplicate final-step patch", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE tenant_records (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, data TEXT, updated_at TEXT
  )`);
  await db.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, data) VALUES (?, ?, ?)",
    args: ["lead-booked", "tenant-a", JSON.stringify({
      funnel_stage: "meeting_booked",
      audit_requested_at: "2026-10-12T12:00:00.000Z",
      meeting_booked_at: "2026-10-12T13:00:00.000Z",
    })],
  });
  const merged = await patch_tenant_record_data(db, {
    p_id: "lead-booked",
    p_tenant_id: "tenant-a",
    p_patch: {
      funnel_stage: "audit_requested",
      audit_requested_at: "2026-10-12T14:00:00.000Z",
      current_tools: "HubSpot",
    },
  }) as Record<string, unknown>;
  assert.equal(merged.funnel_stage, "meeting_booked");
  assert.equal(merged.audit_requested_at, "2026-10-12T12:00:00.000Z");
  assert.equal(merged.meeting_booked_at, "2026-10-12T13:00:00.000Z");
  assert.equal(merged.current_tools, "HubSpot");
  db.close();
});

await check("commits the lead before activation and leaves mirrors available to saga recovery", () => {
  const mirror = bookingRoute.indexOf("await mirrorPublicBookingToSchedules({", bookingRoute.indexOf("meeting = await createVerifiedFounderMeeting"));
  const transition = bookingRoute.indexOf('db.rpc("transition_pipeline_lead"');
  const activate = bookingRoute.indexOf("await activateVerifiedFounderMeeting", transition);
  assert.ok(mirror > 0 && transition > mirror && activate > transition);
  assert.match(bookingRoute, /compensatePendingFounderMeetingBooking/);
  assert.match(bookingRoute, /error: compensated \? "retry_required" : "booking_transition_failed"/);
  assert.match(bookingRoute, /if \(compensated \|\|[\s\S]{0,180}retry_required/);
  assert.match(bookingRoute, /errorCode === "booking_compensated"/);
  assert.match(bookingRoute, /errorCode === "booking_request_cancelled"/);
  assert.match(bookingRoute, /return providerCompensated/);
  assert.match(bookingClient, /data\.error === "retry_required"[\s\S]{0,160}bookingRequest\.current = null/);
});

await check("falls back to the selected automation goal for the bottleneck", () => {
  assert.equal(
    buildPublicFunnelLeadPatch({ automation_goal: "workflow_automation" }, "inbound_lead", "2026-10-12T12:00:00.000Z")
      .primary_bottleneck,
    "workflow_automation",
  );
});

await check("preserves an existing rep owner and collaborators when founders join the booking", () => {
  const founders = {
    host: { auth_user_id: "founder-cc", email: "cc@example.com" },
    opener: { auth_user_id: "founder-adon", email: "adon@example.com" },
  };
  assert.deepEqual(
    publicBookingOwnershipPatch(
      { assigned_to: "rep-owner", collaborators: ["rep-collaborator", "founder-adon"] },
      founders,
    ),
    {
      assigned_to: "rep-owner",
      collaborators: ["rep-collaborator", "founder-adon", "founder-cc"],
    },
  );
  assert.deepEqual(
    publicBookingOwnershipPatch({}, founders),
    { assigned_to: "founder-cc", collaborators: ["founder-adon"] },
  );
});

await check("enables booking only for OASIS forms that promise a founder call", () => {
  assert.deepEqual(PUBLIC_BOOKING_FORM_SLUGS, ["ai-audit", "command", "fleet"]);
  for (const slug of PUBLIC_BOOKING_FORM_SLUGS) assert.equal(isPublicBookingFormSlug(slug), true);
  for (const slug of ["protocol", "community", "vsl", "support", "start"]) {
    assert.equal(isPublicBookingFormSlug(slug), false, `${slug} must not force a sales call`);
  }
  assert.equal(publicBookingDurationMinutes("ai-audit"), 15);
  assert.equal(publicBookingDurationMinutes("command"), 45);
  assert.equal(publicBookingDurationMinutes("fleet"), 45);
});

await check("keeps public offer names explicit instead of inferring them from duration", () => {
  assert.equal(publicBookingOfferLabel("ai-audit"), "AI automation audit");
  assert.equal(publicBookingOfferLabel("command"), "COMMAND discovery call");
  assert.equal(publicBookingOfferLabel("fleet"), "FLEET discovery call");
  assert.match(bookingRoute, /offerLabel: publicBookingOfferLabel|const offerLabel = publicBookingOfferLabel/);
});

await check("normalizes the COMMAND offer's leak fields into the lead drawer", () => {
  assert.equal(
    buildPublicFunnelLeadPatch({ leak_detail: "Quotes wait for days." }, "audit_requested")
      .primary_bottleneck,
    "Quotes wait for days.",
  );
});

await check("routes non-audit booking events to the Sales department with no duplicate", async () => {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      assert.equal(table, "agent_events");
      return {
        async upsert(row: Record<string, unknown>) {
          writes.push(row);
          return { error: null };
        },
      };
    },
  };
  const input = {
    db: db as never,
    tenantId: "tenant-a",
    formId: "form-command",
    formSlug: "command",
    leadId: "lead-a",
    startsAt: "2026-10-14T15:00:00.000Z",
    meetUrl: "https://meet.google.com/abc-defg-hij",
    appointmentId: "appointment-a",
  };
  assert.deepEqual(await ensurePublicFunnelBookingEvent(input), { ok: true });
  assert.deepEqual(await ensurePublicFunnelBookingEvent(input), { ok: true });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].id, writes[1].id, "retries use one deterministic event id");
  assert.equal(writes[0].target_agent, "dept:sales");
  assert.equal(writes[0].event_type, "OASIS_FUNNEL_BOOKED");
});

await check("offers 15-minute weekday Toronto slots and excludes either founder's busy time", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z"); // Monday, 08:00 Toronto
  const slots = buildPublicBookingSlots({
    now,
    days: 2,
    busy: [
      { start: "2026-10-12T14:00:00.000Z", end: "2026-10-12T14:30:00.000Z" },
      { start: "2026-10-12T16:30:00.000Z", end: "2026-10-12T17:00:00.000Z" },
    ],
  });
  assert.equal(PUBLIC_BOOKING_TIME_ZONE, "America/Toronto");
  assert.equal(PUBLIC_BOOKING_DEFAULT_DURATION_MINUTES, 15);
  assert.ok(slots.length > 0);
  assert.ok(!slots.includes("2026-10-12T14:00:00.000Z"));
  assert.ok(!slots.includes("2026-10-12T16:30:00.000Z"));
  assert.ok(slots.every((slot) => isPublicBookingSlot(slot, { now, days: 2 })));
});

await check("keeps 45-minute discovery calls inside business hours and clear of busy time", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  const slots = buildPublicBookingSlots({
    now,
    days: 1,
    durationMinutes: 45,
    busy: [{ start: "2026-10-12T14:30:00.000Z", end: "2026-10-12T15:00:00.000Z" }],
  });
  assert.ok(!slots.includes("2026-10-12T14:00:00.000Z"), "a 45-minute call cannot overlap a later busy block");
  assert.ok(!slots.includes("2026-10-12T20:30:00.000Z"), "a 45-minute call cannot run past 17:00 Toronto");
  assert.ok(slots.every((slot) => isPublicBookingSlot(slot, { now, days: 1, durationMinutes: 45 })));
});

await check("refuses weekend, stale, and off-grid booking instants", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  assert.equal(isPublicBookingSlot("2026-10-17T14:00:00.000Z", { now, days: 14 }), false);
  assert.equal(isPublicBookingSlot("2026-10-12T12:30:00.000Z", { now, days: 14 }), false);
  assert.equal(isPublicBookingSlot("2026-10-12T15:15:00.000Z", { now, days: 14 }), false);
});

await check("strictly validates both anonymous booking request bodies", () => {
  const token = "signed-token";
  assert.equal(publicBookingAvailabilitySchema.safeParse({ token }).success, true);
  assert.equal(publicBookingAvailabilitySchema.safeParse({ token, tenant_id: "attacker" }).success, false);
  assert.equal(publicBookingCreateSchema.safeParse({
    token,
    starts_at: "2026-10-14T15:00:00.000Z",
    request_id: "8d5a9a7f-98f2-4b63-9ad7-f2c6f5586063",
  }).success, true);
  assert.equal(publicBookingCreateSchema.safeParse({
    token,
    starts_at: "2026-10-14T15:00:00.000Z",
    request_id: "not-a-uuid",
  }).success, false);
});

await check("applies the Schedule-link migration and serializes one OASIS founder appointment per slot", async () => {
  const dbFile = join(mkdtempSync(join(tmpdir(), "public-booking-")), "test.db");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(readFileSync("database/turso/186_calendar.turso.sql", "utf8"));
  await db.executeMultiple(`
    CREATE TABLE call_appointments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL,
      meeting_kind TEXT NOT NULL,
      calendar_status TEXT NOT NULL,
      duration_minutes INTEGER
    );
  `);
  await db.executeMultiple(readFileSync("database/turso/bravo__222_public_funnel_booking.sql", "utf8"));
  await db.executeMultiple(readFileSync("database/turso/bravo__223_public_funnel_booking_overlap_guard.sql", "utf8"));
  const columns = await db.execute("PRAGMA table_info(calendar_events)");
  const names = new Set(columns.rows.map((row) => String(row.name)));
  for (const name of ["lead_id", "appointment_id", "provider", "provider_event_id"]) {
    assert.ok(names.has(name), `calendar_events includes ${name}`);
  }
  await db.execute({
    sql: `INSERT INTO call_appointments
      (id, tenant_id, lead_id, scheduled_for, status, meeting_kind, calendar_status, duration_minutes)
      VALUES (?, ?, ?, ?, 'scheduled', 'founder_audit', 'creating', 45)`,
    args: ["appointment-1", "ef8d389e-3f15-43f2-ae00-3660f69a1452", "lead-a", "2026-10-14T15:00:00.000Z"],
  });
  await assert.rejects(db.execute({
    sql: `INSERT INTO call_appointments
      (id, tenant_id, lead_id, scheduled_for, status, meeting_kind, calendar_status, duration_minutes)
      VALUES (?, ?, ?, ?, 'scheduled', 'founder_audit', 'creating', 45)`,
    args: ["appointment-2", "ef8d389e-3f15-43f2-ae00-3660f69a1452", "lead-b", "2026-10-14T15:30:00.000Z"],
  }));
  await db.execute({
    sql: "UPDATE call_appointments SET calendar_status = 'failed' WHERE id = 'appointment-1'",
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO call_appointments
      (id, tenant_id, lead_id, scheduled_for, status, meeting_kind, calendar_status, duration_minutes)
      VALUES (?, ?, ?, ?, 'scheduled', 'founder_audit', 'creating', 45)`,
    args: ["appointment-3", "ef8d389e-3f15-43f2-ae00-3660f69a1452", "lead-c", "2026-10-14T15:00:00.000Z"],
  });
  await db.execute({
    sql: "UPDATE call_appointments SET status = 'cancelled' WHERE id = 'appointment-3'",
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO call_appointments
      (id, tenant_id, lead_id, scheduled_for, status, meeting_kind, calendar_status, duration_minutes)
      VALUES (?, ?, ?, ?, 'scheduled', 'founder_audit', 'creating', 45)`,
    args: ["appointment-4", "ef8d389e-3f15-43f2-ae00-3660f69a1452", "lead-d", "2026-10-14T15:00:00.000Z"],
  });
  db.close();
});

console.log("\nAll public-booking checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
