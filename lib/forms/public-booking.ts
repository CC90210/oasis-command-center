import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { verifyFormLink } from "@/lib/form-links";
import { normalizePhoneE164 } from "@/lib/conversation-threading";
import { bottleneckLabel, leadRevenueAndBottleneck } from "@/lib/forms/ai-audit-format";
import { normalizeFounderMeetingWebsite } from "@/lib/website-sales-meeting";
import { AI_AUDIT_TENANT_ID, AI_AUDIT_TENANT_SLUG } from "@/lib/forms/oasis-ai-audit-seed";
import { isPublicBookingFormSlug } from "@/lib/forms/public-booking-config";
import { listGoogleCalendarBusy } from "@/lib/integrations/google-calendar";
import { getOasisPipelineAssignmentRoster, OASIS_PIPELINE_ASSIGNMENT_EMAILS } from "@/lib/team";
import { listCalendars, listEvents, type Owner } from "@/lib/calendar/store";
import type { EventRecord } from "@/lib/calendar/types";
import { OASIS_PRE_HANDOFF_STAGE_KEYS } from "@/lib/oasis-stage-meta";
import {
  bookingReadWindow,
  computeOpenSlots,
  type BookingHostRole,
  type BookingSettings,
  type BusyInterval,
  type HostBusy,
} from "@/lib/booking/hours";
import { scheduleBusyIntervals } from "@/lib/booking/schedule-busy";
import {
  bookingRoster,
  hostIdentities,
  loadBookingSettings,
  type BookingHostIdentity,
} from "@/lib/booking/settings-store";
import type { MemberRow } from "@/lib/team";

export const PUBLIC_BOOKING_TIME_ZONE = "America/Toronto";
export const PUBLIC_BOOKING_DEFAULT_DURATION_MINUTES = 15;
export const PUBLIC_BOOKING_MAX_BODY_BYTES = 8_000;

export type PublicFunnelStage = "inbound_lead" | "audit_requested" | "meeting_booked";

const BOOKABLE_PIPELINE_STAGES = new Set<string>(OASIS_PRE_HANDOFF_STAGE_KEYS);

/**
 * May a lead at this pipeline stage book through the public calendar?
 *
 * Only a prospect still before the founder handoff. A returning lead already at
 * a later stage (a founder meeting booked, won, lost, in delivery) must not get
 * a fresh booking from a form re-submit: the transition would be refused anyway
 * (`lead_stage_not_bookable`). BOTH public routes ask this one function, so the
 * availability endpoint can never advertise slots the booking endpoint will
 * categorically reject (Codex review of PR #611).
 */
export function isPublicBookingStageBookable(stage: unknown): boolean {
  return typeof stage === "string" && BOOKABLE_PIPELINE_STAGES.has(stage.trim());
}

export function isPublicFunnelReadyForBooking(lead: Record<string, unknown>): boolean {
  const stage = clean(lead.funnel_stage);
  if (stage === "audit_requested") return Boolean(clean(lead.audit_requested_at));
  if (stage === "meeting_booked") return Boolean(clean(lead.meeting_booked_at));
  return false;
}

type PublicBookingParse<T> = { success: true; data: T } | { success: false };

/** A string field, trimmed, 1..max characters long once trimmed. */
function trimmedField(max: number): (value: unknown) => string | undefined {
  return (value) => {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    return text.length >= 1 && text.length <= max ? text : undefined;
  };
}

/**
 * An anonymous request body must be a plain object holding exactly the named
 * fields and nothing else: an extra key (a smuggled `tenant_id`) fails the parse
 * rather than being ignored. Hand-rolled instead of zod: two three-field shapes
 * did not justify ~420 KiB of Worker bundle, which pushed the build past its
 * size budget.
 */
function strictBody<K extends string>(
  input: unknown,
  fields: Record<K, (value: unknown) => string | undefined>,
): PublicBookingParse<Record<K, string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { success: false };
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !Object.prototype.hasOwnProperty.call(fields, key))) {
    return { success: false };
  }
  const data = {} as Record<K, string>;
  for (const key of Object.keys(fields) as K[]) {
    const value = fields[key](record[key]);
    if (value === undefined) return { success: false };
    data[key] = value;
  }
  return { success: true, data };
}

