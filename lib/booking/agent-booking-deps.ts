/**
 * lib/booking/agent-booking-deps.ts - the real dependencies the booking agent routes (lib/booking/agent-booking.ts)
 * run with: the website booking's own availability, meeting service, Schedule copies, lead matching and sales-desk
 * alert. Kept apart from the handlers so the tests drive every path without Google, Turso or Telegram.
 */
import "server-only";
import { after } from "next/server";
import type { AgentBookingDeps, AgentBookingSource } from "@/lib/booking/agent-booking";
import { AGENT_BOOKING_SOURCES } from "@/lib/booking/agent-booking";
import { bookingCallRecorded, bookingMeetRoomDeps } from "@/lib/booking/meet-room";
import { recordAlertFailure } from "@/lib/forms/alert-failure";
import { findExistingLead } from "@/lib/forms/agent-routing";
import { pipelineLeadUrl } from "@/lib/forms/lead-link";
import {
  loadPublicBookingAvailability,
  mirrorPublicBookingToSchedules,
  publicBookingHostsById,
  removePublicBookingScheduleMirrors,
} from "@/lib/forms/public-booking";
import { buildBookedLeadAlert } from "@/lib/forms/public-booking-alert";
import { createRecord } from "@/lib/manifest/data";
import { pushWorkspaceAlert } from "@/lib/notify/alert-route";
import { publicAppBaseUrl } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTursoClient } from "@/lib/turso";
import {
  activateVerifiedFounderMeeting,
  compensatePendingFounderMeetingBooking,
  createVerifiedFounderMeeting,
} from "@/lib/website-sales-founder-meeting";

/** The marker a failed sales-desk alert leaves on the lead; never a funnel's own idempotency source. */
const ALERT_FAILURE_SOURCE = "booking_agent";

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The offer pages a visitor can open right now: the form is on and its page is live (readPublicOfferState's rule). */
async function liveOffers(tenantId: string): Promise<Array<{ slug: string; name: string }>> {
  const rs = await getTursoClient().execute({
    sql: `SELECT f.slug, f.name FROM forms f
            JOIN form_offer_pages o ON o.tenant_id = f.tenant_id AND o.form_id = f.id
           WHERE f.tenant_id = ? AND f.enabled = 1 AND o.live = 1 AND o.published IS NOT NULL
           ORDER BY f.slug`,
    args: [tenantId],
  });
  return rs.rows.map((row) => ({ slug: String(row.slug), name: String(row.name ?? row.slug) }));
}

export function liveAgentBookingDeps(): AgentBookingDeps {
  const db = getServiceSupabase();
  const rooms = bookingMeetRoomDeps();
  return {
    env: process.env,
    now: () => new Date(),
    db,
    baseUrl: publicAppBaseUrl(),
    availability: (tenantId, durationMinutes) => loadPublicBookingAvailability({ tenantId, durationMinutes }),
    hostsById: (tenantId, ids) => publicBookingHostsById(tenantId, ids),
    liveOffers,
    readLead: async (tenantId, leadId) => {
      const result = await db
        .from("tenant_records")
        .select("id,data")
        .eq("tenant_id", tenantId)
        .eq("entity_type", "lead")
        .eq("id", leadId)
        .maybeSingle();
      if (result.error) throw new Error(`lead_read_failed:${result.error.message}`);
      const row = result.data as { id?: string; data?: unknown } | null;
      return row?.id ? { id: row.id, data: record(row.data) } : null;
    },
    // An address or a phone the person typed, never a company name (the public intake's rule). The company still goes
    // in: it is what refuses a phone match to another business's lead (Codex on the booking agent PR).
    findLead: (tenantId, match) => findExistingLead(tenantId, match, { matchOnBusinessName: false }),
    createLead: async (tenantId, data) => createRecord({ tenant_id: tenantId, entity: "lead", data }),
    createMeeting: (input) => createVerifiedFounderMeeting(input, rooms),
    compensate: async ({ tenantId, leadId, requestId, appointmentId }) => {
      let compensated = false;
      try {
        await compensatePendingFounderMeetingBooking({ tenantId, leadId, appointmentId, requestId }, rooms);
        compensated = true;
      } catch (error) {
        console.error("[booking-agent.compensate.calendar]", error);
      }
      try {
        await removePublicBookingScheduleMirrors({ db, tenantId, appointmentId });
      } catch (error) {
        console.error("[booking-agent.compensate.schedule]", error);
      }
      return compensated;
    },
    mirror: (input) => mirrorPublicBookingToSchedules({ db, ...input }),
    activate: (tenantId, appointmentId) => activateVerifiedFounderMeeting(tenantId, appointmentId),
    callRecorded: (tenantId, meetUrl) => bookingCallRecorded(tenantId, meetUrl),
    alert: async ({ tenantId, leadId, source, name, company, note, startsAt, meetUrl }) => {
      const label = `${AGENT_BOOKING_SOURCES[source as AgentBookingSource]} call`;
      const sent = await pushWorkspaceAlert(
        tenantId,
        buildBookedLeadAlert({
          offerName: label,
          name,
          company,
          revenue: "",
          bottleneck: note,
          startsAt,
          meetUrl,
          leadUrl: pipelineLeadUrl(leadId),
        }),
        { desk: "sales" },
      );
      if (!sent.delivered) {
        await recordAlertFailure({
          db,
          tenantId,
          leadId,
          source: ALERT_FAILURE_SOURCE,
          label: `${label} (booked)`,
          reason: sent.outcome,
          extra: "The call is on the calendar; the video call link is on the lead.",
          tag: "booking-agent.telegram",
        });
      }
    },
    later: (work) => after(work),
  };
}
