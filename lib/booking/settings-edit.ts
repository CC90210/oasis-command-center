/**
 * Who may change the booking settings, and what a save may touch.
 *
 * - Only a current host (the people whose time is being booked) may save.
 * - Every host must be on the workspace's sales roster.
 * - Each person chooses where THEIR OWN booked calls land: a host may point
 *   their own copies at one of their own calendars, never someone else's, and
 *   another host's choice is carried over unchanged (calendars are private to
 *   their owner, so nobody else can even see the ids).
 *
 * Pure. ASCII only.
 */

import { parseBookingSettings, type BookingSettings } from "./hours";

export type BookingSettingsEdit =
  | { ok: true; settings: BookingSettings }
  | { ok: false; status: 400 | 403; error: "not_a_host" | "invalid_settings" | "host_not_on_roster" | "calendar_not_yours" };

export function applyBookingSettingsEdit(input: {
  current: BookingSettings;
  submitted: unknown;
  callerUserId: string;
  rosterUserIds: ReadonlySet<string>;
  callerCalendarIds: ReadonlySet<string>;
}): BookingSettingsEdit {
  if (!input.current.hosts.some((host) => host.userId === input.callerUserId)) {
    return { ok: false, status: 403, error: "not_a_host" };
  }
  const parsed = parseBookingSettings(input.submitted);
  if (!parsed) return { ok: false, status: 400, error: "invalid_settings" };
  if (parsed.hosts.some((host) => !input.rosterUserIds.has(host.userId))) {
    return { ok: false, status: 400, error: "host_not_on_roster" };
  }
  const previous = new Map(input.current.hosts.map((host) => [host.userId, host.targetCalendarId]));
  const hosts = [];
  for (const host of parsed.hosts) {
    if (host.userId === input.callerUserId) {
      if (host.targetCalendarId !== null && !input.callerCalendarIds.has(host.targetCalendarId)) {
        return { ok: false, status: 400, error: "calendar_not_yours" };
      }
      hosts.push(host);
    } else {
      hosts.push({ ...host, targetCalendarId: previous.get(host.userId) ?? null });
    }
  }
  return { ok: true, settings: { ...parsed, hosts } };
}
