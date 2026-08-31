import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { createTursoPostgrest } from "../lib/turso-postgrest";
import {
  createVerifiedFounderMeeting,
  grantFounderMeetingSmsConsent,
} from "../lib/website-sales-founder-meeting";
import { normalizeFounderMeetingContact } from "../lib/website-sales-meeting";
import {
  SMS_CONSENT_DISCLOSURE,
  SMS_CONSENT_DISCLOSURE_VERSION,
} from "../lib/sms/auto-responses";
import { countSegments } from "../lib/sms-segments";

const TENANT = "tenant-a";
const LEAD = "lead-a";
const ACTOR = "rep-a";
const HOST = "founder-a";
const NOW = Date.parse("2026-09-01T14:00:00.000Z");
const MEETING_AT = "2026-09-01T16:00:00.000Z";
const ORGANIZER = "founder@oasisai.work";

const BASE_SCHEMA = `
  CREATE TABLE call_appointments (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    lead_id TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'lead',
    scheduled_for TEXT NOT NULL,
    assigned_to TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    pre_call_note TEXT,
    outcome_note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
  );
  CREATE TABLE tenant_records (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_source TEXT,
    metadata TEXT
  );
`;

function bookingInput(requestId: string) {
  return {
    tenantId: TENANT,
    leadId: LEAD,
    actorUserId: ACTOR,
    hostUserId: HOST,
    requestId,
    meetingAt: MEETING_AT,
    contact: {
      name: "Taylor Smith",
      company: "North Star Dental",
      email: "taylor@example.com",
      phone: null,
      website: "https://northstardental.ca/",
    },
    clientAgenda: "Review the site and online booking workflow.",
    handoffNote: "Decision maker confirmed and wants online scheduling.",
    smsConsent: false,
    expectedOrganizerEmail: ORGANIZER,
    confirmations: {
      contactConfirmed: true as const,
      clientAgreedToTime: true as const,
      handoffComplete: true as const,
    },
  };
}

async function fixture() {
  const raw = createClient({ url: ":memory:" });
  const migration167 = readFileSync("database/turso/167_founder_meeting_closed_loop.turso.sql", "utf8");
  const migration169 = readFileSync("database/turso/169_founder_meeting_reminder_tiers.turso.sql", "utf8");
  await raw.executeMultiple(`${BASE_SCHEMA}\n${migration167}\n${migration169}`);
  const db = createTursoPostgrest(raw);
  let calendarCreates = 0;
  const deps = {
    db: db as never,
    now: () => NOW,
    createCalendar: async () => {
      calendarCreates += 1;
      return {
        calendarId: "primary",
        eventId: "event12345",
        htmlLink: "https://calendar.google.com/calendar/event?eid=test",
        meetLink: "https://meet.google.com/abc-defg-hij",
        iCalUID: "ical-1",
        organizerEmail: ORGANIZER,
      };
    },
    updateCalendar: async () => { throw new Error("unexpected_update"); },
    cancelCalendar: async () => undefined,
  };
  return { raw, deps, calendarCreates: () => calendarCreates };
}