const tokenField = trimmedField(4_096);

export const publicBookingAvailabilitySchema = {
  safeParse: (input: unknown) => strictBody(input, { token: tokenField }),
};
export const publicBookingCreateSchema = {
  safeParse: (input: unknown) => strictBody(input, {
    token: tokenField,
    starts_at: trimmedField(64),
    request_id: (value) => {
      const text = typeof value === "string" ? value.trim() : "";
      return isBookingRequestId(text) ? text : undefined;
    },
  }),
};

/** Read an anonymous request through a byte cap before JSON parsing. */
export async function readPublicBookingJson(req: Request): Promise<unknown> {
  if (!(req.headers.get("content-type") || "").toLowerCase().includes("application/json")) return undefined;
  const declared = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > PUBLIC_BOOKING_MAX_BODY_BYTES) return undefined;
  if (!req.body) return undefined;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > PUBLIC_BOOKING_MAX_BODY_BYTES) {
        await reader.cancel("body_too_large").catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildPublicFunnelLeadPatch(
  answers: Record<string, unknown>,
  stage: PublicFunnelStage,
  occurredAt = new Date().toISOString(),
): Record<string, unknown> {
  const patch: Record<string, unknown> = { funnel_stage: stage };
  const name = clean(answers.name);
  const email = clean(answers.email).toLowerCase();
  const phone = clean(answers.phone);
  const company = clean(answers.company_name) || clean(answers.company);
  const website = clean(answers.website);
  const revenue = clean(answers.revenue_band) || clean(answers.monthly_revenue);
  const teamSize = clean(answers.team_size);
  const bottleneck = bottleneckLabel(
    clean(answers.primary_bottleneck) || clean(answers.bottleneck_detail) ||
      clean(answers.leak_detail) || clean(answers.leak) || clean(answers.automation_goal),
  );
  const currentTools = clean(answers.current_tools);
  const budget = clean(answers.budget);
  const timeframe = clean(answers.timeframe);
  if (name) patch.name = name;
  if (email) patch.email = email;
  if (phone) {
    // `phone` stays as typed: lead matching and the call screens read it. The
    // canonical +1... form rides alongside for anything that dials or texts.
    patch.phone = phone;
    const e164 = normalizePhoneE164(phone);
    if (e164) patch.phone_e164 = e164;
  }
  if (budget) patch.budget = budget;
  if (timeframe) patch.timeframe = timeframe;
  if (company) {
    patch.company = company;
    patch.company_name = company;
  }
  if (website) patch.website = website;
  if (revenue) {
    patch.revenue_band = revenue;
    patch.monthly_revenue = revenue;
  }
  if (teamSize) patch.team_size = teamSize;
  if (bottleneck) patch.primary_bottleneck = bottleneck;
  if (currentTools) patch.current_tools = currentTools;
  if (stage === "inbound_lead") patch.inbound_lead_at = occurredAt;
  if (stage === "audit_requested") patch.audit_requested_at = occurredAt;
  if (stage === "meeting_booked") patch.meeting_booked_at = occurredAt;
  return patch;
}

/**
 * What the booked-call alert and the founders' handoff note say about the lead, as a
 * person reads it: "$10-50K/mo" and "sales / lead gen", never the option keys
 * "10k_50k" / "sales_leadgen" (review of #611).
 */
export function bookedLeadFacts(lead: Record<string, unknown>): { revenue: string; bottleneck: string } {
  // The one reading every sales alert shares (CC 2026-10-16: the started and
  // completed alerts now print the same two lines).
  return leadRevenueAndBottleneck(lead);
}

/**
 * The contact handed to the founder-meeting service. That service REFUSES a website
 * it cannot parse, and the audit form invites exactly such answers ("Website or social
 * handle": "@acmehvac", "none", "n/a"), so passing the raw lead made the booking fail
 * for those visitors with a misleading "availability unavailable" and no way out. The
 * website is optional and already stored on the lead as typed; an unparseable one is
 * left off the calendar invite. The phone, which the call needs, is passed through so a
 * bad one fails with its own code (invalid_client_phone).
 */
export function buildPublicBookingContact(lead: Record<string, unknown>): Record<string, unknown> {
  let website = "";
  const typed = clean(lead.website);
  if (typed) {
    try {
      website = normalizeFounderMeetingWebsite(typed) ?? "";
    } catch {
      website = "";
    }
  }
  return {
    name: clean(lead.name),
    company: clean(lead.company) || clean(lead.company_name),
    email: clean(lead.email),
    phone: clean(lead.phone_e164) || clean(lead.phone),
    website,
  };
}

type Founder = { auth_user_id: string; email: string; full_name?: string | null; display_name?: string | null };

export async function publicBookingFounders(tenantId: string): Promise<{ host: Founder; opener: Founder }> {
  const roster = await getOasisPipelineAssignmentRoster(tenantId);
  const byEmail = new Map(roster.map((member) => [member.email.trim().toLowerCase(), member]));
  const host = byEmail.get(OASIS_PIPELINE_ASSIGNMENT_EMAILS[0]);
  const opener = byEmail.get(OASIS_PIPELINE_ASSIGNMENT_EMAILS[1]);
  if (!host?.auth_user_id || !opener?.auth_user_id) throw new Error("public_booking_founders_unavailable");
  return { host: host as Founder, opener: opener as Founder };
}

/** A JSON array of non-blank strings (trimmed); anything else is empty. */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const normalized = clean(item);
    return normalized ? [normalized] : [];
  });
}

