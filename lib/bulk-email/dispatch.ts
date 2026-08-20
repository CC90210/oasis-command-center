/**
 * lib/bulk-email/dispatch.ts — drains the dashboard bulk-email queue through
 * the tenant's encrypted submissions-mailbox App Password (sendGmail), replacing
 * the VPS send_gateway drain whose env-keyed GMAIL_APP_PASSWORD went stale after
 * the 2026-08 credential rotation (53 consecutive "SMTP authentication failed"
 * rows, zero bulk sends since 2026-07-27).
 *
 * Contract with the queue writer (app/api/leads/bulk, op="email"):
 *   - Rows: lead_interactions, agent_source = BULK_EMAIL_SOURCE,
 *     type='email_queued', metadata.status='queued'. The v2 source tag is what
 *     keeps the VPS consumer OFF these rows — it only drains the legacy
 *     'dashboard_bulk_email' tag, so the two dispatchers can never double-send
 *     the same row.
 *   - The queue is UNCAPPED at trigger time; this drain is where volume policy
 *     lives (per-tick batch + daily ceiling), so an operator can blast an
 *     arbitrary list and the send rate stays inside Gmail's tolerance.
 *
 * Volume policy (why these numbers): Google Workspace hard-caps a mailbox at
 * 2,000 recipients/day and throttles bursts well below that. PER_TICK=20 on a
 * 5-minute cron = 240/hour; DAILY_CAP=1500 keeps 25% headroom under the hard
 * cap for the transactional form/receipt mail that shares this mailbox.
 * Both are env-tunable without a deploy (BULK_EMAIL_PER_TICK /
 * BULK_EMAIL_DAILY_CAP).
 *
 * Failure model ([[feedback_blocking_not_error]] applied per-row):
 *   - Per-recipient failures (bad address, 550) mark THAT row failed and the
 *     batch continues — one dead address never kills a blast.
 *   - Mailbox-level failures (auth, throttle) stop THIS tick and requeue the
 *     row: every subsequent send would fail identically, and hammering Gmail
 *     login with a bad password risks a lockout on the shared mailbox. The
 *     5-minute cron is the retry ladder (one login probe per tick, not 200).
 *   - Suppression lookup FAILS CLOSED: an unverifiable recipient is requeued,
 *     never sent blind. See [[fail-closed-default]].
 *   - attempts > MAX_ATTEMPTS → terminal 'failed' so a poison row can't cycle
 *     forever; rows older than FRESHNESS_HOURS expire unsent — a stale blast
 *     resurrecting days later reads as a ghost send to the operator.
 *   - A claim orphaned by a crashed tick is TERMINAL ('failed',
 *     uncertain_delivery), never requeued: the crash happened after the claim
 *     and possibly after Gmail accepted the message, so an automatic retry
 *     risks a duplicate delivery (Codex review P1, 2026-08-18). The operator
 *     sees the row flagged for review and decides.
 *
 * Concurrency: every state transition is a CAS on metadata->>status (the
 * Turso shim compiles the JSON path to json_extract), so an overlapping tick
 * claims a row exactly once. NOTE: the object-containment filter (PostgREST
 * "cs") is deliberately absent here — on the Turso adapter it compiles to
 * json_each ARRAY semantics and never matches an object column (verified
 * 2026-08-18); tests/bulk-email-dispatch.test.ts pins this file to the
 * json-path form.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendGmail } from "@/lib/integrations/submissions-gmail-send";
import { SUNBIZ_LEGAL_FOOTER } from "@/lib/config/email-signature";
import { listUnsubscribeHeader } from "@/lib/email/tracked-html";

/** Shared with app/api/leads/bulk — the queue writer and this drain must agree. */
export const BULK_EMAIL_SOURCE = "dashboard_bulk_email_v2";

