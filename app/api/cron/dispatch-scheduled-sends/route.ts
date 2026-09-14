/**
 * GET+POST /api/cron/dispatch-scheduled-sends — fires due rows from
 * `scheduled_sends` (database/114_scheduled_sends.sql). Vercel cron, every
 * 5 min (vercel.json). Cron-secret authed (lib/cron-auth.ts, same pattern
 * as the other /api/cron/* routes) — Vercel calls both GET and POST the
 * same way, so both methods are wired to the same handler.
 *
 * No session exists in a cron invocation, so this NEVER calls the HTTP send
 * routes (/api/conversations/reply, /api/leads/[id]/email) — it sends
 * directly via the same lib functions those routes use
 * (lib/integrations/texttorrent.ts sendSms, lib/integrations/gmail-oauth-
 * send.ts / gmail-apppassword-send.ts), using the sender identity resolved
 * and frozen at schedule time (scheduled_sends.from_identity), and logs a
 * lead_interactions row exactly like those routes do.
 *
 * Never-double-send: a row is claimed by a single conditional UPDATE
 * (`WHERE status='pending'` in the same statement that sets it to
 * 'sending') — PostgREST has no `FOR UPDATE SKIP LOCKED`, so this
 * compare-and-swap is the achievable equivalent: two overlapping cron
 * invocations racing the same row can each only flip it out of 'pending'
 * once, so only one ever proceeds to send.
 *
 * Stale-'sending' recovery keys on `claimed_at`, never `scheduled_for`: an
 * overdue row can be claimed seconds ago and must not look stale to an
 * overlapping invocation. An interrupted send on either channel crosses an
 * ambiguous provider boundary, so it becomes terminal review-required instead
 * of auto-retrying.
 *
 * Dry-run gate: SMS sends re-check lib/integrations/send-mode.ts isDryRun()
 * right before the TextTorrent call — the SAME gate
 * /api/conversations/reply/route.ts checks. The dashboard defaults to
 * dry-run (going live is an explicit env flip); a cron-fired scheduled send
 * must not be the one path that bypasses it. The email path has no such
 * gate, matching app/api/leads/[id]/email/route.ts (which doesn't check it
 * either) — an existing asymmetry in this codebase, not introduced here.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { checkPhoneOptOut, checkEmailSuppressed } from "@/lib/lead-interactions-queries";
import { isDryRun } from "@/lib/integrations/send-mode";
import {
  getTextTorrentCredentials,
  sendSms as ttSendSms,
  TextTorrentError,
} from "@/lib/integrations/texttorrent";
import { operatorHasAppPassword, sendGmailAppPasswordAsOperator } from "@/lib/integrations/gmail-apppassword-send";
import { operatorHasGmailOAuth, sendGmailAsOperator } from "@/lib/integrations/gmail-oauth-send";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import {
  recoverStaleDashboardEmailReservations,
  type DashboardEmailReservationRecovery,
} from "@/lib/leads/dashboard-email-reservations";
import {
  DeliveryStateUnknownError,
  markScheduledSendDeliveryUnknown,
  markScheduledSendPermanentFail,
  markScheduledSendRetryOrFail,
  markScheduledSendSent,
  recoverStaleScheduledSendClaims,
  releaseUnstartedScheduledSendClaims,
  scheduledSendIdempotencyKey,
} from "@/lib/scheduled-sends/delivery-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 50;
const STALE_SENDING_MINUTES = 15;
// Soft time budget — stop claiming/processing further rows once we're this
// deep into the 60s maxDuration, so the function returns cleanly instead of
// risking a platform kill mid-send. Anything left 'sending' past this point
// is picked up by the stale-reclaim on a later run.
const SOFT_BUDGET_MS = 50_000;

type ClaimedRow = {
  id: string;
  tenant_id: string;
  lead_id: string | null;
  thread_key: string;
  channel: "sms" | "email";
  to_phone: string | null;
  to_email: string | null;
  subject: string | null;
  body: string;
  actor_user_id: string;
  from_identity: string | null;
  attempts: number;
  claimed_at: string | null;
};

type Db = ReturnType<typeof getServiceSupabase>;

/** Best-effort lead_interactions log, mirrors the shape the live reply/email
 *  routes write. Never throws — a logging failure must not fail an actual send. */