/**
 * Keep a claimed rep's ownership/credit while ensuring everyone who works the
 * booked call can see the lead: the call's organizer owns an unowned lead, and
 * the call's hosts plus both founders are collaborators. Built from the slot's
 * hosts, not two fixed founders, so a host the booking settings appoint is never
 * left off the lead they are about to run the call for (Codex review of #628).
 */
export function publicBookingOwnershipPatch(
  lead: Record<string, unknown>,
  people: { organizer: string; collaborators: string[] },
): { assigned_to: string; collaborators: string[] } {
  const assignedTo = clean(lead.assigned_to) || people.organizer;
  const collaborators = new Set([
    ...stringList(lead.collaborators),
    ...people.collaborators,
  ]);
  collaborators.delete(assignedTo);
  return { assigned_to: assignedTo, collaborators: [...collaborators] };
}

export type PublicFunnelBookingContext = {
  tenantId: string;
  formId: string;
  formSlug: string;
  formName: string;
  leadId: string;
  lead: Record<string, unknown>;
  answers: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function resolvePublicFunnelBooking(
  db: SupabaseClient,
  token: unknown,
): Promise<PublicFunnelBookingContext> {
  const verified = verifyFormLink(typeof token === "string" ? token : null);
  if (!verified.ok) throw new Error(`token_${verified.reason}`);
  const link = verified.payload;
  if (link.tenant !== AI_AUDIT_TENANT_SLUG) throw new Error("booking_form_not_found");
  const formResult = await db
    .from("forms")
    .select("id,tenant_id,slug,name,steps,enabled,tenant:tenants!inner(slug)")
    .eq("id", link.form_id)
    .eq("tenant_id", AI_AUDIT_TENANT_ID)
    .maybeSingle();
  if (formResult.error || !formResult.data) throw new Error("booking_form_not_found");
  const form = formResult.data as {
    id: string; tenant_id: string; slug: string; name?: string | null; steps?: unknown; enabled: boolean;
    tenant: { slug: string } | Array<{ slug: string }> | null;
  };
  const tenant = Array.isArray(form.tenant) ? form.tenant[0] : form.tenant;
  if (!form.enabled || !isPublicBookingFormSlug(form.slug) || tenant?.slug !== AI_AUDIT_TENANT_SLUG) {
    throw new Error("booking_form_not_found");
  }
  const submissions = await db
    .from("form_submissions")
    .select("step_index,payload")
    .eq("tenant_id", AI_AUDIT_TENANT_ID)
    .eq("form_id", form.id)
    .eq("lead_id", link.lead_id)
    .order("step_index", { ascending: true });
  if (submissions.error) throw new Error("booking_submission_read_failed");
  const rows = submissions.data || [];
  const completed = new Set(rows.map((row) => Number((row as { step_index?: unknown }).step_index)));
  const parsedSteps = Array.isArray(form.steps)
    ? form.steps
    : typeof form.steps === "string"
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(form.steps);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  if (parsedSteps.length === 0) throw new Error("booking_form_not_found");
  if (!parsedSteps.every((_, step) => completed.has(step))) throw new Error("booking_form_not_completed");
  const answers = rows.reduce<Record<string, unknown>>(
    (all, row) => ({ ...all, ...record((row as { payload?: unknown }).payload) }),
    {},
  );
  const leadResult = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", AI_AUDIT_TENANT_ID)
    .eq("entity_type", "lead")
    .eq("id", link.lead_id)
    .maybeSingle();
  if (leadResult.error || !leadResult.data) throw new Error("booking_lead_not_found");
  const lead = record((leadResult.data as { data?: unknown }).data);
  // A form_submissions row is durable before the final lifecycle merge. If that
  // merge failed and the client received 503, the row set alone must not unlock
  // availability or provider writes. Both anonymous endpoints share this gate.
  if (!isPublicFunnelReadyForBooking(lead)) throw new Error("booking_form_not_completed");
  return {
    tenantId: AI_AUDIT_TENANT_ID,
    formId: form.id,
    formSlug: form.slug,
    formName: clean(form.name) || form.slug,
    leadId: link.lead_id,
    lead,
    answers,
  };
}

/**
 * Is this OASIS booking form present and switched on? Asked by the token-free
 * open-times route (/book's calendar) and the Schedule's Booking link card, so
 * both read "live" the same way. libSQL returns booleans as 0/1.
 */
export async function publicBookingFormEnabled(db: SupabaseClient, formSlug: string): Promise<boolean> {
  const form = await db
    .from("forms")
    .select("id,enabled")
    .eq("tenant_id", AI_AUDIT_TENANT_ID)
    .eq("slug", formSlug)
    .maybeSingle();
  if (form.error) throw new Error(`booking_form_read_failed:${form.error.message}`);
  const row = form.data as { id?: string; enabled?: unknown } | null;
  return Boolean(row?.id && (row.enabled === true || row.enabled === 1));
}

/** A host as a booking sees them: who, their role on the call, and where the call lands. */
export type PublicBookingHost = BookingHostIdentity & {
  role: BookingHostRole;
  /** Schedule calendar for this host's copy of the call; null = their default calendar. */
  targetCalendarId: string | null;
};

/** One bookable start, with the hosts on duty for it (organizer first). */
export type PublicBookingSlot = { start: string; hosts: PublicBookingHost[] };

export type PublicBookingAvailabilityDeps = {
  loadSettings?: (tenantId: string) => Promise<{ settings: BookingSettings }>;
  roster?: (tenantId: string) => Promise<MemberRow[]>;
  listGoogleBusy?: typeof listGoogleCalendarBusy;
  listScheduleEvents?: (owner: Owner) => Promise<EventRecord[]>;
};

async function scheduleEventsOf(owner: Owner): Promise<EventRecord[]> {
  const { events, truncated } = await listEvents(owner);
  // Same rule as the Google read: rows we could not see may be busy time, and
  // offering a slot over unseen busy time double-books a founder.
  if (truncated) throw new Error("schedule_events_truncated");
  return events;
}

function hostsFromSettings(
  settings: BookingSettings,
  identities: Map<string, BookingHostIdentity>,
): Array<PublicBookingHost | null> {
  return settings.hosts.map((host) => {
    const identity = identities.get(host.userId);
    return identity ? { ...identity, role: host.role, targetCalendarId: host.targetCalendarId } : null;
  });
}

/**
 * Every slot a visitor may book for a call of `durationMinutes`.
 *
 * Hours come from the workspace's booking settings (lib/booking/hours.ts):
 * per host, so "CC and Adon Sunday to Thursday, CC alone on Friday and
 * Saturday" is one rule. Busy time per host = their Google calendar plus their
 * own Schedule (minus the weekly routine). The organizer's calendar must be
 * readable or nothing is offered (the error says why). An attendee whose
 * calendar cannot be read closes only the slots they are on duty for.
 */
export async function loadPublicBookingAvailability(
  input: { tenantId: string; durationMinutes?: number; now?: number },
  deps: PublicBookingAvailabilityDeps = {},
): Promise<PublicBookingSlot[]> {
  const now = input.now ?? Date.now();
  const durationMinutes = input.durationMinutes ?? PUBLIC_BOOKING_DEFAULT_DURATION_MINUTES;
  const { settings } = await (deps.loadSettings ?? ((tenantId: string) => loadBookingSettings(tenantId)))(input.tenantId);
  const roster = await (deps.roster ?? ((tenantId: string) => bookingRoster(tenantId)))(input.tenantId);
  const hosts = hostsFromSettings(settings, hostIdentities(roster));
  const organizerIndex = settings.hosts.findIndex((host) => host.role === "organizer");
  if (organizerIndex < 0 || !hosts[organizerIndex]) throw new Error("public_booking_founders_unavailable");

  const { timeMin, timeMax } = bookingReadWindow(settings, now, durationMinutes);
  const listGoogleBusy = deps.listGoogleBusy ?? listGoogleCalendarBusy;
  const listScheduleEvents = deps.listScheduleEvents ?? scheduleEventsOf;
  const busyByHost = new Map<string, HostBusy>();
  await Promise.all(settings.hosts.map(async (configured, index) => {
    const host = hosts[index];
    try {
      if (!host) throw new Error("booking_host_not_on_roster");
      const [google, schedule] = await Promise.all([
        listGoogleBusy({
          tenantId: input.tenantId,
          organizerUserId: host.userId,
          expectedOrganizerEmail: host.email,
          timeMin: new Date(timeMin).toISOString(),
          timeMax: new Date(timeMax).toISOString(),
        }),
        listScheduleEvents({ tenantId: input.tenantId, userId: host.userId }),
      ]);
      const busy: BusyInterval[] = google
        .map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end) }))
        .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
      busy.push(...scheduleBusyIntervals(schedule, timeMin, timeMax, settings.timeZone));
      busyByHost.set(configured.userId, busy);
    } catch (error) {
      if (configured.role === "organizer") throw error;
      // Fail closed for this attendee's on-duty slots only; the organizer's
      // solo hours (CC on Friday and Saturday) stay bookable.
      console.error("[public-booking.attendee-busy-unavailable]", {
        userId: configured.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      busyByHost.set(configured.userId, "unavailable");
    }
  }));

  const byId = new Map(hosts.flatMap((host) => (host ? [[host.userId, host] as const] : [])));
  return computeOpenSlots({ settings, now, durationMinutes, busyByHost }).map((slot) => ({
    start: slot.start,
    hosts: slot.hostIds.flatMap((id) => {
      const host = byId.get(id);
      return host ? [host] : [];
    }),
  }));
}