const intEnv = (name: string, def: number): number => {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

const PER_TICK = () => intEnv("BULK_EMAIL_PER_TICK", 20);
const DAILY_CAP = () => intEnv("BULK_EMAIL_DAILY_CAP", 1500);
const MAX_ATTEMPTS = 5;
const FRESHNESS_HOURS = 48;
const STUCK_CLAIM_MINUTES = 15;
/** Stop starting new sends after this much wall time so the tick always ends
 *  inside the route's maxDuration; the remainder stays queued for next tick. */
const SOFT_TIME_BUDGET_MS = 45_000;

/**
 * 🚨 ONE drain at a time, estate-wide.
 *
 * The per-tick batch and the daily cap are computed per INVOCATION, before any
 * row is claimed. The row-level CAS stops two runners delivering the SAME
 * message, but it does nothing about two runners each sending a full budget:
 * concurrent drains multiply the send RATE and can walk straight through the
 * daily ceiling. That ceiling is not decorative — it holds 25% headroom under
 * Google's 2,000/day hard cap on the shared submissions mailbox, and that
 * mailbox also carries every form receipt and transactional message. Tripping
 * Google's limits there breaks far more than bulk email.
 *
 * Concurrency became reachable on 2026-08-20, when queueing started kicking the
 * drain immediately via after(): two operators sending at once, or any send
 * overlapping the 5-minute cron, now races. So the lease lives HERE rather than
 * at the kick site, which is the only place that covers cron-vs-kick as well as
 * kick-vs-kick. (Codex review P1, 2026-08-20 round 8.)
 *
 * Correctness rests on the table's PRIMARY KEY (tenant_id, partition_key): the
 * INSERT is the atomic gate, so exactly one racer can win. A crashed drain does
 * not wedge the queue — the lease expires and the next runner clears it. TTL is
 * comfortably above the route's maxDuration so a live drain never loses its own
 * lease mid-tick.
 */
const DRAIN_LEASE_KEY = "bulk-email-drain";
const DRAIN_LEASE_SECONDS = 120;

/** @returns an owner token when the lease is ours, null when someone else holds it. */
async function acquireDrainLease(db: SupabaseClient, tenantId: string): Promise<string | null> {
  const owner = randomUUID();
  const now = new Date().toISOString();
  try {
    // Clear an EXPIRED lease (a crashed runner's). Deliberately not a blind
    // delete: an unexpired lease belongs to a live drain and must survive.
    await db
      .from("sunbiz_processing_leases")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("partition_key", DRAIN_LEASE_KEY)
      .lt("expires_at", now);
    // The gate. A conflicting row means another drain holds the lease.
    const ins = await db.from("sunbiz_processing_leases").insert({
      tenant_id: tenantId,
      partition_key: DRAIN_LEASE_KEY,
      owner_id: owner,
      acquired_at: now,
      heartbeat_at: now,
      expires_at: new Date(Date.now() + DRAIN_LEASE_SECONDS * 1000).toISOString(),
    });
    return ins.error ? null : owner;
  } catch {
    // FAIL CLOSED: if we cannot prove we hold the lease, we do not send.
    return null;
  }
}

/** Best-effort release. A missed release costs at most one lease TTL of delay. */
async function releaseDrainLease(db: SupabaseClient, tenantId: string, owner: string): Promise<void> {
  try {
    await db
      .from("sunbiz_processing_leases")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("partition_key", DRAIN_LEASE_KEY)
      .eq("owner_id", owner);
  } catch {
    /* the TTL is the backstop */
  }
}

type Meta = Record<string, unknown>;

type PendingRow = {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  to_email: string | null;
  subject: string | null;
  content: string | null;
  created_at: string | null;
  metadata: Meta | null;
};

export type DispatchResult = {
  ok: boolean;
  sent: number;
  failed: number;
  suppressed: number;
  expired: number;
  requeued: number;
  /** Orphaned claims terminal-failed as uncertain_delivery (never resent). */
  uncertain: number;
  capRemaining: number;
  stoppedEarly?: string;
};

/** Mailbox-level errors: every send this tick would fail the same way. */
const AUTH_ERR = /535|auth|username and password/i;
const THROTTLE_ERR = /rate_limit_persisted|421|450|451|452|4\.\d\.\d|quota|too many/i;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** CAS a row from `fromStatus` to the given patch; true iff we won the race. */
async function casUpdate(
  db: SupabaseClient,
  row: { id: string; tenant_id: string },
  fromStatus: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const res = await db
    .from("lead_interactions")
    .update(patch)
    .eq("id", row.id)
    .eq("tenant_id", row.tenant_id)
    .eq("metadata->>status", fromStatus)
    .select("id");
  if (res.error) {
    console.error("[bulk-email.dispatch] CAS update failed", {
      row_id: row.id, from: fromStatus, error: res.error.message,
    });
    return false;
  }
  return (res.data?.length ?? 0) === 1;
}

/** Requeue after a retryable failure — or terminal-fail once attempts run out. */
async function requeueOrFail(
  db: SupabaseClient,
  row: PendingRow,
  meta: Meta,
  reason: string,
): Promise<"requeued" | "failed"> {
  const attempts = num(meta.attempts) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await casUpdate(db, row, "sending", {
      metadata: { ...meta, status: "failed", attempts, send_error: `${reason} (max_attempts)` },
    });
    return "failed";
  }
  await casUpdate(db, row, "sending", {
    metadata: { ...meta, status: "queued", attempts, last_error: reason },
  });
  return "requeued";
}

