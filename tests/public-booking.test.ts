import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  bookedLeadFacts,
  buildPublicBookingContact,
  buildPublicFunnelLeadPatch,
  ensurePublicFunnelBookingEvent,
  isPublicFunnelReadyForBooking,
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
  // The calendar stays hidden (503 at the end of the handler) ...
  assert.match(submitRoute, /funnelStageWriteFailed = true;/);
  assert.match(submitRoute, /if \(funnelStageWriteFailed\) \{\s*return NextResponse\.json\(\s*\{ ok: false, error: "funnel_stage_write_unavailable" \},\s*\{ status: 503 \},/);
  // ... but a failed stage write must NOT drop the speed-to-lead pipeline: the failure path
  // does not return, and the 503 comes after the scoring/alert/email after() blocks (#611 review).
  const failedBlock = submitRoute
    .slice(
      submitRoute.indexOf("forms.submit.public_booking_completion.failed"),
      submitRoute.indexOf("funnelStageWriteFailed = true;"),
    )
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(failedBlock, /\breturn\b/, "the failure path returns early again");
  assert.ok(
    submitRoute.indexOf("ingestAiAuditSubmission({") < submitRoute.indexOf("if (funnelStageWriteFailed) {"),
    "the 503 must come after the completion pipeline is scheduled",
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
    "workflow automation",
    "the required goal's key is stored as words, never as the option key",
  );
});

await check("preserves an existing rep owner and collaborators when founders join the booking", () => {
  const people = { organizer: "founder-cc", collaborators: ["founder-cc", "founder-adon"] };
  assert.deepEqual(
    publicBookingOwnershipPatch(
      { assigned_to: "rep-owner", collaborators: ["rep-collaborator", "founder-adon"] },
      people,
    ),
    {
      assigned_to: "rep-owner",
      collaborators: ["rep-collaborator", "founder-adon", "founder-cc"],
    },
  );
  assert.deepEqual(
    publicBookingOwnershipPatch({}, people),
    { assigned_to: "founder-cc", collaborators: ["founder-adon"] },
  );
});