/**
 * The hosts a stored booking was made with, for repairing its Schedule copies
 * on a replay. Unknown ids are dropped; with none left, the organizer.
 */
export async function publicBookingHostsById(
  tenantId: string,
  ids: string[],
  deps: Pick<PublicBookingAvailabilityDeps, "loadSettings" | "roster"> = {},
): Promise<PublicBookingHost[]> {
  const { settings } = await (deps.loadSettings ?? ((t: string) => loadBookingSettings(t)))(tenantId);
  const identities = hostIdentities(await (deps.roster ?? ((t: string) => bookingRoster(t)))(tenantId));
  const configured = new Map(settings.hosts.map((host) => [host.userId, host]));
  const resolve = (id: string): PublicBookingHost | null => {
    const identity = identities.get(id);
    if (!identity) return null;
    const host = configured.get(id);
    return { ...identity, role: host?.role ?? "attendee", targetCalendarId: host?.targetCalendarId ?? null };
  };
  const found = ids.flatMap((id) => {
    const host = resolve(id);
    return host ? [host] : [];
  });
  if (found.length) return found;
  const organizer = settings.hosts.find((host) => host.role === "organizer");
  const fallback = organizer ? resolve(organizer.userId) : null;
  if (!fallback) throw new Error("public_booking_founders_unavailable");
  return [fallback];
}

