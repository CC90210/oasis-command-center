/**
 * /calendar — the rep's own commitments, by day.
 *
 * Operator ask (Adon, 2026-08-24): a calendar inside the software for tracking
 * meetings, with Google Calendar carrying the phone notification. See
 * components/calendar/RepCalendar.tsx for why this exists beside Rep Today
 * rather than replacing it.
 *
 * THIS PAGE MAKES NO ACCESS DECISION OF ITS OWN. It asks
 * `resolveViewerSurface()` who is standing here and renders the rep calendar
 * only for the "sales" persona -- the same resolver every other page uses, so
 * a role change lands everywhere at once instead of needing a new branch here.
 * Anyone else is redirected home rather than shown an empty calendar, because
 * an empty calendar reads as "you have nothing booked" and that would be a lie
 * to a founder whose meetings live elsewhere.
 */

import { redirect } from "next/navigation";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";
import { RepCalendar } from "@/components/calendar/RepCalendar";
import { isCalendarConnected } from "@/lib/integrations/google-calendar";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const surface = await resolveViewerSurface();
  if (!surface.ok) redirect("/login");
  if (surface.persona !== "sales") redirect("/");

  // Presence of a stored connection, used ONLY to decide whether to show the
  // "get these on your phone" invitation. It is deliberately not proof that a
  // push will succeed -- a stored token can still be revoked -- and nothing on
  // this page reports a reminder as delivered.
  const calendarConnected = await isCalendarConnected(surface.tenantId, surface.userId).catch(() => false);

  return (
    <RepCalendar
      tenantId={surface.tenantId}
      userId={surface.userId}
      teamRole={surface.teamRole}
      calendarConnected={calendarConnected}
    />
  );
}