await check("a host the booking settings appoint owns and sees the lead (Codex review of #628)", () => {
  assert.deepEqual(
    publicBookingOwnershipPatch({}, { organizer: "rep-host", collaborators: ["rep-host", "founder-cc", "founder-adon"] }),
    { assigned_to: "rep-host", collaborators: ["founder-cc", "founder-adon"] },
  );
  assert.match(bookingRoute, /publicBookingOwnershipPatch\(context\.lead, \{\s*organizer: organizer\.userId,\s*collaborators: \[\s*\.\.\.slot\.hosts\.map/);
});

await check("enables booking only for OASIS forms that promise a founder call", () => {
  assert.deepEqual(PUBLIC_BOOKING_FORM_SLUGS, ["ai-audit", "command", "fleet", "book"]);
  for (const slug of PUBLIC_BOOKING_FORM_SLUGS) assert.equal(isPublicBookingFormSlug(slug), true);
  for (const slug of ["protocol", "community", "vsl", "support", "start"]) {
    assert.equal(isPublicBookingFormSlug(slug), false, `${slug} must not force a sales call`);
  }
  assert.equal(publicBookingDurationMinutes("ai-audit"), 15);
  assert.equal(publicBookingDurationMinutes("command"), 45);
  assert.equal(publicBookingDurationMinutes("fleet"), 45);
  assert.equal(publicBookingDurationMinutes("book"), 30, "the /book link is a 30-minute call (CC, 2026-10-16)");
});

await check("keeps public offer names explicit instead of inferring them from duration", () => {
  assert.equal(publicBookingOfferLabel("ai-audit"), "AI automation audit");
  assert.equal(publicBookingOfferLabel("command"), "COMMAND discovery call");
  assert.equal(publicBookingOfferLabel("fleet"), "FLEET discovery call");
  assert.equal(publicBookingOfferLabel("book"), "discovery call");
  // Own keys only: a slug or typed answer like "constructor" never reads an
  // inherited Object member (Codex review of #630 found the shape elsewhere).
  for (const word of ["constructor", "toString", "__proto__"]) {
    assert.equal(publicBookingDurationMinutes(word), 15, word);
    assert.equal(publicBookingOfferLabel(word), "AI automation audit", word);
    assert.equal(buildPublicFunnelLeadPatch({ bottleneck_detail: word }, "inbound_lead").primary_bottleneck, word, word);
  }
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

await check("books only a slot live availability returns, hosted by that slot's on-duty hosts", () => {
  // Hours and who is on duty are lib/booking/hours.ts (tests/booking-hours.test.ts).
  // Here: the route books exactly what availability offered, with the hosts on
  // duty for THAT slot, and records them for a replay to repair the Schedule copies.
  assert.equal(PUBLIC_BOOKING_TIME_ZONE, "America/Toronto");
  assert.equal(PUBLIC_BOOKING_DEFAULT_DURATION_MINUTES, 15);
  assert.match(bookingRoute, /available\.find\(\(item\) => item\.start === startsAt\)/);
  assert.match(bookingRoute, /hostUserId: organizer\.userId/);
  assert.match(bookingRoute, /expectedOrganizerEmail: organizer\.email/);
  assert.match(bookingRoute, /openerAttendee: attendee \? \{ email: attendee\.email/);
  assert.match(bookingRoute, /hosts: slot\.hosts/);
  assert.match(bookingRoute, /public_booking_host_ids: slot\.hosts\.map/);
  assert.match(bookingRoute, /publicBookingHostsById\(/, "a replay rebuilds the same hosts");
  assert.ok(!/hostUserId: founders\./.test(bookingRoute), "no booking is pinned to a fixed founder any more");
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

await check("a website the form invited but the calendar cannot parse never blocks the booking (review of #611)", async () => {
  const { normalizeFounderMeetingContact } = await import("../lib/website-sales-meeting");
  const base = { name: "Ada", company_name: "Acme", email: "ADA@acme.com", phone: "(514) 555-0142", phone_e164: "+15145550142" };
  // The service REFUSES these raw ("Website or social handle: @acmehvac · n/a · none")...
  for (const typed of ["@acmehvac", "none", "n/a", "no website"]) {
    assert.throws(() => normalizeFounderMeetingContact({ ...base, website: typed }), /invalid_client_website/, typed);
    // ... the contact built for the booking drops it and normalizes.
    const built = normalizeFounderMeetingContact(buildPublicBookingContact({ ...base, website: typed }));
    assert.equal(built.website, null, typed);
    assert.equal(built.phone, "+15145550142");
    assert.equal(built.email, "ada@acme.com");
    assert.equal(built.company, "Acme");
  }
  assert.equal(normalizeFounderMeetingContact(buildPublicBookingContact({ ...base, website: "acme.com" })).website, "https://acme.com/");
  assert.equal(normalizeFounderMeetingContact(buildPublicBookingContact({ ...base, website: "" })).website, null);
  // A phone that cannot be dialled still fails, with its own code (the route answers 422 with it).
  assert.throws(
    () => normalizeFounderMeetingContact(buildPublicBookingContact({ ...base, phone: "555-1212", phone_e164: "" })),
    /invalid_client_phone/,
  );
  assert.match(bookingRoute, /contact: buildPublicBookingContact\(combined\)/);
  assert.match(bookingRoute, /CONTACT_ERRORS\.has\(errorCode\)[\s\S]{0,260}status: 422/);
});

await check("the booked-call alert and the lead read in words, never option keys (review of #611)", () => {
  assert.deepEqual(bookedLeadFacts({ monthly_revenue: "10k_50k", automation_goal: "sales_leadgen" }), {
    revenue: "$10-50K/mo",
    bottleneck: "sales / lead gen",
  });
  // A key already stored on an older lead is still read in words; free text is untouched.
  assert.equal(bookedLeadFacts({ primary_bottleneck: "sales_leadgen" }).bottleneck, "sales / lead gen");
  assert.equal(bookedLeadFacts({ primary_bottleneck: "Quotes wait_for days", automation_goal: "sales_leadgen" }).bottleneck, "Quotes wait_for days");
  assert.equal(bookedLeadFacts({ bottleneck_detail: " Leads wait. ", automation_goal: "sales_leadgen" }).bottleneck, "Leads wait.");
  assert.deepEqual(bookedLeadFacts({}), { revenue: "", bottleneck: "" });
  assert.match(bookingRoute, /const \{ revenue, bottleneck \} = bookedLeadFacts\(combined\);/);
});

await check("/team/schedule lands on the Schedule instead of a 404", async () => {
  const config = (await import("../next.config.js")) as { default: { redirects: () => Promise<Array<{ source: string; destination: string; permanent: boolean }>> } };
  const redirects = await config.default.redirects();
  const hit = redirects.find((r) => r.source === "/team/schedule");
  assert.deepEqual(hit && { destination: hit.destination, permanent: hit.permanent }, { destination: "/schedule", permanent: false });
});

await check("a failed booked-call alert leaves a durable marker on the lead", () => {
  assert.match(bookingRoute, /if \(!sent\.delivered\) \{[\s\S]{0,200}await recordAlertFailure\(/);
});

await check("a rebooked lead gets a fresh Sales event: the id is per appointment", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE agent_events (id TEXT PRIMARY KEY, event_type TEXT, payload TEXT)`);
  const upserts: string[] = [];
  const fake = {
    from: () => ({
      upsert: async (row: { id: string }) => {
        upserts.push(row.id);
        return { error: null };
      },
    }),
  };
  const base = { db: fake as never, tenantId: "t", formId: "f", formSlug: "command", leadId: "l", startsAt: "2026-10-20T14:00:00.000Z", meetUrl: "https://meet.google.com/aaa-bbbb-ccc" };
  await ensurePublicFunnelBookingEvent({ ...base, appointmentId: "appt-1" });
  await ensurePublicFunnelBookingEvent({ ...base, appointmentId: "appt-1" });
  await ensurePublicFunnelBookingEvent({ ...base, appointmentId: "appt-2" });
  assert.equal(upserts[0], upserts[1], "the same appointment is the same event");
  assert.notEqual(upserts[0], upserts[2], "a rebooking is a new event");
});

await check("the request-body parser trims, bounds, and rejects anything that is not exactly the shape", () => {
  const requestId = "8d5a9a7f-98f2-4b63-9ad7-f2c6f5586063";
  const created = publicBookingCreateSchema.safeParse({ token: "  t  ", starts_at: " 2026-10-14T15:00:00.000Z ", request_id: ` ${requestId} ` });
  assert.deepEqual(created.success && created.data, { token: "t", starts_at: "2026-10-14T15:00:00.000Z", request_id: requestId });
  for (const bad of [undefined, null, "text", 7, [], [{ token: "t" }]]) {
    assert.equal(publicBookingAvailabilitySchema.safeParse(bad).success, false, `body ${JSON.stringify(bad)}`);
  }
  assert.equal(publicBookingAvailabilitySchema.safeParse({}).success, false, "a missing token");
  assert.equal(publicBookingAvailabilitySchema.safeParse({ token: "   " }).success, false, "a blank token");
  assert.equal(publicBookingAvailabilitySchema.safeParse({ token: 42 }).success, false, "a non-string token");
  assert.equal(publicBookingAvailabilitySchema.safeParse({ token: "x".repeat(4_096) }).success, true);
  assert.equal(publicBookingAvailabilitySchema.safeParse({ token: "x".repeat(4_097) }).success, false);
  assert.equal(publicBookingCreateSchema.safeParse({ token: "t", starts_at: "x".repeat(65), request_id: requestId }).success, false);
  assert.equal(publicBookingCreateSchema.safeParse({ token: "t", starts_at: "2026-10-14T15:00:00.000Z" }).success, false, "a missing request_id");
  // JSON.parse makes "__proto__" an OWN key; it must count as an unknown key, not vanish.
  const smuggled = JSON.parse('{"token":"t","__proto__":{"tenant_id":"attacker"}}') as unknown;
  assert.equal(publicBookingAvailabilitySchema.safeParse(smuggled).success, false);
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

// Codex review of PR #611: availability advertised slots to a returning lead whose
// pipeline stage the booking endpoint then refuses (`lead_stage_not_bookable`).
await check("only a prospect before the founder handoff may book; both public routes ask the same function", async () => {
  const { isPublicBookingStageBookable } = await import("../lib/forms/public-booking");
  for (const stage of ["researched", "assigned", "attempting_contact", "connected", "qualified", " researched "]) {
    assert.equal(isPublicBookingStageBookable(stage), true, `${stage} may book`);
  }
  for (const stage of ["founder_meeting_booked", "demo_completed", "proposal_sent", "won", "lost", "onboarding", "in_build", "launched", "", "   ", undefined, null, 7]) {
    assert.equal(isPublicBookingStageBookable(stage), false, `${String(stage)} must not book`);
  }
  const { readFileSync } = await import("node:fs");
  const availability = readFileSync("app/api/forms/booking/availability/route.ts", "utf8");
  const booking = readFileSync("app/api/forms/booking/route.ts", "utf8");
  assert.match(availability, /isPublicBookingStageBookable\(context\.lead\.stage\)[\s\S]{0,160}lead_stage_not_bookable/);
  assert.ok(
    availability.indexOf("isPublicBookingStageBookable(context.lead.stage)") < availability.indexOf("loadPublicBookingAvailability({"),
    "the stage is checked BEFORE two calendars are read",
  );
  assert.match(booking, /isPublicBookingStageBookable\(currentStage\)[\s\S]{0,160}lead_stage_not_bookable/);
  assert.ok(!/BOOKABLE_STAGES/.test(booking), "the booking route no longer keeps its own copy of the stage list");
});

console.log("\nAll public-booking checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
