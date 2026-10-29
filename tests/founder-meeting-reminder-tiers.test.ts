import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import {
  buildFounderMeetingMessages,
  clampSmsBody,
  buildFounderHostHeadsUp,
  FOUNDER_REMINDER_SCHEDULE,
  FOUNDER_REMINDER_TIERS,
  founderMeetingDedupeKey,
  hostHeadsUpPlanned,
  isKnownReminderTier,
  normalizeFounderMeetingPhone,
  plannedReminderTiers,
  reminderChannelsFor,
  reminderKindFor,
  reminderTierStillValid,
  reminderWindowText,
  SMS_STOP_FOOTER,
  validateMeetingLink,
  withSmsFooter,
} from "../lib/website-sales-meeting";
import { countSegments } from "../lib/sms-segments";
import { quoStopIntakeConnected } from "../lib/integrations/quo";
import { teamInviteOrigin } from "../lib/team-invite-email";

const migration167 = readFileSync(
  "database/turso/167_founder_meeting_closed_loop.turso.sql",
  "utf8",
);
const migration169 = readFileSync(
  "database/turso/169_founder_meeting_reminder_tiers.turso.sql",
  "utf8",
);
const dispatcherSource = readFileSync(
  "app/api/cron/dispatch-founder-meeting-reminders/route.ts",
  "utf8",
);