/** Fail-closed suppression re-check (same posture as lib/forms/next-steps-email). */
async function suppressionGate(
  db: SupabaseClient,
  tenantId: string,
  toEmail: string,
): Promise<"clear" | "suppressed" | "check_failed"> {
  const pattern = toEmail.toLowerCase().replace(/[%_\\]/g, "\\$&");
  const supp = await db
    .from("email_suppressions")
    .select("email")
    .eq("tenant_id", tenantId)
    .ilike("email", pattern)
    .limit(1);
  if (supp.error) return "check_failed";
  return (supp.data?.length ?? 0) > 0 ? "suppressed" : "clear";
}

/**
 * Terminal-fail claims orphaned by a crashed tick so their rows aren't wedged.
 * NEVER requeue them: a claim is taken immediately before SMTP, so an orphan
 * may already have been delivered — an automatic retry is a possible duplicate
 * email to a real merchant. The safe direction for commercial mail is to drop
 * and flag, not resend (Codex review P1, 2026-08-18).
 */
async function failStuckClaims(db: SupabaseClient): Promise<number> {
  const res = await db
    .from("lead_interactions")
    .select("id, tenant_id, metadata")
    .eq("agent_source", BULK_EMAIL_SOURCE)
    .eq("metadata->>status", "sending")
    .limit(50);
  if (res.error || !res.data) return 0;
  let terminalized = 0;
  const cutoff = Date.now() - STUCK_CLAIM_MINUTES * 60_000;
  for (const r of res.data as Array<{ id: string; tenant_id: string; metadata: Meta | null }>) {
    const meta = r.metadata || {};
    const claimedAt = typeof meta.claimed_at === "string" ? Date.parse(meta.claimed_at) : NaN;
    if (!Number.isFinite(claimedAt) || claimedAt > cutoff) continue;
    const ok = await casUpdate(db, r, "sending", {
      metadata: {
        ...meta,
        status: "failed",
        send_error: "uncertain_delivery_after_claim",
        needs_operator_review: true,
      },
    });
    if (ok) terminalized += 1;
  }
  return terminalized;
}

/** Sends recorded today (UTC) — the daily ceiling counts actual deliveries. */
async function sentToday(db: SupabaseClient, cap: number): Promise<number> {
  const dayStart = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
  const res = await db
    .from("lead_interactions")
    .select("id")
    .eq("agent_source", BULK_EMAIL_SOURCE)
    .eq("metadata->>status", "sent")
    .gte("sent_at", dayStart)
    .limit(cap + 1);
  if (res.error) {
    // Fail CLOSED: an uncountable ceiling is a reached ceiling.
    console.error("[bulk-email.dispatch] cap count failed — treating cap as reached", {
      error: res.error.message,
    });
    return cap;
  }
  return res.data?.length ?? 0;
}

