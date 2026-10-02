/**
 * What the call-screen booking panel needs before it can show a form: who to
 * prefill, whether this viewer may book this lead, and in which time zone the
 * prospect lives. Server-side (imports data.ts). Pure apart from that import:
 * the route does the reads and passes the results in.
 *
 * PREFILL FOLLOWS PIPELINE'S RULES (app/pipeline/[id]/page.tsx): contact name
 * is the PERSON (contactNameFor), never the business.
 *
 * "MAY BOOK" MUST AGREE WITH THE BOOKING ROUTE (app/api/website-sales/[leadId]
 * PATCH book_founder). Do-not-call is NOT a block (Adon, 2026-10-02: "allow"):
 * the route books it when the rep confirms the owner asked for the meeting,
 * so this returns canBook with doNotCall:true and the panel asks for that
 * confirmation. A lapsed claim IS a block, judged with dnc set aside exactly
 * as the route does, because assertMayWorkLead reports do_not_call before it
 * ever looks at the lapse.
 */
import { contactNameFor, OASIS_COLD_OUTBOUND_MOTION } from "@/lib/leads/canonical-lead-fields";
import { prospectTimeZone, type ProspectZone } from "@/lib/meeting-time";
import { factsFrom, isActionableBy, isInBookOf } from "./claim";
import { toWebLead } from "./data";

export type BookingBlock =
  | "claim_released"
  | "not_yours"
  | "sales_role_required"
  | "access_check_failed"
  | "already_booked"
  | "lost"
  | "not_cold_outbound"
  | "claim_first";

export type BookingPrefill = {
  name: string;
  company: string;
  email: string;
  altEmails: string[];
  phone: string;
  altPhone: string | null;
  website: string;
};

export type BookingContext = {
  stage: string | null;
  canBook: boolean;
  blocked: BookingBlock | null;
  /** On the internal do-not-call list: booking needs the "owner asked" confirmation. */
  doNotCall: boolean;
  prefill: BookingPrefill;
  prospectZone: ProspectZone;
  meeting: { at: string; meetLink: string | null; calendarUrl: string | null } | null;
};

/** Stages from which book_founder accepts an inline qualification (lib/website-sales-workflow.ts). */
export const BOOKABLE_STAGES: ReadonlySet<string> = new Set(["assigned", "attempting_contact", "connected", "qualified"]);
const BOOKED_OR_LATER: ReadonlySet<string> = new Set([
  "founder_meeting_booked", "demo_completed", "proposal_sent", "won", "onboarding", "in_build", "client_review", "launched",
]);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function bookingPrefillFrom(data: Record<string, unknown>): BookingPrefill {
  const lead = toWebLead({ id: "", data });
  const ranked = [...lead.emails].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).map((e) => e.email.trim());
  const email = str(data.email) || ranked[0] || "";
  const altEmails = [...new Set(ranked.filter((e) => e && e.toLowerCase() !== email.toLowerCase()))].slice(0, 3);
  const phone = str(data.phone);
  const ownerPhone = str(data.owner_phone);
  const digits = (s: string) => s.replace(/\D/g, "");
  const business = str(data.company) || str(data.business_name) || str(data.name);
  return {
    name: contactNameFor(data),
    company: business,
    email,
    altEmails,
    phone,
    altPhone: ownerPhone && digits(ownerPhone) !== digits(phone) ? ownerPhone : null,
    website: str(data.website),
  };
}

/** Access result from assertMayWorkLead, reduced to what this needs. */
export type AccessVerdict = { ok: true } | { ok: false; error: string };

export function bookingContextFrom(input: {
  data: Record<string, unknown>;
  access: AccessVerdict;
  viewerUserId: string;
  now?: number;
}): BookingContext {
  const { data, access, viewerUserId } = input;
  const now = input.now ?? Date.now();
  const stage = str(data.stage) || null;
  const facts = factsFrom(data);
  const meetingAt = str(data.founder_meeting_at);
  const meeting = stage && BOOKED_OR_LATER.has(stage) && meetingAt
    ? { at: meetingAt, meetLink: str(data.google_meet_link) || null, calendarUrl: str(data.google_calendar_event_url) || null }
    : null;

  // assertMayWorkLead answers do_not_call only AFTER it established the viewer
  // works this lead, and then never checks the lapse. So do_not_call means
  // "yours, judge the lapse here"; every other failure blocks.
  let blocked: BookingBlock | null = null;
  if (!access.ok && access.error !== "do_not_call") {
    blocked =
      access.error === "claim_released" ? "claim_released"
      : access.error === "forbidden_role" || access.error === "not_found" ? "not_yours"
      : access.error === "sales_role_required" ? "sales_role_required"
      : "access_check_failed";
  } else if (
    !access.ok &&
    isInBookOf(facts, viewerUserId) &&
    !isActionableBy({ ...facts, dnc: false }, viewerUserId, now)
  ) blocked = "claim_released";
  else if (stage && BOOKED_OR_LATER.has(stage)) blocked = "already_booked";
  else if (stage === "lost") blocked = "lost";
  else if (data.sales_motion !== OASIS_COLD_OUTBOUND_MOTION) blocked = "not_cold_outbound";
  else if (!stage || !BOOKABLE_STAGES.has(stage)) blocked = "claim_first";

  return {
    stage,
    canBook: blocked === null,
    blocked,
    doNotCall: facts.dnc,
    prefill: bookingPrefillFrom(data),
    prospectZone: prospectTimeZone(str(data.state)),
    meeting,
  };
}