/**
 * Copy a booked call onto each host's Schedule, on the calendar their booking
 * settings name (CC's "Meetings"), else their default calendar. Before
 * 2026-10-16 every copy went to the default calendar, which for CC is a hidden
 * one, so booked calls never showed on his Schedule.
 */
export async function mirrorPublicBookingToSchedules(input: {
  db: SupabaseClient;
  tenantId: string;
  leadId: string;
  appointmentId: string;
  providerEventId: string;
  meetUrl: string;
  startsAt: string;
  endsAt: string;
  prospectName: string;
  company: string;
  formName: string;
  prospectEmail: string;
  hosts: Array<Pick<PublicBookingHost, "userId" | "email" | "targetCalendarId">>;
}): Promise<void> {
  const now = new Date().toISOString();
  const guests = [input.prospectEmail, ...input.hosts.map((host) => host.email)].filter(Boolean);
  for (const host of input.hosts) {
    const owner = { tenantId: input.tenantId, userId: host.userId };
    const calendars = await listCalendars(owner);
    const calendar =
      (host.targetCalendarId ? calendars.find((item) => item.id === host.targetCalendarId) : undefined) ||
      calendars.find((item) => item.isDefault) ||
      calendars[0];
    if (!calendar) throw new Error("public_booking_schedule_calendar_missing");
    const digest = createHash("sha256")
      .update(`public-booking:${input.tenantId}:${input.appointmentId}:${host.userId}`, "utf8")
      .digest("hex");
    const row = {
      id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
      tenant_id: input.tenantId,
      user_id: host.userId,
      calendar_id: calendar.id,
      title: `${input.formName} - ${input.company || input.prospectName || "Prospect"}`,
      description: `Lead ${input.leadId}\n${input.meetUrl}`,
      location: input.meetUrl,
      all_day: 0,
      start_at: input.startsAt,
      end_at: input.endsAt,
      time_zone: PUBLIC_BOOKING_TIME_ZONE,
      recurrence: null,
      exdates: "[]",
      recurring_event_id: null,
      original_start: null,
      color: "tide",
      reminders: "[10]",
      guests: JSON.stringify(guests),
      busy: 1,
      lead_id: input.leadId,
      appointment_id: input.appointmentId,
      provider: "google_calendar",
      provider_event_id: input.providerEventId,
      created_at: now,
      updated_at: now,
    };
    const saved = await input.db.from("calendar_events").upsert(row, { onConflict: "id" });
    if (saved.error) throw new Error(`public_booking_schedule_write_failed:${saved.error.message}`);
  }
}

