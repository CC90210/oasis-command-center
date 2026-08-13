/**
 * lib/health/alert-backoff.ts — the escalating repeat policy for health alerts.
 *
 * Ported from services/_shared/alert-backoff.js (JARVIS), with the state moved
 * into Postgres because this runs on Vercel where there is no durable disk and
 * every invocation is a cold module.
 *
 *   immediate -> 1h -> 3h -> 12h -> daily forever
 *
 * Why a ladder and not a window: a flat suppression window on a PERMANENT
 * condition is an alarm clock. A 3h window pages 8 times a day, forever, until
 * someone mutes the channel — and then the next real outage is invisible. The
 * ladder never goes fully silent (an outage cannot hide) and never shouts.
 *
 * Two rules that are load-bearing, both learned the hard way in this estate:
 *
 *   1. KEY ON THE CONDITION, NEVER THE MESSAGE. Any text carrying a count, a
 *      tick id or a timestamp hashes differently every tick and dedups nothing.
 *      `conditionKey()` below builds the key from stable parts only.
 *   2. CLEAR ON RECOVERY. Forgetting this is the most common bug: a flapping
 *      service recovers once, keeps its daily rung, and the next breach stays
 *      quiet for 24h.
 */
// Not "server-only": the client is injected, so the ladder logic stays
// unit-testable against an in-memory stand-in. See tests/health-alert-backoff.test.ts,
// which counts pages over a simulated 24h outage.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Delay to the NEXT page, by rung. The last entry repeats forever. */
export const LADDER_MS = [
  0, // rung 0: immediate, the first page
  60 * 60 * 1000, // rung 1: +1h
  3 * 60 * 60 * 1000, // rung 2: +3h
  12 * 60 * 60 * 1000, // rung 3: +12h
  24 * 60 * 60 * 1000, // rung 4+: daily forever
] as const;

export function ladderDelayMs(rung: number): number {
  if (rung < 0) return 0;
  return LADDER_MS[Math.min(rung, LADDER_MS.length - 1)];
}

/**
 * Build a suppression key from STABLE parts only.
 *
 * Never pass a count, a timestamp, a tick id or a rendered message into this.
 * `check_down:sms.drip.sends` is a key; `"SMS drip down (3 failures at 14:02)"`
 * is not — it is a new key every tick.
 */
export function conditionKey(component: string, condition: string, scope?: string | null): string {
  const parts = [component, condition, scope || ""].map((p) =>
    String(p)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, ""),
  );
  return parts.filter(Boolean).join(":");
}

export type BackoffDecision = {
  notify: boolean;
  /** The rung this page occupies. Pass to the delivery ledger for idempotency. */
  rung: number;
  reason: "first" | "ladder_due" | "suppressed";
  nextAlertAt: Date | null;
};

type AlertStateRow = {
  condition_key: string;
  rung: number;
  next_alert_at: string;
  open: boolean;
  alert_count: number;
};

/**
 * Decide whether this condition may page right now, and claim the rung if so.
 *
 * PERSIST BEFORE SEND: the rung is advanced here, before the caller dispatches.
 * A crash between advance and send loses ONE page rather than re-paging on every
 * restart. For a crash-looping worker the storm is the worse failure, and the
 * next rung re-asserts within the hour. That is a real trade-off, chosen
 * deliberately, not an oversight.
 */
export async function claimAlertSlot(
  db: SupabaseClient,
  key: string,
  opts: { component: string; scope?: string | null; text: string; now?: Date },
): Promise<BackoffDecision> {
  const now = opts.now ?? new Date();

  const { data, error } = await db
    .from("health_alert_state")
    .select("condition_key, rung, next_alert_at, open, alert_count")
    .eq("condition_key", key)
    .maybeSingle<AlertStateRow>();

  // Fail CLOSED on a read error: do not page. A database blip must not become
  // an alert storm, and the next tick re-evaluates in minutes.
  if (error) {
    return { notify: false, rung: -1, reason: "suppressed", nextAlertAt: null };
  }

  const isNewCondition = !data || !data.open;

  if (isNewCondition) {
    const rung = 0;
    const nextAlertAt = new Date(now.getTime() + ladderDelayMs(rung + 1));
    const { error: upsertErr } = await db.from("health_alert_state").upsert(
      {
        condition_key: key,
        component: opts.component,
        scope: opts.scope ?? null,
        rung,
        // Stamp first_alert_at ON THE FIRST ALERT. Leaving it unset compares
        // against epoch 0 and re-asserts on the very next tick.
        first_alert_at: now.toISOString(),
        last_alert_at: now.toISOString(),
        next_alert_at: nextAlertAt.toISOString(),
        open: true,
        alert_count: (data?.alert_count ?? 0) + 1,
        last_text: opts.text.slice(0, 500),
        cleared_at: null,
        updated_at: now.toISOString(),
      },
      { onConflict: "condition_key" },
    );
    if (upsertErr) return { notify: false, rung: -1, reason: "suppressed", nextAlertAt: null };
    return { notify: true, rung, reason: "first", nextAlertAt };
  }

  const due = new Date(data.next_alert_at).getTime() <= now.getTime();
  if (!due) {
    return {
      notify: false,
      rung: data.rung,
      reason: "suppressed",
      nextAlertAt: new Date(data.next_alert_at),
    };
  }

  const rung = data.rung + 1;
  const nextAlertAt = new Date(now.getTime() + ladderDelayMs(rung + 1));
  const { error: updErr } = await db
    .from("health_alert_state")
    .update({
      rung,
      last_alert_at: now.toISOString(),
      next_alert_at: nextAlertAt.toISOString(),
      alert_count: data.alert_count + 1,
      last_text: opts.text.slice(0, 500),
      updated_at: now.toISOString(),
    })
    .eq("condition_key", key)
    // Optimistic guard: only advance if another worker has not already moved
    // the rung. Two concurrent scans then produce one page, not two.
    .eq("rung", data.rung);

  if (updErr) return { notify: false, rung: -1, reason: "suppressed", nextAlertAt: null };
  return { notify: true, rung, reason: "ladder_due", nextAlertAt };
}

/**
 * Clear a condition on recovery so the next occurrence pages IMMEDIATELY
 * instead of inheriting a daily rung. Omitting this call is the classic bug.
 */
export async function clearCondition(
  db: SupabaseClient,
  key: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .from("health_alert_state")
    .update({ open: false, rung: 0, cleared_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("condition_key", key)
    .eq("open", true);
}
