import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { verifyFormLink } from "@/lib/form-links";
import { normalizePhoneE164 } from "@/lib/conversation-threading";
import { AI_AUDIT_TENANT_ID, AI_AUDIT_TENANT_SLUG } from "@/lib/forms/oasis-ai-audit-seed";
import { isPublicBookingFormSlug } from "@/lib/forms/public-booking-config";
import { listGoogleCalendarBusy, type GoogleBusyInterval } from "@/lib/integrations/google-calendar";
import { getOasisPipelineAssignmentRoster, OASIS_PIPELINE_ASSIGNMENT_EMAILS } from "@/lib/team";
import { listCalendars } from "@/lib/calendar/store";

export const PUBLIC_BOOKING_TIME_ZONE = "America/Toronto";
export const PUBLIC_BOOKING_DEFAULT_DURATION_MINUTES = 15;
export const PUBLIC_BOOKING_DAYS = 14;
export const PUBLIC_BOOKING_MIN_LEAD_MINUTES = 120;
export const PUBLIC_BOOKING_MAX_BODY_BYTES = 8_000;
const PUBLIC_BOOKING_STEP_MINUTES = 30;
const PUBLIC_BOOKING_START_HOUR = 9;
const PUBLIC_BOOKING_END_HOUR = 17;

export type PublicFunnelStage = "inbound_lead" | "audit_requested" | "meeting_booked";

export function isPublicFunnelReadyForBooking(lead: Record<string, unknown>): boolean {
  const stage = clean(lead.funnel_stage);
  if (stage === "audit_requested") return Boolean(clean(lead.audit_requested_at));
  if (stage === "meeting_booked") return Boolean(clean(lead.meeting_booked_at));
  return false;
}

const tokenField = z.string().trim().min(1).max(4_096);

export const publicBookingAvailabilitySchema = z.object({ token: tokenField }).strict();
export const publicBookingCreateSchema = z.object({
  token: tokenField,
  starts_at: z.string().trim().min(1).max(64),
  request_id: z.string().trim().refine(isBookingRequestId),
}).strict();

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
  const bottleneck = clean(answers.primary_bottleneck) || clean(answers.bottleneck_detail) ||
    clean(answers.leak_detail) || clean(answers.leak) || clean(answers.automation_goal);
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

const torontoParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: PUBLIC_BOOKING_TIME_ZONE,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function localParts(instant: number): { weekday: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    torontoParts.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return {
    weekday: parts.weekday || "",
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function slotBounds(options: { now: number; days: number }): { first: number; last: number } {
  const step = PUBLIC_BOOKING_STEP_MINUTES * 60_000;
  const firstPossible = options.now + PUBLIC_BOOKING_MIN_LEAD_MINUTES * 60_000;
  return {
    first: Math.ceil(firstPossible / step) * step,
    last: options.now + options.days * 24 * 60 * 60_000,
  };
}

export function isPublicBookingSlot(
  value: string,
  options: { now?: number; days?: number; durationMinutes?: number } = {},
): boolean {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;
  const bounds = slotBounds({ now: options.now ?? Date.now(), days: options.days ?? PUBLIC_BOOKING_DAYS });
  if (instant < bounds.first || instant > bounds.last) return false;
  const local = localParts(instant);
  if (["Sat", "Sun"].includes(local.weekday)) return false;
  if (local.minute !== 0 && local.minute !== 30) return false;
  const durationMinutes = options.durationMinutes ?? PUBLIC_BOOKING_DEFAULT_DURATION_MINUTES;
  const localStartMinutes = local.hour * 60 + local.minute;
  return localStartMinutes >= PUBLIC_BOOKING_START_HOUR * 60 &&
    localStartMinutes + durationMinutes <= PUBLIC_BOOKING_END_HOUR * 60;
}

export function buildPublicBookingSlots(options: {
  now?: number;
  days?: number;
  durationMinutes?: number;
  busy: GoogleBusyInterval[];
}): string[] {
  const now = options.now ?? Date.now();
  const days = options.days ?? PUBLIC_BOOKING_DAYS;
  const { first, last } = slotBounds({ now, days });
  const step = PUBLIC_BOOKING_STEP_MINUTES * 60_000;
  const durationMinutes = options.durationMinutes ?? PUBLIC_BOOKING_DEFAULT_DURATION_MINUTES;
  const duration = durationMinutes * 60_000;
  const busy = options.busy
    .map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end) }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
  const slots: string[] = [];
  for (let instant = first; instant <= last; instant += step) {
    const iso = new Date(instant).toISOString();
    if (!isPublicBookingSlot(iso, { now, days, durationMinutes })) continue;
    if (busy.some((item) => item.start < instant + duration && item.end > instant)) continue;
    slots.push(iso);
  }
  return slots;
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const normalized = clean(item);
    return normalized ? [normalized] : [];
  });
}

