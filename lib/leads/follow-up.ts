/**
 * lib/leads/follow-up.ts — scheduling a follow-up when an operator writes a note,
 * and surviving Google being unreachable when they do.
 *
 * THE ORDERING RULE, AND IT IS THE WHOLE DESIGN:
 *
 *   1. the note row            (append-only: what happened)
 *   2. the lead patch          (follow_up_at -- THE SOURCE OF TRUTH)
 *   3. the calendar push       (a MIRROR, best effort, never blocking)
 *
 * The queue owns the follow-up. The calendar is a copy of it that happens to
 * live in the operator's pocket. So a Google outage degrades the feature to
 * "it is in the app but not on your phone", which is survivable, rather than
 * losing a promise made to a prospect, which is not. Step 3 never throws and
 * never rolls back steps 1 or 2.
 *
 * WHAT DOES NOT EXIST ANYWHERE ELSE, AND IS THE REASON THIS FILE EXISTS:
 * a failed push used to be reported to the operator once and then forgotten.
 * "Saved to your queue, but it did not reach your Google Calendar" is honest,
 * but it puts the recovery on a person who is mid-call and will not come back
 * to it. A transient 503 during a note write therefore cost a phone reminder
 * permanently. Now a retryable failure is PERSISTED as `follow_up_sync_state:
 * "pending"` with a next-attempt time, and a cron drains it.
 *
 * BLOCKED IS NOT FAILED, AND THE DISTINCTION IS WHAT KEEPS THIS QUIET.
 * Only transport-shaped failures queue. An operator who never connected Google,
 * or whose grant lacks the scope, or whose refresh token was revoked, lands in
 * `"blocked"` and the worker does not touch them again. Retrying those on a
 * timer would burn quota forever, never once fix the cause, and page about it
 * every cycle. They need a person, so they are surfaced to that person instead.
 *
 * NO MIGRATION. These fields live in `tenant_records.data`, which is a JSON
 * document. Adding keys to it is not DDL. (A separate `lead_notes` table was
 * considered and rejected for the same family of reasons the notes route
 * already documents: the unified ledger is what makes notes show up in the
 * timeline and the audit trail for free.)
 */

import {
  writeReminderEvent,
  removeReminderEvent,
  isRetryableFailure,
  type ReminderFailure,
  type ReminderWriteResult,
  type ReminderVoidResult,
  type ReminderEventInput,
} from "@/lib/integrations/calendar-reminder";

/**
 * Injection seam for the tests, so the state machine below is exercised for
 * real against a scripted Google rather than asserted about as source text.
 */
export type FollowUpDeps = {
  write?: (
    tenantId: string,
    userId: string,
    existingEventId: string | null,
    input: ReminderEventInput,
  ) => Promise<ReminderWriteResult>;
  remove?: (
    tenantId: string,
    userId: string,
    eventId: string | null,
  ) => Promise<ReminderVoidResult>;
};

/** Keys written onto `tenant_records.data`. Named once so nothing drifts. */
export const FOLLOW_UP_FIELDS = {
  at: "follow_up_at",
  eventId: "follow_up_event_id",
  /**
   * WHOSE calendar the reminder lives on. Without this the retry worker knows
   * a push failed but not who to push for, and a reminder retried against the
   * wrong operator would land on a stranger's phone.
   */
  operatorUserId: "follow_up_operator_user_id",
  /**
   * An event on a PREVIOUS operator's calendar that we failed to delete.
   *
   * A lead can change hands, and an admin can schedule on someone else's lead.
   * When that happens the stored event lives on the old operator's calendar and
   * cannot be addressed through the new one: patching it there returns 404, and
   * an earlier version of this code then created a second event and overwrote
   * the id, leaving the old rep with a reminder nothing could ever clear. If
   * the handover delete fails we park the pair here instead, so the cleanup is
   * a tracked work item rather than a leak. (Codex review, 2026-08-26.)
   */
  strandedEventId: "follow_up_stranded_event_id",
  strandedOperatorUserId: "follow_up_stranded_operator_user_id",
  state: "follow_up_sync_state",
  reason: "follow_up_sync_reason",
  detail: "follow_up_sync_detail",
  attempts: "follow_up_sync_attempts",
  nextAttemptAt: "follow_up_sync_next_attempt_at",
  timeZone: "follow_up_timezone",
  summary: "follow_up_summary",
  note: "follow_up_note",
} as const;

