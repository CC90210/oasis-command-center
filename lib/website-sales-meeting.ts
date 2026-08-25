const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GOOGLE_MEET_RE = /^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i;

export const FOUNDER_MEETING_TIMEZONE = "America/Toronto";
export const FOUNDER_MEETING_DURATION_MINUTES = 15;
export const FOUNDER_MEETING_TRANSITION_HOLD_MINUTES = 15;

export type FounderMeetingContact = {
  name: string | null;
  company: string | null;
  email: string;
  phone: string | null;
  website: string | null;
};

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function normalizePhone(value: unknown): string | null {
  const raw = optionalText(value, 80);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  throw new Error("invalid_client_phone");
}

function normalizeWebsite(value: unknown): string | null {
  const raw = optionalText(value, 500);
  if (!raw) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname.includes(".")) {
      throw new Error("invalid_client_website");
    }
    return parsed.toString();
  } catch {
    throw new Error("invalid_client_website");
  }
}

export function normalizeFounderMeetingContact(input: Record<string, unknown>): FounderMeetingContact {
  const email = optionalText(input.email, 320)?.toLowerCase() || "";
  if (!EMAIL_RE.test(email)) throw new Error("client_email_required");
  return {
    name: optionalText(input.name, 200),
    company: optionalText(input.company, 300),
    email,
    phone: normalizePhone(input.phone),
    website: normalizeWebsite(input.website),
  };
}

export function validateGoogleMeetLink(value: unknown): string {
  const link = optionalText(value, 500) || "";
  if (!GOOGLE_MEET_RE.test(link)) throw new Error("google_meet_link_missing");
  return link;
}

export function reminderDueAt(meetingAt: string, minutesBefore: number): string {
  const epoch = Date.parse(meetingAt);
  if (!Number.isFinite(epoch)) throw new Error("invalid_meeting_time");
  return new Date(epoch - minutesBefore * 60_000).toISOString();
}

export function founderMeetingDedupeKey(
  appointmentId: string,
  revision: number,
  kind: "confirmation" | "ten_minute",
  channel: "email" | "sms",
): string {
  return `${appointmentId}:${revision}:${kind}:${channel}`;
}

export function meetingNotificationDecision(input: {
  workflowStatus: string;
  appointmentStatus: string;
  calendarStatus: string;
  appointmentRevision: number;
  notificationRevision: number;
  meetingAt: string;
  now: string;
  transitionStartedAt?: string | null;
}): "hold" | "skip" | "send" {
  const meetingEpoch = Date.parse(input.meetingAt);
  const nowEpoch = Date.parse(input.now);
  if (
    input.appointmentStatus !== "scheduled" ||
    input.calendarStatus !== "verified" ||
    input.appointmentRevision !== input.notificationRevision ||
    !Number.isFinite(meetingEpoch) ||
    !Number.isFinite(nowEpoch) ||
    meetingEpoch <= nowEpoch
  ) return "skip";
  if (input.workflowStatus === "active") return "send";
  if (input.workflowStatus !== "pending_transition") return "skip";

  const transitionEpoch = Date.parse(input.transitionStartedAt || "");
  const ageMs = nowEpoch - transitionEpoch;
  const holdMs = FOUNDER_MEETING_TRANSITION_HOLD_MINUTES * 60_000;
  if (!Number.isFinite(transitionEpoch) || ageMs < 0 || ageMs > holdMs) return "skip";
  return "hold";
}

export function minutesUntilMeeting(meetingAt: string, now: string): number {
  const meetingEpoch = Date.parse(meetingAt);
  const nowEpoch = Date.parse(now);
  if (!Number.isFinite(meetingEpoch) || !Number.isFinite(nowEpoch)) {
    throw new Error("invalid_meeting_time");
  }
  return Math.max(0, Math.ceil((meetingEpoch - nowEpoch) / 60_000));
}

function displayMeetingTime(meetingAt: string, timezone: string): string {
  const instant = new Date(meetingAt);
  if (Number.isNaN(instant.getTime())) throw new Error("invalid_meeting_time");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}

export function buildFounderMeetingMessages(input: {
  company: string | null;
  contactName: string | null;
  meetingAt: string;
  timezone: string;
  meetLink: string;
  clientAgenda: string;
  reminderMinutesBefore?: number;
}) {
  const meetLink = validateGoogleMeetLink(input.meetLink);
  const when = displayMeetingTime(input.meetingAt, input.timezone);
  const label = input.company || input.contactName || "your business";
  const greeting = input.contactName ? `Hi ${input.contactName},` : "Hello,";
  const reminderMinutes = Number.isInteger(input.reminderMinutesBefore) && Number(input.reminderMinutesBefore) > 0
    ? Number(input.reminderMinutesBefore)
    : 10;
  const reminderWindow = `${reminderMinutes} ${reminderMinutes === 1 ? "minute" : "minutes"}`;
  const reminderBody = [
    greeting,
    "",
    `Your 15-minute OASIS website audit for ${label} starts in ${reminderWindow} (${when}).`,
    `Join Google Meet: ${meetLink}`,
    "",
    `We will cover: ${input.clientAgenda}`,
  ].join("\n");
  const confirmationSms = `OASIS: your 15-minute website audit is booked for ${when}. Google Meet: ${meetLink}`;
  const reminderSms = `OASIS reminder: your website audit starts in ${reminderWindow}. Join: ${meetLink}`;
  return {
    confirmationSms,
    reminder: {
      subject: `Your OASIS website audit starts in ${reminderWindow}`,
      body: reminderBody,
      sms: reminderSms,
    },
  };
}