/** Keep a claimed rep's ownership/credit while ensuring both founders can work the booked call. */
export function publicBookingOwnershipPatch(
  lead: Record<string, unknown>,
  founders: { host: Founder; opener: Founder },
): { assigned_to: string; collaborators: string[] } {
  const assignedTo = clean(lead.assigned_to) || founders.host.auth_user_id;
  const collaborators = new Set([
    ...stringList(lead.collaborators),
    founders.host.auth_user_id,
    founders.opener.auth_user_id,
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

export async function loadPublicBookingSlots(input: {
  tenantId: string;
  founders: { host: Founder; opener: Founder };
  durationMinutes?: number;
  now?: number;
}): Promise<string[]> {
  const now = input.now ?? Date.now();
  const durationMinutes = input.durationMinutes ?? PUBLIC_BOOKING_DEFAULT_DURATION_MINUTES;
  const timeMin = new Date(now + PUBLIC_BOOKING_MIN_LEAD_MINUTES * 60_000).toISOString();
  // Google's events.list `timeMax` bounds an event's START. The last bookable
  // slot starts at about now + PUBLIC_BOOKING_DAYS and runs `durationMinutes`
  // past that, so a founder event starting inside that tail would not be
  // returned and the slot would be offered, then accepted again by the booking
  // route (it re-reads with this same window): a client booked over a founder's
  // event. The window therefore reaches one meeting length past the last start.
  const timeMax = new Date(
    now + PUBLIC_BOOKING_DAYS * 24 * 60 * 60_000 + durationMinutes * 60_000,
  ).toISOString();
  const busy = await Promise.all([
    listGoogleCalendarBusy({
      tenantId: input.tenantId,
      organizerUserId: input.founders.host.auth_user_id,
      expectedOrganizerEmail: input.founders.host.email,
      timeMin,
      timeMax,
    }),
    listGoogleCalendarBusy({
      tenantId: input.tenantId,
      organizerUserId: input.founders.opener.auth_user_id,
      expectedOrganizerEmail: input.founders.opener.email,
      timeMin,
      timeMax,
    }),
  ]);
  return buildPublicBookingSlots({
    now,
    busy: busy.flat(),
    durationMinutes,
  });
}

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
  founders: { host: Founder; opener: Founder };
}): Promise<void> {
  const now = new Date().toISOString();
  for (const founder of [input.founders.host, input.founders.opener]) {
    const owner = { tenantId: input.tenantId, userId: founder.auth_user_id };
    const calendars = await listCalendars(owner);
    const calendar = calendars.find((item) => item.isDefault) || calendars[0];
    if (!calendar) throw new Error("public_booking_schedule_calendar_missing");
    const digest = createHash("sha256")
      .update(`public-booking:${input.tenantId}:${input.appointmentId}:${founder.auth_user_id}`, "utf8")
      .digest("hex");
    const row = {
      id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
      tenant_id: input.tenantId,
      user_id: founder.auth_user_id,
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
      guests: JSON.stringify([input.prospectEmail, input.founders.host.email, input.founders.opener.email]),
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
        `oasis-public-funnel-booked:v1:${input.tenantId}:${input.formId}:${input.leadId}`,
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
