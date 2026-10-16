/**
 * tests/booking-settings.test.ts - booking settings persistence and who may
 * change what (lib/booking/settings-store.ts, lib/booking/settings-edit.ts,
 * migration 227), against a real libSQL database built from the migration file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { defaultOasisBookingSettings, weeklyHoursOn } from "../lib/booking/hours";
import { applyBookingSettingsEdit } from "../lib/booking/settings-edit";
import { BookingSettingsError, loadBookingSettings, saveBookingSettings } from "../lib/booking/settings-store";
import { AI_AUDIT_TENANT_ID } from "../lib/forms/oasis-ai-audit-seed";

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  console.log(`  ok - ${name}`);
}

const CC = "user-cc";
const ADON = "user-adon";
const roster = async () =>
  [
    { auth_user_id: CC, email: "conaugh@oasisai.work", full_name: "CC", display_name: null },
    { auth_user_id: ADON, email: "adon@oasisai.work", full_name: "Adon", display_name: null },
  ] as never;

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await db.executeMultiple(readFileSync("database/turso/bravo__227_booking_settings.sql", "utf8"));
  return db;
}

async function main(): Promise<void> {
  console.log("booking settings");

  await check("with nothing saved, OASIS gets CC's hours as version 0", async () => {
    const db = await freshDb();
    const loaded = await loadBookingSettings(AI_AUDIT_TENANT_ID, { db, roster });
    assert.equal(loaded.saved, false);
    assert.equal(loaded.version, 0);
    assert.deepEqual(loaded.settings, defaultOasisBookingSettings({ organizerUserId: CC, attendeeUserId: ADON }));
  });

  await check("a missing table (migration not applied) still books on the default", async () => {
    const db = createClient({ url: ":memory:" });
    const loaded = await loadBookingSettings(AI_AUDIT_TENANT_ID, { db, roster });
    assert.equal(loaded.saved, false);
  });

  await check("another workspace is not configured for public booking", async () => {
    const db = await freshDb();
    await assert.rejects(loadBookingSettings("other-tenant", { db, roster }), (err: unknown) =>
      err instanceof BookingSettingsError && err.code === "booking_not_configured");
  });

  await check("saves compare-and-swap: a stale editor gets a conflict, never an overwrite", async () => {
    const db = await freshDb();
    const base = defaultOasisBookingSettings({ organizerUserId: CC, attendeeUserId: ADON });
    const first = await saveBookingSettings({ tenantId: AI_AUDIT_TENANT_ID, settings: base, expectedVersion: 0, actorUserId: CC, db });
    assert.deepEqual(first, { ok: true, version: 1 });
    const stale = await saveBookingSettings({
      tenantId: AI_AUDIT_TENANT_ID,
      settings: { ...base, bufferMinutes: 15 },
      expectedVersion: 0,
      actorUserId: ADON,
      db,
    });
    assert.deepEqual(stale, { ok: false, error: "version_conflict", version: 1 });
    const second = await saveBookingSettings({
      tenantId: AI_AUDIT_TENANT_ID,
      settings: { ...base, bufferMinutes: 10 },
      expectedVersion: 1,
      actorUserId: ADON,
      db,
    });
    assert.deepEqual(second, { ok: true, version: 2 });
    const loaded = await loadBookingSettings(AI_AUDIT_TENANT_ID, { db, roster });
    assert.equal(loaded.saved, true);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.settings.bufferMinutes, 10);
  });

  await check("a stored document that no longer parses fails loud, never guesses hours", async () => {
    const db = await freshDb();
    await db.execute({
      sql: "INSERT INTO booking_settings (tenant_id, doc, version, updated_at) VALUES (?, ?, 1, ?)",
      args: [AI_AUDIT_TENANT_ID, JSON.stringify({ timeZone: "America/Toronto", hosts: [] }), "2026-10-16T00:00:00.000Z"],
    });
    await assert.rejects(loadBookingSettings(AI_AUDIT_TENANT_ID, { db, roster }), (err: unknown) =>
      err instanceof BookingSettingsError && err.code === "booking_settings_invalid");
  });

  const current = {
    ...defaultOasisBookingSettings({ organizerUserId: CC, attendeeUserId: ADON }),
    hosts: defaultOasisBookingSettings({ organizerUserId: CC, attendeeUserId: ADON }).hosts.map((h) =>
      h.userId === ADON ? { ...h, targetCalendarId: "adon-cal" } : h,
    ),
  };
  const edit = (callerUserId: string, submitted: unknown, callerCalendarIds: string[] = []) =>
    applyBookingSettingsEdit({
      current,
      submitted,
      callerUserId,
      rosterUserIds: new Set([CC, ADON]),
      callerCalendarIds: new Set(callerCalendarIds),
    });

  await check("only a host may change the booking settings", () => {
    assert.deepEqual(edit("a-rep", current), { ok: false, status: 403, error: "not_a_host" });
  });

  await check("an invalid document or a host off the roster is refused", () => {
    assert.deepEqual(edit(CC, { ...current, stepMinutes: 7 }), { ok: false, status: 400, error: "invalid_settings" });
    const stranger = { ...current, hosts: [current.hosts[0], { ...current.hosts[1], userId: "stranger" }] };
    assert.deepEqual(edit(CC, stranger), { ok: false, status: 400, error: "host_not_on_roster" });
  });

  await check("each host points only their own calls at their own calendar", () => {
    const toMeetings = { ...current, hosts: [{ ...current.hosts[0], targetCalendarId: "meetings" }, current.hosts[1]] };
    assert.deepEqual(edit(CC, toMeetings, ["personal"]), { ok: false, status: 400, error: "calendar_not_yours" });
    const ok = edit(CC, toMeetings, ["personal", "meetings"]);
    assert.ok(ok.ok);
    if (ok.ok) assert.equal(ok.settings.hosts[0].targetCalendarId, "meetings");
  });

  await check("a host can set the other host's hours but never their calendar", () => {
    const adonHours = weeklyHoursOn([0, 1, 2, 3], 660, 1200);
    const submitted = {
      ...current,
      hosts: [current.hosts[0], { ...current.hosts[1], weeklyHours: adonHours, targetCalendarId: "hijack" }],
    };
    const result = edit(CC, submitted, ["meetings"]);
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.settings.hosts[1].weeklyHours, adonHours);
      assert.equal(result.settings.hosts[1].targetCalendarId, "adon-cal", "Adon's own choice is carried over");
    }
  });

  await check("a save that loses the version race re-reads the settings, so the next Settings is the latest (CodeRabbit on #628)", () => {
    const card = readFileSync("components/calendar/BookingLinkCard.tsx", "utf8");
    assert.match(card, /if \(data\?\.error === "version_conflict"\) \{\s*await onConflict\(\);/, "a conflict does not hand back to the card");
    assert.match(card, /onConflict=\{async \(\) => \{\s*setEditing\(false\);\s*await refresh\(\);/, "the card does not re-read the settings on a conflict");
    assert.doesNotMatch(card, /Close this and open it again/, "the old advice reopened the same stale copy");
    const page = readFileSync("components/booking/BookingPage.tsx", "utf8");
    assert.doesNotMatch(page, /next two weeks/, "the horizon is a setting (7 to 30 days), never a fixed two weeks");
  });

  console.log("booking-settings: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