export async function runDispatchBulkEmail(): Promise<DispatchResult> {
  const db = getServiceSupabase();
  const out: DispatchResult = {
    ok: true, sent: 0, failed: 0, suppressed: 0, expired: 0,
    requeued: 0, uncertain: 0, capRemaining: 0,
  };

  // The lease is keyed on the tenant this drain serves. Resolving it up front
  // also means a tenants lookup failure stops the tick BEFORE any send, rather
  // than part-way through: fail closed, and let the next tick retry.
  const sun = await db.from("tenants").select("id").eq("slug", "submissions").maybeSingle();
  const leaseTenant = (sun.data as { id?: string } | null)?.id;
  if (sun.error || !leaseTenant) {
    console.error("[bulk-email.dispatch] tenant lookup failed — not draining", {
      error: sun.error?.message,
    });
    return { ...out, ok: false, stoppedEarly: "tenant_lookup_failed" };
  }

  const lease = await acquireDrainLease(db, leaseTenant);
  if (!lease) {
    // NOT an error: another drain owns the queue and is working it. Returning
    // ok:true keeps this out of the alerting path, which is reserved for
    // conditions a human must act on.
    return { ...out, stoppedEarly: "drain_already_running" };
  }

  try {
    return await drain(db, out);
  } finally {
    await releaseDrainLease(db, leaseTenant, lease);
  }
}