export type FollowUpSyncState =
  /** Google holds a reminder matching `follow_up_at`. */
  | "synced"
  /** A retryable failure. The cron will try again at `follow_up_sync_next_attempt_at`. */
  | "pending"
  /** A person must act (connect, re-consent, or fix a rejected request). No retries. */
  | "blocked"
  /** No follow-up is scheduled on this lead. */
  | "off";

/**
 * Backoff for a pending sync, in minutes, indexed by attempts already made.
 *
 * It ends rather than repeating: after the last step the record goes to
 * `blocked` with `retry_exhausted`. An unbounded retry is how a dead
 * integration becomes a permanent background load nobody notices.
 *
 * These are a FLOOR, not a promise. The drain runs on the shared 15-minute
 * cron tick, so the first two rungs resolve on that tick rather than at 1 and
 * 5 minutes exactly. That is deliberate: a follow-up is normally hours or days
 * out, so minutes of drift costs nothing, and a dedicated faster tick would
 * spend a CI run every five minutes on a table that is empty except during a
 * Google outage.
 */
export const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 240, 720] as const;
/** How many retries the ladder schedules before giving up. One per rung. */
export const MAX_SYNC_ATTEMPTS = RETRY_BACKOFF_MINUTES.length;

/**
 * When to try again.
 *
 * `priorAttempts` is the count of failures BEFORE the one being recorded now,
 * so the first failure passes 0 and waits `RETRY_BACKOFF_MINUTES[0]`. Getting
 * this argument off by one silently skips the first rung of the ladder, which
 * is exactly the bug the state-machine test caught: it does not fail anything,
 * it just makes the first retry five times later than intended.
 */
export function nextAttemptAt(priorAttempts: number, fromMs: number): string | null {
  if (priorAttempts >= MAX_SYNC_ATTEMPTS) return null;
  const minutes = RETRY_BACKOFF_MINUTES[priorAttempts];
  return new Date(fromMs + minutes * 60_000).toISOString();
}

export type FollowUpSyncPatch = Record<string, unknown>;

export type FollowUpSyncOutcome = {
  /** Merge straight into the lead's `data` via updateRecord. */
  patch: FollowUpSyncPatch;
  state: FollowUpSyncState;
  /** Operator-facing line, or null when it worked and needs no announcement. */
  message: string | null;
  /** True when a NEW event replaced a dead stored id, so the id must be persisted. */
  recreated: boolean;
};

/** The lead fields this module reads. Kept narrow on purpose. */
export type FollowUpLeadContext = {
  leadId: string;
  tenantId: string;
  operatorUserId: string;
  businessName: string;
  phone?: string | null;
  leadUrl?: string | null;
  timeZone?: string | null;
};

/**
 * What the operator sees on their lock screen. Business name first: a
 * notification is read at arm's length in about a second, and "Call Rosetti
 * Plumbing" is actionable where "Lead follow up" is not.
 */
export function reminderSummary(businessName: string): string {
  const name = businessName.trim() || "lead";
  return `Call ${name}`;
}

/**
 * The private body of the reminder. This carries the operator's own note,
 * which is exactly why the event must never have an attendee.
 */