async function logInteraction(
  db: Db,
  args: {
    tenantId: string;
    leadId: string | null;
    channel: "sms" | "email";
    toPhone: string | null;
    toEmail: string | null;
    subject: string | null;
    body: string;
    actorUserId: string;
    metadata: Record<string, unknown>;
  },
) {
  try {
    await db.from("lead_interactions").insert({
      tenant_id: args.tenantId,
      lead_id: args.leadId,
      type: args.channel === "sms" ? "sms_sent" : "email_sent",
      channel: args.channel,
      direction: "outbound",
      agent_source: "scheduled_send",
      to_phone: args.toPhone,
      to_email: args.toEmail,
      subject: args.subject,
      content: args.channel === "email" ? args.body : null,
      content_preview: args.body.slice(0, 1024),
      actor_user_id: args.actorUserId,
      metadata: args.metadata,
    });
  } catch (err) {
    console.error("[dispatch-scheduled-sends] interaction insert failed", err);
  }
}

/** Retryable failure — increments attempts, requeues to 'pending' (picked up
 *  next cron tick) until the maximum, then a permanent 'failed'. */
async function markRetryOrFail(db: Db, row: ClaimedRow, reason: string) {
  await markScheduledSendRetryOrFail(db, row, reason);
}

/** Non-retryable failure (confirmed opt-out/suppression) — permanent fail
 *  immediately regardless of attempt count; retrying can't change reality. */
async function markPermanentFail(db: Db, row: ClaimedRow, reason: string) {
  await markScheduledSendPermanentFail(db, row, reason);
}

/** The provider may have accepted the delivery. Freeze it for manual review;
 * automatic retry is forbidden because it can send a duplicate. */
async function markDeliveryUnknown(db: Db, row: ClaimedRow, reason: string) {
  await markScheduledSendDeliveryUnknown(db, row, reason);
}

