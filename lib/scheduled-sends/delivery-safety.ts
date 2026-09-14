import type { SupabaseClient } from "@supabase/supabase-js";

export type ScheduledSendStateDb = Pick<SupabaseClient, "from">;
export type ScheduledSendAttempt = { id: string; attempts: number };

export class DeliveryStateUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryStateUnknownError";
  }
}

export function scheduledSendIdempotencyKey(id: string): string {
  return `scheduled-send:${id}`;
}

export async function markScheduledSendSent(
  db: ScheduledSendStateDb,
  id: string,
): Promise<void> {
  const result = await db
    .from("scheduled_sends")
    .update({ status: "sent", sent_at: new Date().toISOString(), claimed_at: null })
    .eq("id", id)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();
  if (result.error || !result.data?.id) {
    throw new DeliveryStateUnknownError(
      `sent_state_not_persisted:${result.error?.message || "state_mismatch"}`,
    );
  }
}

export async function markScheduledSendRetryOrFail(
  db: ScheduledSendStateDb,
  row: ScheduledSendAttempt,
  reason: string,
  maxAttempts = 3,
): Promise<boolean> {
  const attempts = (row.attempts || 0) + 1;
  const status = attempts >= maxAttempts ? "failed" : "pending";
  const result = await db
    .from("scheduled_sends")
    .update({ status, attempts, last_error: reason.slice(0, 500), claimed_at: null })
    .eq("id", row.id)
    .eq("status", "sending")
    .select("id");
  if (result.error) throw new Error(`retry_state_not_persisted:${result.error.message}`);
  return (result.data?.length || 0) === 1;
}

export async function markScheduledSendPermanentFail(
  db: ScheduledSendStateDb,
  row: ScheduledSendAttempt,
  reason: string,
): Promise<boolean> {
  const result = await db
    .from("scheduled_sends")
    .update({
      status: "failed",
      attempts: (row.attempts || 0) + 1,
      last_error: reason.slice(0, 500),
      claimed_at: null,
    })
    .eq("id", row.id)
    .eq("status", "sending")
    .select("id");
  if (result.error) throw new Error(`failed_state_not_persisted:${result.error.message}`);
  return (result.data?.length || 0) === 1;
}

/** The provider may have accepted this email. Freeze it for manual review;
 * automatic retry is forbidden because that can deliver a duplicate. */
export async function markScheduledSendDeliveryUnknown(
  db: ScheduledSendStateDb,
  row: ScheduledSendAttempt,
  reason: string,
): Promise<void> {
  const result = await db
    .from("scheduled_sends")
    .update({
      status: "failed",
      attempts: (row.attempts || 0) + 1,
      last_error: `delivery_unknown:${reason}`.slice(0, 500),
      claimed_at: null,
    })
    .eq("id", row.id)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();
  if (result.error || !result.data?.id) {
    throw new DeliveryStateUnknownError(
      `delivery_unknown_state_not_persisted:${result.error?.message || "state_mismatch"}`,
    );
  }
}

export type ScheduledSendStaleRecovery = {
  emailDeliveryUnknown: number;
  smsDeliveryUnknown: number;
};

/** Return rows this invocation claimed but never started. Matching both the
 * sending state and this batch's lease prevents one worker from releasing a
 * row another worker has already taken over. */
export async function releaseUnstartedScheduledSendClaims(args: {
  db: ScheduledSendStateDb;
  ids: string[];
  claimedAt: string;
}): Promise<number> {
  if (args.ids.length === 0) return 0;
  const result = await args.db
    .from("scheduled_sends")
    .update({ status: "pending", claimed_at: null })
    .in("id", args.ids)
    .eq("status", "sending")
    .eq("claimed_at", args.claimedAt)
    .select("id");
  if (result.error) throw new Error(`unstarted_release_failed:${result.error.message}`);
  return result.data?.length || 0;
}

/** Recover only genuinely stale worker leases. Once processing starts, either
 * provider may have accepted the send before the worker lost its response, so
 * every stale channel is terminal review-required rather than auto-retried. */
export async function recoverStaleScheduledSendClaims(args: {
  db: ScheduledSendStateDb;
  staleBeforeIso: string;
}): Promise<ScheduledSendStaleRecovery> {
  const stale = await args.db
    .from("scheduled_sends")
    .select("id,attempts,channel")
    .eq("status", "sending")
    .lt("claimed_at", args.staleBeforeIso);
  if (stale.error) throw new Error(`stale_delivery_read_failed:${stale.error.message}`);

  let emailDeliveryUnknown = 0;
  let smsDeliveryUnknown = 0;
  for (const row of (stale.data || []) as Array<ScheduledSendAttempt & { channel: string }>) {
    await markScheduledSendDeliveryUnknown(
      args.db,
      row,
      "worker_interrupted_after_provider_boundary",
    );
    if (row.channel === "sms") smsDeliveryUnknown += 1;
    else emailDeliveryUnknown += 1;
  }

  return {
    emailDeliveryUnknown,
    smsDeliveryUnknown,
  };
}
