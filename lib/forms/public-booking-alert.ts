/**
 * lib/forms/public-booking-alert.ts - the sales-desk alert for a call a prospect
 * just booked on the inline calendar.
 *
 * Pure (no server-only import) so the exact text is unit-tested. Every value a
 * stranger typed is HTML-escaped and length-capped: the alert goes to a Telegram
 * group, where a long or hostile "bottleneck" is read by people AND by agents.
 */
import { clipAndEscape, escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { PUBLIC_BOOKING_TIME_ZONE } from "@/lib/forms/public-booking";
import { isMeetingLink } from "@/lib/website-sales-meeting";

const when = new Intl.DateTimeFormat("en-CA", {
  timeZone: PUBLIC_BOOKING_TIME_ZONE,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/** "Thu, Oct 16, 2:30 p.m. EDT". Falls back to the raw value if it is not a date. */
export function formatBookedTime(startsAtIso: string): string {
  const d = new Date(startsAtIso);
  return Number.isNaN(d.getTime()) ? startsAtIso : when.format(d);
}

/** Known video-call links only: anything else is shown as text, never as a link. */
function isMeetUrl(url: string): boolean {
  return isMeetingLink(url);
}

const CALENDAR_EMOJI = String.fromCodePoint(0x1f4c5);

export function buildBookedLeadAlert(input: {
  offerName: string;
  name: string;
  company: string;
  revenue: string;
  bottleneck: string;
  startsAt: string;
  meetUrl: string;
  leadUrl: string;
}): string {
  const e = escapeTelegramHtml;
  const cap = clipAndEscape;
  const lines = [
    `${CALENDAR_EMOJI} <b>${cap(input.offerName, 120)} booked</b>`,
    `<b>${cap(input.name || "New lead", 120)}</b>${input.company ? ` - ${cap(input.company, 120)}` : ""}`,
    input.revenue ? `Revenue: ${cap(input.revenue, 120)}` : "Revenue: not provided",
    input.bottleneck ? `Bottleneck: ${cap(input.bottleneck, 300)}` : "Bottleneck: not provided",
    `Call: ${e(formatBookedTime(input.startsAt))}`,
    isMeetUrl(input.meetUrl)
      ? `<a href="${input.meetUrl}">Open video call</a>`
      : `Video call: ${cap(input.meetUrl, 200)}`,
    `<a href="${input.leadUrl}">Open the lead in Command Center</a>`,
  ];
  return lines.join("\n");
}

/**
 * Why a /book visitor left details without picking a time (sent by the page:
 * which "Leave your details instead" button it was). Shown, never trusted for
 * anything else.
 */
export type DetailsOnlyReason = "calendar_error" | "no_times";

/**
 * The sales-desk alert for a /book visitor who asked for a call and could not
 * pick a time: the calendar would not load, or every time was taken. Nobody is
 * booked, so a person has to reach out (e9's call, 2026-10-17).
 */
export function buildDetailsOnlyLeadAlert(input: {
  offerName: string;
  name: string;
  company: string;
  reason: DetailsOnlyReason;
  leadUrl: string;
}): string {
  const cap = clipAndEscape;
  const why =input.reason === "no_times" ? "Every open time was taken" : "The calendar would not load";
  return [
    `<b>${cap(input.offerName, 120)}: details left, no time picked</b>`,
    `<b>${cap(input.name || "New lead", 120)}</b>${input.company ? ` - ${cap(input.company, 120)}` : ""}`,
    `${why}, so they asked us to set the time. Reach out and book them.`,
    `<a href="${input.leadUrl}">Open the lead in Command Center</a>`,
  ].join("\n");
}