async function processSms(db: Db, row: ClaimedRow): Promise<void> {
  if (!row.to_phone) return markPermanentFail(db, row, "missing_to_phone");

  // Re-check suppression at FIRE time — fail closed. A contact can opt out
  // in the window between scheduling and now.
  const supp = await checkPhoneOptOut(row.tenant_id, row.to_phone);
  if (supp.optedOut) return markPermanentFail(db, row, "opted_out (replied STOP)");
  if (supp.checkFailed) return markRetryOrFail(db, row, "suppression_check_failed");

  if (!row.from_identity) return markRetryOrFail(db, row, "no_sender_number_resolved");

  // Dashboard dry-run gate (lib/integrations/send-mode.ts) — the SAME gate
  // app/api/conversations/reply/route.ts checks. The dashboard defaults to
  // dry-run; going live is an explicit env flip. A cron-fired scheduled send
  // MUST NOT be the one path that bypasses it. dryRun=true logs the attempt
  // (mirroring the reply route's dry-run branch) without calling TextTorrent.
  const dryRun = isDryRun("texttorrent");
  if (!dryRun) {
    try {
      // Semi-mode drafts are approved for a specific employee identity. Resolve
      // that identity again at fire time and require the frozen sender DID to
      // still match, otherwise the tenant default act-as account could send an
      // employee's approved reply from the wrong TextTorrent sub-account.
      const identities = await db.from("sunbiz_agent_accounts")
        .select("act_as_email,daily_cap,user_id,from_number")
        .eq("tenant_id", row.tenant_id)
        .eq("user_id", row.actor_user_id)
        .eq("provider", "texttorrent")
        .eq("enabled", true);
      const frozenDid = row.from_identity.replace(/\D/g, "").slice(-10);
      const identity = (identities.data || []).find(
        (candidate) => candidate.from_number.replace(/\D/g, "").slice(-10) === frozenDid,
      );
      if (identities.error || !identity?.act_as_email) {
        return markRetryOrFail(db, row, "sunbiz_agent_identity_unavailable");
      }
      const sentToday = await db.from("scheduled_sends").select("id", { count: "exact", head: true })
        .eq("tenant_id", row.tenant_id).eq("actor_user_id", identity.user_id)
        .eq("channel", "sms").in("status", ["sending", "sent"])
        .gte("created_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString());
      if (sentToday.error) return markRetryOrFail(db, row, "daily_cap_check_failed");
      if ((sentToday.count || 0) > identity.daily_cap) return markRetryOrFail(db, row, "daily_cap_reached");
      const creds = await getTextTorrentCredentials(row.tenant_id, {
        actAsEmail: identity.act_as_email,
      });
      await ttSendSms(creds, {
        number: row.to_phone, message: row.body, sender_id: row.from_identity, rate_priority: 80,
      });
    } catch (err) {
      const reason =
        err instanceof TextTorrentError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : "send_failed";
      if (
        err instanceof TextTorrentError &&
        (err.code === "network_error" || /^http_5\d\d$/.test(err.code))
      ) {
        return markDeliveryUnknown(db, row, reason);
      }
      return markRetryOrFail(db, row, reason);
    }
  }

  await logInteraction(db, {
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    channel: "sms",
    toPhone: row.to_phone,
    toEmail: null,
    subject: null,
    body: row.body,
    actorUserId: row.actor_user_id,
    metadata: { provider: "texttorrent", scheduled_send_id: row.id, from_number: row.from_identity, dry_run: dryRun },
  });
  await markScheduledSendSent(db, row.id);
  await nudgeConversations(row.tenant_id);
}

async function processEmail(db: Db, row: ClaimedRow): Promise<void> {
  if (!row.to_email) return markPermanentFail(db, row, "missing_to_email");

  const supp = await checkEmailSuppressed(row.tenant_id, row.to_email);
  if (supp.suppressed) return markPermanentFail(db, row, "suppressed (unsubscribed)");
  if (supp.checkFailed) return markRetryOrFail(db, row, "suppression_check_failed");

  const subject = row.subject || "";

  // Which company is this scheduled send from? Derived from the row's tenant,
  // fail-closed. Both senders below appended the SunBiz legal footer to
  // everything before 2026-09-09, because they called the footer helper without
  // a brand and it defaulted. A cron has no operator watching it, so a
  // mis-signed scheduled send is the least likely of all to be noticed.
  const brand = brandForTenant({ tenantId: row.tenant_id });
  if (!brand) {
    return markPermanentFail(db, row, "no_sending_brand_for_tenant");
  }

  // Same preference ladder as app/api/leads/[id]/email/route.ts minus the
  // submissions@ queue fallback — a cron has no session to drive the bridge
  // exec-tool, so a scheduled email send is per-rep Gmail only. Re-resolves
  // the operator's CURRENT connection (not a stored credential — none is
  // persisted here) rather than trusting from_identity is still valid.
  let sendResult:
    | { ok: true; provider: string; from_address: string; message_id: string }
    | { ok: false; reason: string; error: string };
  const idempotencyKey = scheduledSendIdempotencyKey(row.id);

  if (await operatorHasAppPassword(row.tenant_id, row.actor_user_id)) {
    let g: Awaited<ReturnType<typeof sendGmailAppPasswordAsOperator>>;
    try {
      g = await sendGmailAppPasswordAsOperator({
        tenantId: row.tenant_id,
        userId: row.actor_user_id,
        to: row.to_email,
        subject,
        body: row.body,
        brand,
        idempotencyKey,
      });
    } catch (err) {
      return markDeliveryUnknown(
        db,
        row,
        err instanceof Error ? err.message : "app_password_provider_threw",
      );
    }
    sendResult = g.ok
      ? { ok: true, provider: "gmail_apppassword", from_address: g.from_address, message_id: g.gmail_message_id }
      : { ok: false, reason: g.reason, error: g.error };
  } else if (await operatorHasGmailOAuth(row.tenant_id, row.actor_user_id)) {
    let g: Awaited<ReturnType<typeof sendGmailAsOperator>>;
    try {
      g = await sendGmailAsOperator({
        tenantId: row.tenant_id,
        userId: row.actor_user_id,
        to: row.to_email,
        subject,
        body: row.body,
        brand,
        idempotencyKey,
      });
    } catch (err) {
      return markDeliveryUnknown(
        db,
        row,
        err instanceof Error ? err.message : "oauth_provider_threw",
      );
    }
    sendResult = g.ok
      ? { ok: true, provider: "gmail_oauth", from_address: g.from_address, message_id: g.gmail_message_id }
      : { ok: false, reason: g.reason, error: g.error };
  } else {
    sendResult = { ok: false, reason: "not_connected", error: "no_email_sender_connected" };
  }

  if (!sendResult.ok) {
    if (sendResult.reason === "delivery_unknown") {
      return markDeliveryUnknown(db, row, sendResult.error);
    }
    return markRetryOrFail(db, row, `${sendResult.reason}: ${sendResult.error}`);
  }

  // Commit the terminal queue state before secondary bookkeeping. Once the
  // provider says sent, no logging or realtime failure may make this row
  // retryable again.
  await markScheduledSendSent(db, row.id);
  await logInteraction(db, {
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    channel: "email",
    toPhone: null,
    toEmail: row.to_email,
    subject,
    body: row.body,
    actorUserId: row.actor_user_id,
    metadata: {
      provider: sendResult.provider,
      from_address: sendResult.from_address,
      gmail_message_id: sendResult.message_id,
      scheduled_send_id: row.id,
    },
  });
  try {
    await nudgeConversations(row.tenant_id);
  } catch (err) {
    console.error("[dispatch-scheduled-sends] conversation nudge failed after email sent", {
      scheduledSendId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleDispatch(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const startedAt = Date.now();
  const db = getServiceSupabase();
  const nowIso = new Date().toISOString();
  const staleBeforeIso = new Date(Date.now() - STALE_SENDING_MINUTES * 60_000).toISOString();

  // Recover direct-email requests that were interrupted by a platform kill.
  // Pre-dispatch reservations are safe to queue; a row whose provider call
  // already began is terminally marked unknown and NEVER auto-retried.
  let dashboardEmailRecovery: DashboardEmailReservationRecovery = {
    inspected: 0,
    queued: 0,
    delivery_unknown: 0,
    raced: 0,
    errors: 0,
  };
  try {
    dashboardEmailRecovery = await recoverStaleDashboardEmailReservations({ db });
  } catch (err) {
    dashboardEmailRecovery.errors += 1;
    console.error("[dispatch-scheduled-sends] dashboard email reservation recovery failed", err);
  }

  // 1) Stale-'sending' recovery. Claim age is the lease clock; scheduled_for
  // says when work was due and may already be hours old at the instant a fresh
  // worker claims it. Either channel may have crossed the provider boundary,
  // so every stale in-flight row is frozen for review and never auto-re-sent.
  const reclaimed = 0;
  let deliveryUnknownRecovered = 0;
  try {
    const recovery = await recoverStaleScheduledSendClaims({ db, staleBeforeIso });
    deliveryUnknownRecovered =
      recovery.emailDeliveryUnknown + recovery.smsDeliveryUnknown;
  } catch (err) {
    console.error("[dispatch-scheduled-sends] stale reclaim failed", err);
  }

  // 2) Find due pending work.
  const dueRes = await db
    .from("scheduled_sends")
    .select("id")
    .eq("status", "pending")
    .lte("scheduled_for", nowIso)
    .order("scheduled_for", { ascending: true })
    .limit(BATCH_LIMIT);
  if (dueRes.error) {
    return NextResponse.json({ ok: false, error: dueRes.error.message }, { status: 500 });
  }
  const dueIds = (dueRes.data || []).map((r) => (r as { id: string }).id);
  if (dueIds.length === 0) {
    return NextResponse.json({
      ok: true,
      reclaimed,
      delivery_unknown_recovered: deliveryUnknownRecovered,
      dashboard_email_recovery: dashboardEmailRecovery,
      claimed: 0,
      processed: 0,
    });
  }

  // 3) Claim: conditional UPDATE (status still 'pending' at write time) —
  // the PostgREST-reachable equivalent of `FOR UPDATE SKIP LOCKED`. See file
  // header for the race-safety argument.
  const claimRes = await db
    .from("scheduled_sends")
    .update({ status: "sending", claimed_at: nowIso })
    .in("id", dueIds)
    .eq("status", "pending")
    .select(
      "id, tenant_id, lead_id, thread_key, channel, to_phone, to_email, subject, body, actor_user_id, from_identity, attempts, claimed_at",
    );
  if (claimRes.error) {
    return NextResponse.json({ ok: false, error: claimRes.error.message }, { status: 500 });
  }
  const claimed = (claimRes.data || []) as ClaimedRow[];

  // 4) Process serially, each fully isolated by try/catch so one bad row
  // never blocks the rest of the batch. If the soft budget ends this loop,
  // untouched claims are released below before the invocation returns.
  let processed = 0;
  let sentCount = 0;
  let failedCount = 0;
  for (const row of claimed) {
    if (Date.now() - startedAt > SOFT_BUDGET_MS) break;
    try {
      if (row.channel === "sms") await processSms(db, row);
      else await processEmail(db, row);
    } catch (err) {
      console.error("[dispatch-scheduled-sends] unhandled row error", row.id, err);
      if (!(err instanceof DeliveryStateUnknownError)) {
        await markRetryOrFail(
          db,
          row,
          err instanceof Error ? err.message : "unhandled_error",
        ).catch((stateErr) => {
          console.error("[dispatch-scheduled-sends] retry state update failed", row.id, stateErr);
        });
      }
    }
    processed++;
  }

  // The soft budget can stop this loop before every batch claim is started.
  // Return those untouched leases immediately: they definitely did not cross
  // a provider boundary and must remain safe to process on the next tick.
  const unstarted = claimed.slice(processed);
  const releasedUnstarted = await releaseUnstartedScheduledSendClaims({
    db,
    ids: unstarted.map((row) => row.id),
    claimedAt: nowIso,
  });
  if (releasedUnstarted !== unstarted.length) {
    console.error("[dispatch-scheduled-sends] unstarted claim release incomplete", {
      claimedAt: nowIso,
      expected: unstarted.length,
      released: releasedUnstarted,
    });
    return NextResponse.json(
      {
        ok: false,
        error: "unstarted_claim_release_incomplete",
        claimed: claimed.length,
        processed,
        released_unstarted: releasedUnstarted,
      },
      { status: 500 },
    );
  }

  // Best-effort post-hoc tally for the response (not load-bearing — status
  // already committed per-row above).
  try {
    const tally = await db
      .from("scheduled_sends")
      .select("status")
      .in("id", claimed.slice(0, processed).map((r) => r.id));
    for (const r of (tally.data || []) as Array<{ status: string }>) {
      if (r.status === "sent") sentCount++;
      else if (r.status === "failed") failedCount++;
    }
  } catch {
    /* best-effort */
  }

  return NextResponse.json({
    ok: true,
    reclaimed,
    delivery_unknown_recovered: deliveryUnknownRecovered,
    dashboard_email_recovery: dashboardEmailRecovery,
    claimed: claimed.length,
    processed,
    released_unstarted: releasedUnstarted,
    sent: sentCount,
    failed: failedCount,
  });
}

export async function GET(req: NextRequest) {
  return handleDispatch(req);
}

export async function POST(req: NextRequest) {
  return handleDispatch(req);
}