export async function removePublicBookingScheduleMirrors(input: {
  db: SupabaseClient;
  tenantId: string;
  appointmentId: string;
}): Promise<void> {
  const removed = await input.db
    .from("calendar_events")
    .delete()
    .eq("tenant_id", input.tenantId)
    .eq("appointment_id", input.appointmentId);
  if (removed.error) throw new Error(`public_booking_schedule_cleanup_failed:${removed.error.message}`);
}

/** Durable Sales event for a booked COMMAND/FLEET form (AI audit has its own event vocabulary). */
export async function ensurePublicFunnelBookingEvent(input: {
  db: SupabaseClient;
  tenantId: string;
  formId: string;
  formSlug: string;
  leadId: string;
  startsAt: string;
  meetUrl: string;
  appointmentId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const digest = createHash("sha256")
      .update(
        // Per appointment, so a cancelled-and-rebooked lead gets a fresh event.
        `oasis-public-funnel-booked:v1:${input.tenantId}:${input.formId}:${input.leadId}:${input.appointmentId}`,
        "utf8",
      )
      .digest("hex");
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const saved = await input.db.from("agent_events").upsert(
      {
        id,
        event_type: "OASIS_FUNNEL_BOOKED",
        publisher_agent: "dept:sales",
        target_agent: "dept:sales",
        severity: "info",
        payload: {
          tenant_id: input.tenantId,
          form_id: input.formId,
          form_slug: input.formSlug,
          lead_id: input.leadId,
          lifecycle: "warm_inbound",
          booking_status: "booked",
          starts_at: input.startsAt,
          meet_url: input.meetUrl,
          appointment_id: input.appointmentId,
        },
        correlation_id: input.tenantId,
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (saved.error) return { ok: false, error: saved.error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function isBookingRequestId(value: unknown): value is string {
  const text = clean(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text);
}