export function reminderDescription(input: {
  note: string | null;
  phone?: string | null;
  leadUrl?: string | null;
}): string {
  return [
    input.phone ? `Phone: ${input.phone}` : null,
    input.note ? `Your note: ${input.note}` : null,
    input.leadUrl ? `Open the lead: ${input.leadUrl}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function clearedPatch(): FollowUpSyncPatch {
  return {
    [FOLLOW_UP_FIELDS.at]: null,
    [FOLLOW_UP_FIELDS.eventId]: null,
    [FOLLOW_UP_FIELDS.operatorUserId]: null,
    [FOLLOW_UP_FIELDS.state]: "off",
    [FOLLOW_UP_FIELDS.reason]: null,
    [FOLLOW_UP_FIELDS.detail]: null,
    [FOLLOW_UP_FIELDS.attempts]: 0,
    [FOLLOW_UP_FIELDS.nextAttemptAt]: null,
    [FOLLOW_UP_FIELDS.summary]: null,
    [FOLLOW_UP_FIELDS.note]: null,
  };
}

/**
 * Push (or clear) this lead's follow-up reminder and describe the result.
 *
 * Call AFTER the lead write has landed, never before and never instead. The
 * returned `patch` records the sync outcome and MUST be persisted, because the
 * event id inside it is the only handle anything will ever have on that event.
 */
export async function syncFollowUpReminder(input: {
  lead: FollowUpLeadContext;
  /** The scheduled instant, or null to clear any existing reminder. */
  followUpAt: string | null;
  /** Operator note to carry on the event. */
  note: string | null;
  /** The id stored last time, or null if this lead has never had one. */
  existingEventId: string | null;
  /** Retries already made. Fresh operator writes reset this to 0. */
  attempts?: number;
  reminderMinutes?: number;
  now?: () => number;
  deps?: FollowUpDeps;
}): Promise<FollowUpSyncOutcome> {
  const nowMs = (input.now || Date.now)();
  const { lead } = input;
  const pushEvent = input.deps?.write || writeReminderEvent;
  const clearEvent = input.deps?.remove || removeReminderEvent;

  // NO FOLLOW-UP MEANS NO REMINDER. A lead that had a callback on the
  // operator's phone, then had it removed here, must not keep ringing for a
  // call the queue no longer holds. The mirror must never outlive what it
  // mirrors.
  if (!input.followUpAt) {
    const removed = await clearEvent(lead.tenantId, lead.operatorUserId, input.existingEventId);
    if (removed.ok) {
      return { patch: clearedPatch(), state: "off", message: null, recreated: false };
    }
    // The event may still be live, so KEEP the stored id. Dropping it orphans a
    // reminder that nothing could ever clear again.
    const retryable = isRetryableFailure(removed.reason);
    const attempts = (input.attempts ?? 0) + 1;
    const next = retryable ? nextAttemptAt(attempts - 1, nowMs) : null;
    const state: FollowUpSyncState = retryable && next ? "pending" : "blocked";
    return {
      patch: {
        [FOLLOW_UP_FIELDS.at]: null,
        [FOLLOW_UP_FIELDS.eventId]: input.existingEventId,
        [FOLLOW_UP_FIELDS.operatorUserId]: lead.operatorUserId,
        [FOLLOW_UP_FIELDS.state]: state,
        [FOLLOW_UP_FIELDS.reason]: state === "blocked" && !retryable ? removed.reason : "retry_exhausted",
        [FOLLOW_UP_FIELDS.detail]: removed.detail.slice(0, 500),
        [FOLLOW_UP_FIELDS.attempts]: attempts,
        [FOLLOW_UP_FIELDS.nextAttemptAt]: next,
        [FOLLOW_UP_FIELDS.summary]: null,
        [FOLLOW_UP_FIELDS.note]: null,
      },
      state,
      message: describeFollowUpSync(state, removed.reason),
      recreated: false,
    };
  }

  const summary = reminderSummary(lead.businessName);
  const description = reminderDescription({
    note: input.note,
    phone: lead.phone,
    leadUrl: lead.leadUrl,
  });

  const result = await pushEvent(lead.tenantId, lead.operatorUserId, input.existingEventId, {
    summary,
    description,
    startAt: input.followUpAt,
    timeZone: lead.timeZone || undefined,
    // Fifteen minutes: long enough to be a real block on a calendar, short
    // enough that a day of callbacks does not read as fully booked.
    durationMinutes: 15,
    // Ten minutes' warning, so there is time to open the lead and read the
    // note before dialling rather than a notification as it starts.
    reminderMinutes: input.reminderMinutes ?? 10,
  });

  if (result.ok) {
    return {
      patch: {
        [FOLLOW_UP_FIELDS.at]: input.followUpAt,
        [FOLLOW_UP_FIELDS.eventId]: result.eventId,
        [FOLLOW_UP_FIELDS.operatorUserId]: lead.operatorUserId,
        [FOLLOW_UP_FIELDS.state]: "synced",
        [FOLLOW_UP_FIELDS.reason]: null,
        [FOLLOW_UP_FIELDS.detail]: null,
        [FOLLOW_UP_FIELDS.attempts]: 0,
        [FOLLOW_UP_FIELDS.nextAttemptAt]: null,
        [FOLLOW_UP_FIELDS.timeZone]: lead.timeZone || null,
        [FOLLOW_UP_FIELDS.summary]: summary,
        [FOLLOW_UP_FIELDS.note]: input.note,
      },
      state: "synced",
      message: null,
      recreated: result.recreated,
    };
  }

  const retryable = isRetryableFailure(result.reason);
  const attempts = (input.attempts ?? 0) + 1;
  const next = retryable ? nextAttemptAt(attempts - 1, nowMs) : null;
  const state: FollowUpSyncState = retryable && next ? "pending" : "blocked";
  return {
    patch: {
      // The follow-up itself SURVIVES the calendar failure. This is the line
      // that makes the feature safe: the queue keeps the promise even when
      // Google refused it.
      [FOLLOW_UP_FIELDS.at]: input.followUpAt,
      [FOLLOW_UP_FIELDS.eventId]: input.existingEventId,
      [FOLLOW_UP_FIELDS.operatorUserId]: lead.operatorUserId,
      [FOLLOW_UP_FIELDS.state]: state,
      [FOLLOW_UP_FIELDS.reason]: retryable && !next ? "retry_exhausted" : result.reason,
      [FOLLOW_UP_FIELDS.detail]: result.detail.slice(0, 500),
      [FOLLOW_UP_FIELDS.attempts]: attempts,
      [FOLLOW_UP_FIELDS.nextAttemptAt]: next,
      [FOLLOW_UP_FIELDS.timeZone]: lead.timeZone || null,
      // Snapshot what was scheduled, so a retry reproduces THIS reminder rather
      // than whatever the lead looks like hours later.
      [FOLLOW_UP_FIELDS.summary]: summary,
      [FOLLOW_UP_FIELDS.note]: input.note,
    },
    state,
    message: describeFollowUpSync(state, result.reason),
    recreated: false,
  };
}

/**
 * Plain-language status for an operator. Composed here rather than in the
 * component so the wording cannot drift between the composer and the retry
 * worker, and so a new caller cannot invent a cheerier version of a failure.
 */
export function describeFollowUpSync(
  state: FollowUpSyncState,
  reason?: ReminderFailure | "retry_exhausted" | null,
): string | null {
  if (state === "synced" || state === "off") return null;
  if (state === "pending") {
    return "Follow-up saved. It has not reached your Google Calendar yet, and we will keep trying.";
  }
  switch (reason) {
    case "not_connected":
      return "Follow-up saved. Connect Google Calendar in Settings to also get it on your phone.";
    case "scope_required":
      return "Follow-up saved. Reconnect Google in Settings and allow calendar access to get it on your phone.";
    case "auth_failed":
      return "Follow-up saved. Your Google connection expired, so reconnect it in Settings.";
    case "retry_exhausted":
      return "Follow-up saved, but Google Calendar could not be reached after several tries. Check Settings.";
    default:
      return "Follow-up saved, but it did not reach your Google Calendar. Check Settings.";
  }
}

/**
 * Who owns the event we are about to touch, and what to do about it.
 *
 * A lead can change hands, and an admin can schedule on someone else's lead.
 * The stored event then lives on the PREVIOUS operator's calendar, and Google
 * addresses events per-calendar: patching that id through the new operator's
 * session returns 404, which the write path would recover from by creating a
 * second event and storing its id — leaving the old rep a reminder that
 * nothing can ever clear. For a lead that has since gone do-not-call, that is
 * a prospect being called again by someone who never saw the note.
 *
 * Pure, so the rule is testable without a calendar. (Codex review, 2026-08-26.)
 */
export function planReminderOwnership(input: {
  existingEventId: string | null;
  storedOperatorUserId: string | null;
  currentOperatorUserId: string;
}): {
  /** Delete the old event as THIS user first, or null when no handover is needed. */
  removeAs: string | null;
  /** The id to hand the push. Null forces a fresh event on the new calendar. */
  pushWithEventId: string | null;
} {
  const { existingEventId, storedOperatorUserId, currentOperatorUserId } = input;
  const handover =
    Boolean(existingEventId) &&
    Boolean(storedOperatorUserId) &&
    storedOperatorUserId !== currentOperatorUserId;
  if (!handover) {
    return { removeAs: null, pushWithEventId: existingEventId };
  }
  return { removeAs: storedOperatorUserId, pushWithEventId: null };
}

/** True when the retry worker should pick this record up now. */
export function isDueForRetry(
  data: Record<string, unknown>,
  nowMs: number,
): boolean {
  if (data[FOLLOW_UP_FIELDS.state] !== "pending") return false;
  const next = data[FOLLOW_UP_FIELDS.nextAttemptAt];
  if (typeof next !== "string") return false;
  const at = Date.parse(next);
  return Number.isFinite(at) && at <= nowMs;
}