assert.match(dispatcherSource, /row\.reminder_minutes_before\s*!=\s*null/);
assert.match(dispatcherSource, /reminderTierStillValid\(/);
assert.doesNotMatch(
  dispatcherSource,
  /row\.kind\s*===\s*["']ten_minute["']/,
  "delivery must branch on the numeric tier, never the legacy reporting kind",
);

const oasisMeetingLink = `${teamInviteOrigin()}/meet/abc-defg-hjk`;
assert.equal(validateMeetingLink("https://meet.google.com/abc-defg-hij"), "https://meet.google.com/abc-defg-hij");
assert.equal(validateMeetingLink(oasisMeetingLink), oasisMeetingLink);
const canonicalOasisUrl = new URL(oasisMeetingLink);
const invalidMeetingLinks = [
  `http://${canonicalOasisUrl.host}${canonicalOasisUrl.pathname}`,
  `https://person@${canonicalOasisUrl.host}${canonicalOasisUrl.pathname}`,
  `https://${canonicalOasisUrl.hostname}:444${canonicalOasisUrl.pathname}`,
  `${oasisMeetingLink}?join=1`,
  `${oasisMeetingLink}#join`,
  `${oasisMeetingLink}/extra`,
  `${teamInviteOrigin()}/meet/ABC-DEFG-HJK`,
  `https://evil.example${canonicalOasisUrl.pathname}`,
  `${teamInviteOrigin()}/meet/ab-defg-hjk`,
  `${teamInviteOrigin()}/meet/abc-defg-hil`,
];
for (const link of invalidMeetingLinks) {
  assert.throws(() => validateMeetingLink(link), /google_meet_link_missing/, link);
}
// The ladder CC asked for (2026-10-28): the day before, an hour, then texts at
// 30, 15 and 5 minutes, with email at the day before, the hour and 15 minutes.
assert.deepEqual(FOUNDER_REMINDER_TIERS, [1440, 60, 30, 15, 5]);
assert.deepEqual(
  FOUNDER_REMINDER_SCHEDULE.map((step) => [step.minutes, [...step.channels]]),
  [[1440, ["email", "sms"]], [60, ["email"]], [30, ["sms"]], [15, ["email", "sms"]], [5, ["sms"]]],
);
assert.equal(reminderKindFor(1440), "reminder_1440");
assert.equal(reminderKindFor(60), "reminder_60");
assert.equal(reminderKindFor(30), "reminder_30");
assert.equal(reminderKindFor(15), "reminder_15");
assert.equal(reminderKindFor(5), "reminder_5");
assert.equal(reminderKindFor(10), "ten_minute", "rows queued before the ladder keep their kind");
assert.deepEqual([...reminderChannelsFor(30)], ["sms"], "T-30 is a text only");
assert.deepEqual([...reminderChannelsFor(10)], ["email", "sms"]);
assert.throws(() => reminderKindFor(20 as never), /unsupported_reminder_tier/);
assert(isKnownReminderTier(10) && isKnownReminderTier(5) && !isKnownReminderTier(20));

assert.deepEqual(
  plannedReminderTiers({
    meetingAt: "2026-09-02T15:15:00.000Z",
    nowIso: "2026-09-01T14:00:00.000Z",
  }),
  [1440, 60, 30, 15, 5],
  "a booking more than a day out plans the whole ladder",
);
assert.deepEqual(
  plannedReminderTiers({
    meetingAt: "2026-09-01T15:15:00.000Z",
    nowIso: "2026-09-01T14:00:00.000Z",
  }),
  [60, 30, 15, 5],
  "a 75-minute lead time plans everything inside the hour",
);
assert.deepEqual(
  plannedReminderTiers({
    meetingAt: "2026-09-01T14:20:00.000Z",
    nowIso: "2026-09-01T14:00:00.000Z",
  }),
  [15, 5],
  "a 20-minute lead time never invents T-60/T-30 reminders",
);
// Superseded only by the next step on the SAME channel (Codex review of #774).
// Email steps: 1440, 60, 15. Text steps: 1440, 30, 15, 5.
assert(!reminderTierStillValid(1440, 60, "email"), "the day-before email is dropped once the hour email is due");
assert(reminderTierStillValid(1440, 61, "email"));
assert(!reminderTierStillValid(1440, 30, "sms"), "the day-before text is dropped once the 30-minute text is due");
assert(reminderTierStillValid(60, 30, "email"), "no 30-minute email exists, so the hour email still goes out at 30");
assert(!reminderTierStillValid(60, 15, "email"), "T-60 email is superseded when the 15-minute email is due");
assert(!reminderTierStillValid(30, 15, "sms"), "T-30 text is superseded exactly when the T-15 text is due");
assert(reminderTierStillValid(30, 16, "sms"));
assert(reminderTierStillValid(15, 4, "email"), "the 15-minute email is the last email: a 5-minute TEXT never drops it");
assert(!reminderTierStillValid(15, 5, "sms"), "the T-15 text is superseded exactly when the T-5 text is due");
assert(reminderTierStillValid(5, 1, "sms"));
assert(!reminderTierStillValid(5, 0, "sms"));
assert(reminderTierStillValid(10, 1, "email"), "an old T-10 row still goes out until the call starts");
assert(!reminderTierStillValid(10, 0, "sms"));
// Automated texts stay off until an authenticated Quo STOP intake has proven
// itself (Codex review of #774); without the signing key it never opens. The
// open path is tests/quo-stop-intake.test.ts.
void quoStopIntakeConnected("tenant-a", "+13653603976", { env: {} }).then((open) => {
  assert.equal(open, false, "no signing key, no automated texts");
});
assert.equal(reminderWindowText(1440), "about 24 hours");
assert.equal(reminderWindowText(58), "1 hour");
assert.equal(reminderWindowText(5), "5 minutes");
assert.equal(reminderWindowText(1), "1 minute");
assert(hostHeadsUpPlanned("2026-09-01T15:00:00.000Z", "2026-09-01T14:00:00.000Z"));
assert(!hostHeadsUpPlanned("2026-09-01T14:16:00.000Z", "2026-09-01T14:00:00.000Z"), "no heads-up already past due");
const heads = buildFounderHostHeadsUp({
  contactName: "Gideon Boniface",
  company: "Rice farm",
  email: "gideon@example.com",
  phone: "+2348153169177",
  meetingAt: "2026-09-01T15:15:00.000Z",
  timezone: "America/Toronto",
  meetLink: "https://meet.google.com/abc-defg-hij",
  clientAgenda: "A 15-minute AI audit call.",
  offerLabel: "AI automation audit",
  leadId: "lead-1",
});
assert.equal(heads.subject, "In 15 minutes: Gideon Boniface, Rice farm");
assert.match(heads.body, /Join: https:\/\/meet\.google\.com\/abc-defg-hij/);
assert.match(heads.body, /Phone: \+2348153169177/);
assert.match(heads.body, /\/pipeline\/lead-1/, "the heads-up links the lead");
// A number written with its country code keeps it (Codex review of #774).
assert.equal(normalizeFounderMeetingPhone("+65 9823 4567"), "+6598234567", "+65 is never read as +1 659...");
assert.equal(normalizeFounderMeetingPhone("+234 815 316 9177"), "+2348153169177");
assert.equal(normalizeFounderMeetingPhone("(416) 555-0101"), "+14165550101", "a bare 10-digit number is North American");
assert.equal(normalizeFounderMeetingPhone("+1 (416) 555-0101"), "+14165550101");
assert.throws(() => normalizeFounderMeetingPhone("+12"), /invalid_client_phone/);
assert.equal(
  founderMeetingDedupeKey("appointment-1", 2, "ten_minute", "sms"),
  "appointment-1:2:ten_minute:sms",
  "the live T-10 dedupe-key format is stable",
);

const tierMessages = buildFounderMeetingMessages({
  company: "North Star Dental",
  contactName: "Taylor",
  meetingAt: "2026-09-01T15:15:00.000Z",
  timezone: "America/Toronto",
  meetLink: "https://meet.google.com/abc-defg-hij",
  clientAgenda: "Review the current site and booking workflow.",
  reminderMinutesBefore: 60,
});
assert.match(tierMessages.reminder.subject, /1 hour/i);
assert.doesNotMatch(tierMessages.reminder.subject, /60 minutes/i);
assert.match(tierMessages.reminder.sms, /^OASIS AI:/);
assert.match(tierMessages.reminder.sms, /meet\.google\.com\/abc-defg-hij/);

const discoveryMessages = buildFounderMeetingMessages({
  company: "North Star Dental",
  contactName: "Taylor",
  meetingAt: "2026-09-01T15:15:00.000Z",
  timezone: "America/Toronto",
  meetLink: "https://meet.google.com/abc-defg-hij",
  clientAgenda: "Review the current site and booking workflow.",
  durationMinutes: 45,
  offerLabel: "COMMAND discovery call",
  reminderMinutesBefore: 30,
});
assert.match(discoveryMessages.confirmationSms, /45-minute COMMAND discovery call/i);
assert.match(discoveryMessages.reminder.subject, /COMMAND discovery call/i);
assert.match(discoveryMessages.reminder.body, /45-minute OASIS COMMAND discovery call/i);
assert.doesNotMatch(
  `${discoveryMessages.confirmationSms}\n${discoveryMessages.reminder.subject}\n${discoveryMessages.reminder.body}`,
  /15-minute website audit/i,
);

const aiAuditMessages = buildFounderMeetingMessages({
  company: "North Star Dental",
  contactName: "Taylor",
  meetingAt: "2026-09-01T15:15:00.000Z",
  timezone: "America/Toronto",
  meetLink: "https://meet.google.com/abc-defg-hij",
  clientAgenda: "Review the current automation stack.",
  durationMinutes: 15,
  offerLabel: "AI automation audit",
  reminderMinutesBefore: 10,
});
assert.match(aiAuditMessages.confirmationSms, /15-minute AI automation audit/i);
assert.match(aiAuditMessages.reminder.subject, /AI automation audit/i);
assert.doesNotMatch(
  `${aiAuditMessages.confirmationSms}\n${aiAuditMessages.reminder.subject}\n${aiAuditMessages.reminder.body}`,
  /website audit/i,
);

const firstSms = withSmsFooter(tierMessages.reminder.sms, { firstInConversation: true });
assert.match(firstSms, /^OASIS AI:/);
assert(firstSms.endsWith(SMS_STOP_FOOTER));
assert.equal(firstSms.split(SMS_STOP_FOOTER).length - 1, 1, "STOP footer is not duplicated");
assert.doesNotMatch(
  withSmsFooter(tierMessages.reminder.sms, { firstInConversation: false }),
  /Reply STOP/i,
);

const clamped = clampSmsBody(
  `${tierMessages.reminder.sms}\nAgenda: ${"a detailed discovery item ".repeat(30)}\n${SMS_STOP_FOOTER}`,
  2,
);
assert(countSegments(clamped) <= 2, "outbound reminder stays within two SMS segments");
assert.match(clamped, /meet\.google\.com\/abc-defg-hij/);
assert(clamped.endsWith(SMS_STOP_FOOTER), "segment clamping never drops the STOP footer");
assert.doesNotMatch(clamped, /detailed discovery item/, "agenda is dropped before protected content");

const oasisClamped = clampSmsBody(
  `${SMS_STOP_FOOTER}\n${"Long agenda text ".repeat(50)}\nJoin: ${oasisMeetingLink}`,
  2,
);
assert.match(oasisClamped, /oasisai\.work\/meet\/abc-defg-hjk/);
assert(oasisClamped.endsWith(SMS_STOP_FOOTER), "Oasis link clamping keeps protected compliance text");


async function main() {
const db = createClient({ url: ":memory:" });
await db.execute("PRAGMA foreign_keys = ON");
await db.executeMultiple(`
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
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    agent_source TEXT,
    metadata TEXT
  );
  ${migration167}
`);

await db.execute({
  sql: `INSERT INTO call_appointments
    (id, tenant_id, lead_id, scheduled_for, created_by)
    VALUES (?, ?, ?, ?, ?)`,
  args: ["appt-legacy", "tenant-a", "lead-a", "2026-09-01T16:00:00.000Z", "rep-a"],
});
await db.execute({
  sql: `INSERT INTO website_sales_meeting_notifications
    (id, tenant_id, appointment_id, lead_id, kind, channel, due_at,
     recipient, sender_user_id, body, dedupe_key)
    VALUES (?, ?, ?, ?, 'ten_minute', 'sms', ?, ?, ?, ?, ?)`,
  args: [
    "notification-legacy",
    "tenant-a",
    "appt-legacy",
    "lead-a",
    "2026-09-01T15:50:00.000Z",
    "+14165550100",
    "rep-a",
    "Legacy reminder",
    "appt-legacy:1:ten_minute:sms",
  ],
});

await db.executeMultiple(migration169);

const columns = await db.execute("PRAGMA table_info(website_sales_meeting_notifications)");
assert(
  columns.rows.some((row) => row.name === "reminder_minutes_before"),
  "migration 169 adds reminder_minutes_before",
);

const legacy = await db.execute({
  sql: `SELECT kind, reminder_minutes_before, dedupe_key
        FROM website_sales_meeting_notifications WHERE id = ?`,
  args: ["notification-legacy"],
});
assert.deepEqual(
  {
    kind: legacy.rows[0].kind,
    reminder_minutes_before: legacy.rows[0].reminder_minutes_before,
    dedupe_key: legacy.rows[0].dedupe_key,
  },
  {
    kind: "ten_minute",
    reminder_minutes_before: 10,
    dedupe_key: "appt-legacy:1:ten_minute:sms",
  },
  "legacy T-10 rows keep their kind/key and gain the numeric tier",
);

const counts = await db.execute(`
  SELECT
    (SELECT count(*) FROM website_sales_meeting_notifications) AS live_count,
    (SELECT count(*) FROM website_sales_meeting_notifications_v167) AS retired_count
`);
assert.equal(counts.rows[0].live_count, counts.rows[0].retired_count);

const indexes = await db.execute(`
  SELECT name FROM sqlite_schema
  WHERE type = 'index'
    AND name IN (
      'website_sales_meeting_notifications_due_idx',
      'website_sales_meeting_notifications_appointment_idx',
      'website_sales_meeting_notifications_tracking_idx',
      'call_appointments_founder_backfill_idx'
    )
  ORDER BY name
`);
assert.equal(indexes.rows.length, 4, "all original indexes plus the founder backfill index exist");

for (const [id, kind, minutes] of [
  ["notification-60", "reminder_60", 60],
  ["notification-30", "reminder_30", 30],
] as const) {
  await db.execute({
    sql: `INSERT INTO website_sales_meeting_notifications
      (id, tenant_id, appointment_id, lead_id, kind, reminder_minutes_before,
       channel, due_at, recipient, sender_user_id, body, dedupe_key)
      VALUES (?, 'tenant-a', 'appt-legacy', 'lead-a', ?, ?, 'email',
              '2026-09-01T15:00:00.000Z', 'client@example.com', 'rep-a',
              'Tier reminder', ?)`,
    args: [id, kind, minutes, `appt-legacy:1:${kind}:email`],
  });
}

await assert.rejects(
  db.execute({
    sql: `INSERT INTO website_sales_meeting_notifications
      (id, tenant_id, appointment_id, lead_id, kind, channel, due_at,
       recipient, sender_user_id, body, dedupe_key)
      VALUES ('notification-bogus', 'tenant-a', 'appt-legacy', 'lead-a',
              'bogus', 'email', '2026-09-01T15:00:00.000Z',
              'client@example.com', 'rep-a', 'Bogus', 'bogus-key')`,
    args: [],
  }),
  /CHECK constraint failed/i,
);

const fk = await db.execute("PRAGMA foreign_key_check");
assert.equal(fk.rows.length, 0, "rename-aside rebuild preserves foreign-key integrity");

console.log("founder-meeting-reminder-tiers migration: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
