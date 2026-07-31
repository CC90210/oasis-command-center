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
 * Stale-'sending' recovery: if a prior invocation was killed mid-batch by
 * the platform's maxDuration (a claimed row's send hangs, e.g. TextTorrent's
 * client has no request timeout), that row would otherwise be stuck at
 * 'sending' forever — the claim query only looks at 'pending'. Fixed by
 * reclaiming any 'sending' row whose `scheduled_for` is more than
 * STALE_SENDING_MINUTES old back to 'pending' at the TOP of every run,
 * before claiming new work. A real send takes seconds, not minutes, so this
 * can't clash with an in-flight send from THIS invocation (it only reclaims
 * rows scheduled long before "now").
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 50;
const MAX_ATTEMPTS = 3;
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

async function markSent(db: Db, id: string) {
  await db
    .from("scheduled_sends")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", id);
}

/** Retryable failure — increments attempts, requeues to 'pending' (picked up
 *  next cron tick) until MAX_ATTEMPTS, then a permanent 'failed'. */
async function markRetryOrFail(db: Db, row: ClaimedRow, reason: string) {
  const attempts = (row.attempts || 0) + 1;
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await db
    .from("scheduled_sends")
    .update({ status, attempts, last_error: reason.slice(0, 500) })
    .eq("id", row.id);
}

/** Non-retryable failure (confirmed opt-out/suppression) — permanent fail
 *  immediately regardless of attempt count; retrying can't change reality. */
async function markPermanentFail(db: Db, row: ClaimedRow, reason: string) {
  await db
    .from("scheduled_sends")
    .update({ status: "failed", attempts: (row.attempts || 0) + 1, last_error: reason.slice(0, 500) })
    .eq("id", row.id);
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
  await markSent(db, row.id);
  await nudgeConversations(row.tenant_id);
}

async function processEmail(db: Db, row: ClaimedRow): Promise<void> {
  if (!row.to_email) return markPermanentFail(db, row, "missing_to_email");

  const supp = await checkEmailSuppressed(row.tenant_id, row.to_email);
  if (supp.suppressed) return markPermanentFail(db, row, "suppressed (unsubscribed)");
  if (supp.checkFailed) return markRetryOrFail(db, row, "suppression_check_failed");

  const subject = row.subject || "";

  // Same preference ladder as app/api/leads/[id]/email/route.ts minus the
  // submissions@ queue fallback — a cron has no session to drive the bridge
  // exec-tool, so a scheduled email send is per-rep Gmail only. Re-resolves
  // the operator's CURRENT connection (not a stored credential — none is
  // persisted here) rather than trusting from_identity is still valid.
  let sendResult:
    | { ok: true; provider: string; from_address: string; message_id: string }
    | { ok: false; reason: string };

  if (await operatorHasAppPassword(row.tenant_id, row.actor_user_id)) {
    const g = await sendGmailAppPasswordAsOperator({
      tenantId: row.tenant_id,
      userId: row.actor_user_id,
      to: row.to_email,
      subject,
      body: row.body,
    });
    sendResult = g.ok
      ? { ok: true, provider: "gmail_apppassword", from_address: g.from_address, message_id: g.gmail_message_id }
      : { ok: false, reason: `${g.reason}: ${g.error}` };
  } else if (await operatorHasGmailOAuth(row.tenant_id, row.actor_user_id)) {
    const g = await sendGmailAsOperator({
      tenantId: row.tenant_id,
      userId: row.actor_user_id,
      to: row.to_email,
      subject,
      body: row.body,
    });
    sendResult = g.ok
      ? { ok: true, provider: "gmail_oauth", from_address: g.from_address, message_id: g.gmail_message_id }
      : { ok: false, reason: `${g.reason}: ${g.error}` };
  } else {
    sendResult = { ok: false, reason: "no_email_sender_connected" };
  }

  if (!sendResult.ok) {
    return markRetryOrFail(db, row, sendResult.reason);
  }

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
  await markSent(db, row.id);
  await nudgeConversations(row.tenant_id);
}

async function handleDispatch(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const startedAt = Date.now();
  const db = getServiceSupabase();
  const nowIso = new Date().toISOString();
  const staleBeforeIso = new Date(Date.now() - STALE_SENDING_MINUTES * 60_000).toISOString();

  // 1) Stale-'sending' recovery — see file header. Best-effort; a failure
  // here just means a stuck row waits for the next run's recovery attempt.
  let reclaimed = 0;
  try {
    const reclaim = await db
      .from("scheduled_sends")
      .update({ status: "pending" })
      .eq("status", "sending")
      .lt("scheduled_for", staleBeforeIso)
      .select("id");
    reclaimed = reclaim.data?.length || 0;
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
    return NextResponse.json({ ok: true, reclaimed, claimed: 0, processed: 0 });
  }

  // 3) Claim: conditional UPDATE (status still 'pending' at write time) —
  // the PostgREST-reachable equivalent of `FOR UPDATE SKIP LOCKED`. See file
  // header for the race-safety argument.
  const claimRes = await db
    .from("scheduled_sends")
    .update({ status: "sending" })
    .in("id", dueIds)
    .eq("status", "pending")
    .select(
      "id, tenant_id, lead_id, thread_key, channel, to_phone, to_email, subject, body, actor_user_id, from_identity, attempts",
    );
  if (claimRes.error) {
    return NextResponse.json({ ok: false, error: claimRes.error.message }, { status: 500 });
  }
  const claimed = (claimRes.data || []) as ClaimedRow[];

  // 4) Process serially, each fully isolated by try/catch so one bad row
  // never blocks the rest of the batch. Stop early if we're eating into the
  // platform timeout — remainder stays 'sending' and is caught by the
  // stale-reclaim above on a later run.
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
      await markRetryOrFail(db, row, err instanceof Error ? err.message : "unhandled_error").catch(() => {});
    }
    processed++;
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
    claimed: claimed.length,
    processed,
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
