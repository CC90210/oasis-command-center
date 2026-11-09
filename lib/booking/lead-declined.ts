import "server-only";
import { getTursoClient } from "@/lib/turso";
import { readGoogleFounderMeetingResponse, type FounderMeetingAttendeeResponse, type ReadFounderMeetingResponseInput } from "@/lib/integrations/google-calendar";

export type DeclineCheckAppointment = {
  id: string; tenant_id: string; revision?: number; scheduled_for?: string;
  assigned_to: string | null; google_event_id: string | null;
  organizer_email_snapshot: string | null; client_email_snapshot: string | null;
};
export type ReadAttendeeResponse = (input: ReadFounderMeetingResponseInput) => Promise<FounderMeetingAttendeeResponse>;
export type InviteDecision = {
  status: "declined" | "not_declined" | "unknown";
  reason: string;
  retryAt?: string;
  needsReview?: boolean;
};
export type InviteObservation = {
  response: FounderMeetingAttendeeResponse | null;
  observedAt: string;
  failures: number;
  retryAt: string | null;
};
export interface InviteStore {
  read(appointment: DeclineCheckAppointment): Promise<InviteObservation | null>;
  write(appointment: DeclineCheckAppointment, observation: InviteObservation): Promise<void>;
}

// Each meeting owns its bounded read. A slow event never changes another
// meeting's answer. The dispatcher's outer deadline bounds the whole pass.
export const RSVP_READ_BUDGET_MS = 1_000;
const RETRY_MINUTES = [1, 3, 5] as const;
const REVIEW_RECHECK_MINUTES = 30;

export const durableInviteStore: InviteStore = {
  async read(a) {
    const result = await getTursoClient().execute({
      sql: "SELECT response,observed_at,failures,retry_at FROM founder_meeting_rsvp_state WHERE tenant_id=? AND appointment_id=? AND revision=? AND event_id=?",
      args: [a.tenant_id, a.id, a.revision ?? 0, a.google_event_id ?? ""],
    });
    const row = result.rows[0];
    return row ? { response: row.response as InviteObservation["response"], observedAt: String(row.observed_at), failures: Number(row.failures), retryAt: row.retry_at ? String(row.retry_at) : null } : null;
  },
  async write(a, value) {
    const result = await getTursoClient().execute({
      sql: `INSERT INTO founder_meeting_rsvp_state (tenant_id,appointment_id,revision,event_id,response,observed_at,failures,retry_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,appointment_id,revision,event_id) DO UPDATE SET
        response=excluded.response,observed_at=excluded.observed_at,failures=excluded.failures,retry_at=excluded.retry_at
        WHERE founder_meeting_rsvp_state.observed_at<excluded.observed_at`,
      args: [a.tenant_id, a.id, a.revision ?? 0, a.google_event_id ?? "", value.response, value.observedAt, value.failures, value.retryAt],
    });
    // An older provider request may finish after a newer declined answer. It
    // must neither overwrite that answer nor authorize sending from stale data.
    if (result.rowsAffected !== 1) throw new Error("rsvp_observation_superseded");
  },
};

/** Unknown is not permission to send, and never erases a confirmed decline. */
export async function readInviteDecision(
  a: DeclineCheckAppointment,
  options: { read?: ReadAttendeeResponse; store?: InviteStore; now?: () => number; budgetMs?: number } = {},
): Promise<InviteDecision> {
  const now = (options.now ?? Date.now)();
  const store = options.store ?? durableInviteStore;
  let previous: InviteObservation | null;
  try { previous = await store.read(a); }
  catch { return { status: "unknown", reason: "rsvp_state_unavailable", retryAt: new Date(now + 60_000).toISOString() }; }
  const held = (reason: string, retryAt?: string, needsReview = false): InviteDecision => ({
    status: previous?.response === "declined" ? "declined" : "unknown", reason, retryAt, needsReview,
  });
  if (previous?.retryAt && Date.parse(previous.retryAt) > now) {
    return held("rsvp_retry_pending", previous.retryAt, previous.failures > RETRY_MINUTES.length);
  }
  let response: FounderMeetingAttendeeResponse | null = null;
  let reason = "rsvp_configuration_missing";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (a.google_event_id && a.assigned_to && a.organizer_email_snapshot && a.client_email_snapshot) {
      const answer = await Promise.race([
        (options.read ?? readGoogleFounderMeetingResponse)({ tenantId: a.tenant_id, hostUserId: a.assigned_to,
          eventId: a.google_event_id, expectedOrganizerEmail: a.organizer_email_snapshot, attendeeEmail: a.client_email_snapshot }),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), options.budgetMs ?? RSVP_READ_BUDGET_MS); }),
      ]);
      if (answer === "timeout") reason = "rsvp_timeout";
      else if (answer === "missing") reason = "rsvp_event_missing";
      else { response = answer; reason = "rsvp_verified"; }
    }
  } catch { reason = "rsvp_provider_unavailable"; }
  finally { if (timer) clearTimeout(timer); }
  const failures = response ? 0 : (previous?.failures ?? 0) + 1;
  const needsReview = failures > RETRY_MINUTES.length;
  const retryAt = response ? null : new Date(now + (RETRY_MINUTES[failures - 1] ?? REVIEW_RECHECK_MINUTES) * 60_000).toISOString();
  try {
    await store.write(a, { response: response ?? previous?.response ?? null, observedAt: new Date(now).toISOString(), failures, retryAt });
  } catch {
    // Another request may have persisted a newer reacceptance. Even a cached
    // decline cannot authorize a decline/rebook effect after losing this CAS.
    return { status: "unknown", reason: "rsvp_state_write_unverified", retryAt: new Date(now + 60_000).toISOString() };
  }
  if (!response) return held(reason, retryAt ?? undefined, needsReview);
  return { status: response === "declined" ? "declined" : "not_declined", reason };
}

/** One read per meeting revision per pass; no global fail-open switch. */
export function declineCheckForRun(options: Parameters<typeof readInviteDecision>[1] = {}): (a: DeclineCheckAppointment) => Promise<InviteDecision> {
  const seen = new Map<string, Promise<InviteDecision>>();
  return (a) => {
    const key = `${a.tenant_id}:${a.id}:${a.revision ?? 0}:${a.google_event_id ?? ""}`;
    let result = seen.get(key);
    if (!result) { result = readInviteDecision(a, options); seen.set(key, result); }
    return result;
  };
}