/** The tick itself. Only ever called while holding the drain lease. */
async function drain(db: SupabaseClient, out: DispatchResult): Promise<DispatchResult> {
  const started = Date.now();

  out.uncertain = await failStuckClaims(db);

  const cap = DAILY_CAP();
  const used = await sentToday(db, cap);
  out.capRemaining = Math.max(0, cap - used);
  if (out.capRemaining === 0) {
    out.stoppedEarly = "daily_cap_reached";
    return out;
  }
  const budget = Math.min(PER_TICK(), out.capRemaining);

  // Oldest first so a big blast drains in submission order. Over-fetch so
  // expired/suppressed rows don't starve the tick of sendable work.
  const pending = await db
    .from("lead_interactions")
    .select("id, tenant_id, lead_id, to_email, subject, content, created_at, metadata")
    .eq("agent_source", BULK_EMAIL_SOURCE)
    .eq("type", "email_queued")
    .eq("metadata->>status", "queued")
    .order("created_at", { ascending: true })
    .limit(budget * 3);
  if (pending.error) {
    console.error("[bulk-email.dispatch] pending fetch failed", { error: pending.error.message });
    return { ...out, ok: false, stoppedEarly: "pending_fetch_failed" };
  }

  // Tenant → brand: bulk templates are the SunBiz library, sent from the SunBiz
  // submissions mailbox. Rows from any other tenant are terminal-failed loudly
  // rather than silently skipped ([[redundancy-hides-failure]]).
  const tenantIds = [...new Set((pending.data as PendingRow[]).map((r) => r.tenant_id))];
  const sunbizTenants = new Set<string>();
  if (tenantIds.length > 0) {
    const tenants = await db.from("tenants").select("id, slug").in("id", tenantIds);
    if (tenants.error) {
      console.error("[bulk-email.dispatch] tenant fetch failed", { error: tenants.error.message });
      return { ...out, ok: false, stoppedEarly: "tenant_fetch_failed" };
    }
    for (const t of (tenants.data ?? []) as Array<{ id: string; slug: string }>) {
      if (t.slug === "submissions") sunbizTenants.add(t.id);
    }
  }

  const freshnessCutoff = Date.now() - FRESHNESS_HOURS * 3_600_000;

  for (const row of pending.data as PendingRow[]) {
    if (out.sent >= budget) break;
    if (Date.now() - started > SOFT_TIME_BUDGET_MS) {
      out.stoppedEarly = "time_budget";
      break;
    }
    const meta: Meta = row.metadata || {};
    try {
      const createdAt = row.created_at ? Date.parse(row.created_at) : NaN;
      if (Number.isFinite(createdAt) && createdAt < freshnessCutoff) {
        if (await casUpdate(db, row, "queued", {
          metadata: { ...meta, status: "expired", send_error: `unsent after ${FRESHNESS_HOURS}h` },
        })) out.expired += 1;
        continue;
      }

      // Claim. Losing the CAS means another tick owns the row — not an error.
      const claimed = await casUpdate(db, row, "queued", {
        metadata: { ...meta, status: "sending", claimed_at: new Date().toISOString() },
      });
      if (!claimed) continue;

      if (!sunbizTenants.has(row.tenant_id)) {
        await casUpdate(db, row, "sending", {
          metadata: { ...meta, status: "failed", send_error: "unsupported_tenant_for_bulk_email" },
        });
        out.failed += 1;
        continue;
      }

      const toEmail = (row.to_email || "").trim().toLowerCase();
      if (!toEmail) {
        await casUpdate(db, row, "sending", {
          metadata: { ...meta, status: "failed", send_error: "missing_recipient" },
        });
        out.failed += 1;
        continue;
      }

      const gate = await suppressionGate(db, row.tenant_id, toEmail);
      if (gate === "check_failed") {
        out[await requeueOrFail(db, row, meta, "suppression_check_failed")] += 1;
        continue;
      }
      if (gate === "suppressed") {
        await casUpdate(db, row, "sending", { metadata: { ...meta, status: "suppressed" } });
        out.suppressed += 1;
        continue;
      }

      const body = (row.content || "").replace(/\s+$/, "") + SUNBIZ_LEGAL_FOOTER;
      const result = await sendGmail({
        tenantId: row.tenant_id,
        brand: "sunbiz",
        to: toEmail,
        subject: row.subject || "",
        body,
        listUnsubscribe: listUnsubscribeHeader(toEmail, "SunBiz"),
        retryTransient: false,
      });

      if (result.ok) {
        // Plain update, not a CAS: the claim is exclusively ours (won by CAS
        // above) and nothing else transitions 'sending' rows mid-tick, so a
        // conditional here adds only a failure mode. Gmail has ACCEPTED the
        // message at this point — if this write is lost the row would sit in
        // 'sending' and be terminal-failed as uncertain_delivery, never
        // resent (Codex review P1, 2026-08-18). One retry pares that down to
        // a two-consecutive-write-failure event.
        const sentAt = new Date().toISOString();
        const sentPatch = {
          type: "email_sent",
          sent_at: sentAt,
          metadata: {
            ...meta,
            status: "sent",
            sent_at: sentAt,
            sent_via: "submissions_gmail_apppassword",
            gmail_message_id: result.message_id,
          },
        };
        let recorded = await db.from("lead_interactions").update(sentPatch)
          .eq("id", row.id).eq("tenant_id", row.tenant_id);
        if (recorded.error) {
          recorded = await db.from("lead_interactions").update(sentPatch)
            .eq("id", row.id).eq("tenant_id", row.tenant_id);
        }
        if (recorded.error) {
          console.error("[bulk-email.dispatch] send succeeded but audit write failed twice — row will terminal-fail as uncertain_delivery, not resend", {
            row_id: row.id, lead_id: row.lead_id, error: recorded.error.message,
          });
        }
        out.sent += 1;
        continue;
      }

      if (AUTH_ERR.test(result.error)) {
        out[await requeueOrFail(db, row, meta, "smtp_auth_failed")] += 1;
        out.ok = false;
        out.stoppedEarly = "smtp_auth_failed";
        console.error("[bulk-email.dispatch] SMTP auth failed — stopping tick, queue intact", {
          row_id: row.id,
        });
        break;
      }
      if (THROTTLE_ERR.test(result.error)) {
        out[await requeueOrFail(db, row, meta, `smtp_throttled: ${result.error.slice(0, 120)}`)] += 1;
        out.stoppedEarly = "smtp_throttled";
        break;
      }

      // Per-recipient failure: record and keep going (directive: a relay
      // failure logs and continues; it never crashes the batch).
      await casUpdate(db, row, "sending", {
        metadata: { ...meta, status: "failed", send_error: result.error.slice(0, 240) },
      });
      out.failed += 1;
      console.error("[bulk-email.dispatch] send failed", {
        row_id: row.id, lead_id: row.lead_id, error: result.error.slice(0, 240),
      });
    } catch (err) {
      // Unexpected throw: isolate to this row, keep the batch alive.
      out[await requeueOrFail(db, row, meta, err instanceof Error ? err.message.slice(0, 240) : "unexpected_error")] += 1;
      console.error("[bulk-email.dispatch] row threw", {
        row_id: row.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  out.capRemaining = Math.max(0, out.capRemaining - out.sent);
  return out;
}
