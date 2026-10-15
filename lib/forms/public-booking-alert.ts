/**
 * lib/forms/public-booking-alert.ts - the sales-desk alert for a call a prospect
 * just booked on the inline calendar.
 *
 * Pure (no server-only import) so the exact text is unit-tested. Every value a
 * stranger typed is HTML-escaped and length-capped: the alert goes to a Telegram
 * group, where a long or hostile "bottleneck" is read by people AND by agents.
 */
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { PUBLIC_BOOKING_TIME_ZONE } from "@/lib/forms/public-booking";

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

/** Google Meet links only: anything else is shown as text, never as a link. */
function isMeetUrl(url: string): boolean {
  return /^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.test(url);
}

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
  const cap = (s: string, n: number) => e(s.trim().slice(0, n));
  const lines = [
    `📅 <b>${cap(input.offerName, 120)} booked</b>`,
    `<b>${cap(input.name || "New lead", 120)}</b>${input.company ? ` - ${cap(input.company, 120)}` : ""}`,
    input.revenue ? `Revenue: ${cap(input.revenue, 120)}` : "Revenue: not provided",
    input.bottleneck ? `Bottleneck: ${cap(input.bottleneck, 300)}` : "Bottleneck: not provided",
    `Call: ${e(formatBookedTime(input.startsAt))}`,
    isMeetUrl(input.meetUrl)
      ? `<a href="${input.meetUrl}">Open Google Meet</a>`
      : `Meet: ${cap(input.meetUrl, 200)}`,
    `<a href="${input.leadUrl}">Open the lead in Command Center</a>`,
  ];
  return lines.join("\n");
}