async function main() {
  assert.equal(countSegments(SMS_CONSENT_DISCLOSURE), 1);
  assert.match(SMS_CONSENT_DISCLOSURE, /OASIS AI Solutions/);
  assert.match(SMS_CONSENT_DISCLOSURE, /Reply STOP/i);
  assert.match(SMS_CONSENT_DISCLOSURE_VERSION, /^\d{4}-\d{2}-\d{2}\.v\d+$/);
  assert.equal(
    normalizeFounderMeetingContact({ email: "legacy@example.com" }).phone,
    null,
    "historical appointment normalization remains phone-optional",
  );

  const fresh = await fixture();
  await assert.rejects(
    createVerifiedFounderMeeting(bookingInput("new-phone-less"), fresh.deps),
    /client_phone_required/,
  );
  assert.equal(fresh.calendarCreates(), 0, "the phone gate runs before the external Calendar mutation");
  await fresh.raw.close();

  const legacy = await fixture();
  await legacy.raw.execute({
    sql: `INSERT INTO call_appointments (
      id, tenant_id, lead_id, entity_type, scheduled_for, assigned_to, status,
      created_by, meeting_kind, duration_minutes, timezone, client_name_snapshot,
      company_snapshot, client_email_snapshot, client_phone_snapshot, website_snapshot,
      client_agenda, handoff_note, google_calendar_id, google_event_id,
      google_event_html_link, google_meet_link, google_ical_uid, calendar_status,
      organizer_email_snapshot, booking_request_id, revision, workflow_status,
      sms_consent, contact_confirmed_at, time_confirmed_at, handoff_confirmed_at,
      confirmed_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      "legacy-meeting", TENANT, LEAD, "lead", MEETING_AT, HOST, "scheduled",
      ACTOR, "founder_audit", 15, "America/Toronto", "Taylor Smith",
      "North Star Dental", "taylor@example.com", null, "https://northstardental.ca/",
      "Review the site and online booking workflow.",
      "Decision maker confirmed and wants online scheduling.", "primary", "legacy-event",
      "https://calendar.google.com/calendar/event?eid=legacy",
      "https://meet.google.com/abc-defg-hij", "legacy-ical", "verified", ORGANIZER,
      "legacy-phone-less", 1, "active", 0,
      "2026-09-01T13:00:00.000Z", "2026-09-01T13:00:00.000Z",
      "2026-09-01T13:00:00.000Z", ACTOR,
    ],
  });
  const replay = await createVerifiedFounderMeeting(bookingInput("legacy-phone-less"), legacy.deps);
  assert.equal(replay.appointmentId, "legacy-meeting");
  assert.equal(replay.contact.phone, null);
  assert.equal(legacy.calendarCreates(), 0, "a legacy replay reuses its verified receipt");
  await legacy.raw.execute({
    sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data)
          VALUES (?, ?, 'lead', ?)`,
    args: [LEAD, TENANT, JSON.stringify({ phone: "+14165550101" })],
  });
  await grantFounderMeetingSmsConsent({
    tenantId: TENANT,
    leadId: LEAD,
    appointmentId: "legacy-meeting",
    consentedPhone: "+14165550101",
    capturedAt: new Date("2026-09-01T14:01:00.000Z"),
  }, legacy.deps);
  const consented = await legacy.raw.execute({
    sql: `SELECT sms_consent, sms_consent_at, client_phone_snapshot
          FROM call_appointments WHERE id = ?`,
    args: ["legacy-meeting"],
  });
  assert.equal(Number(consented.rows[0].sms_consent), 1);
  assert.equal(consented.rows[0].client_phone_snapshot, "+14165550101");
  const smsTiers = await legacy.raw.execute({
    sql: `SELECT reminder_minutes_before
          FROM website_sales_meeting_notifications
          WHERE appointment_id = ? AND channel = 'sms' AND reminder_minutes_before IS NOT NULL`,
    args: ["legacy-meeting"],
  });
  assert.equal(smsTiers.rows.length, 3, "late consent repairs every still-valid SMS tier");
  await assert.rejects(
    grantFounderMeetingSmsConsent({
      tenantId: TENANT,
      leadId: LEAD,
      appointmentId: "legacy-meeting",
      consentedPhone: "+16135550199",
      capturedAt: new Date("2026-09-01T14:02:00.000Z"),
    }, legacy.deps),
    /meeting_sms_consent_phone_mismatch/,
    "consent for a changed lead number must never enable sends to the old appointment snapshot",
  );
  await legacy.raw.close();

  const serviceSource = readFileSync("lib/website-sales-founder-meeting.ts", "utf8");
  assert.match(serviceSource, /function contactFromAppointment[\s\S]*?normalizeFounderMeetingContact\(/);

  const uiSource = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");
  assert.match(uiSource, /const founderPhoneValid\s*=/);
  assert.match(uiSource, /founderBookingReady\s*=[\s\S]*?founderPhoneValid/);
  const readiness = uiSource.match(/const founderBookingReady\s*=([\s\S]*?);\s*const bookingBlockedReason/)?.[1] || "";
  assert(!readiness.includes("smsConsent"), "consent is an optional affirmative act, not a booking gate");
  assert.match(uiSource, /if \(!founderPhoneValid\) return "Enter a valid client phone number"/);
  assert.match(uiSource, /label="Phone"[\s\S]*?required[\s\S]*?updateBookingContact\("phone"/);
  assert.match(uiSource, /SMS_CONSENT_DISCLOSURE/);
  assert.match(uiSource, /founder_meeting_sms_consent/);

  const routeSource = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
  assert.match(routeSource, /client_phone_required/);
  assert.match(routeSource, /founder_meeting_sms_consent_artifact/);
  assert.match(routeSource, /consentedPhone\s*:\s*current\.phone/);

  const pageSource = readFileSync("app/pipeline/[id]/page.tsx", "utf8");
  assert.match(pageSource, /call_appointments[\s\S]*?select\(["']sms_consent["']\)/);
  assert.doesNotMatch(
    pageSource,
    /initialFounderMeetingSmsConsent=\{activeRecord\.data\.founder_meeting_sms_consent === true\}/,
    "late-consent visibility must use the appointment truth so a failed grant remains retryable",
  );

  console.log("founder-booking-phone-required: OK");
}

void main();
