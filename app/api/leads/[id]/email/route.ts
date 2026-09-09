/**
 * POST /api/leads/[id]/email — queue an outbound email to a lead from
 * the dashboard.
 *
 * The dashboard runs on Vercel and doesn't hold SMTP / Gmail OAuth
 * credentials directly — send_gateway.py on the operator's machine
 * does. So this endpoint QUEUES the send by inserting a
 * lead_interactions row with status='queued', and emits an
 * agent_events row of type BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD that
 * send_gateway listens for. The daemon picks up the row, performs the
 * actual SMTP send, then updates the row to status='sent' and POSTs
 * back to /api/outbound/log for the canonical audit trail.
 *
 * Until the daemon side is wired (Phase 3 of the drawer build), the
 * queued row at least preserves the operator's intent in the audit
 * log so nothing is lost — and it surfaces in the timeline panel as
 * "queued" so the operator can see it landed.
 *
 * Auth: session-cookie → tenant.
 * Body: { to_email: string, subject: string, body: string }
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { publishAgentEvent } from "@/lib/manifest/events";
import { dispatchLeadStageEvent } from "@/lib/lead-stage-dispatcher";
import { resolveSignerForOperator } from "@/lib/config/agents";
import { operatorHasGmailOAuth, sendGmailAsOperator } from "@/lib/integrations/gmail-oauth-send";
import { operatorHasAppPassword, sendGmailAppPasswordAsOperator } from "@/lib/integrations/gmail-apppassword-send";
import { checkEmailSuppressed } from "@/lib/lead-interactions-queries";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";
import { sendGmail } from "@/lib/integrations/submissions-gmail-send";
import { sendOasisSharedGmail, resolveOasisMailboxFrom } from "@/lib/integrations/oasis-shared-gmail-send";
import { appendSignatureAndFooter } from "@/lib/config/email-signature";
import { persistCanonicalLeadTouch } from "@/lib/leads/canonical-touch";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { buildCopyList, pickReplyTo } from "@/lib/leads/lead-copy-recipients";
import { resolveAssigneeEmail } from "@/lib/leads/assignee-email";
import { renderQuickEmailHtml } from "@/lib/leads/quick-email-html";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generous bound for the synchronous auto-dispatch below — one SMTP
// send through send_gateway takes 1-3s + the round-trip through the
// bridge proxy. 60s gives comfortable headroom for slow upstream SMTP.
export const maxDuration = 60;

/**
 * Auto-fire the email via the bridge `send_email` tool — INSTANT send for
 * owner/admin (parallel to the shop-out auto-trigger, commit 4957702). Members
 * fall back to the queue (/api/bridge/exec-tool's role gate rejects write tools
 * for non-admin); that queue is drained by the dashboard-email-consumer daemon,
 * which now runs on the always-on VPS (moved from Windows-only → IS_LINUX in
 * ecosystem.config.js, 2026-06-29 — Windows-only meant queued lead-emails never
 * sent whenever CC's PC was off; 21 rows had piled up undelivered). So: admins
 * send instantly here; members + any bridge hiccup are covered by the VPS daemon.
 *
 * Failure modes (best-effort): timeout / bridge offline / role denied →
 * row stays at status='queued' and the VPS consumer drains it on its next poll.
 * Never blocks the queue confirmation.
 */
async function triggerImmediateSend(
  req: NextRequest,
  args: {
    to: string;
    subject: string;
    body: string;
    leadId: string;
    brand?: string;
    signer: { name: string; email: string; phone: string };
    /**
     * Who to copy: the lead's assigned rep first, then the sender when that is
     * someone else. A list, because a lead can be worked by a rep who did not
     * press the button — bridge_tools._tool_send_email accepts either a list or
     * a comma-separated string and normalises both through normalize_cc.
     */
    cc?: string[];
  },
): Promise<
  | { status: "sent"; agent_source?: string }
  | { status: "queued"; reason: string }
> {
  try {
    const url = new URL("/api/bridge/exec-tool", req.url);
    const cookie = req.headers.get("cookie") || "";
    const sendRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        tool_name: "send_email",
        to: args.to,
        subject: args.subject,
        body: args.body,
        lead_id: args.leadId,
        brand: args.brand,
        intent: "transactional",
        // CC THE REP WHO SENT IT.
        //
        // This path sends from the BRAND mailbox, not the rep's, because no rep
        // on this tenant has a mailbox connected (user_integration_credentials
        // is empty for it), so the app-password and OAuth branches above are
        // never taken. The rep therefore had no copy anywhere: not in their
        // Sent, not in their Inbox. Ariel reported an email as "never sent"
        // on 2026-09-08 that the ledger shows went out — she simply had no way
        // to see it, and pressed the button a second time, producing a
        // duplicate row.
        //
        // The whole chain already supported this and nobody had connected it:
        // send_gateway.py takes --cc and writes the Cc header, and
        // bridge_tools._tool_send_email accepts `cc` (added 2026-05-31 for
        // SunBiz's shared-inbox model, with the note "the operator must be CC'd
        // or they never see the reply"). exec-tool forwards the payload
        // verbatim, so this reaches it unchanged.
        // Length-checked, not truthiness-checked: [] is truthy in JS, so a lead
        // with nobody to copy would have sent `cc: []` and relied on the far
        // side to discard it.
        ...(args.cc && args.cc.length ? { cc: args.cc } : {}),
        // Per-operator signing — bridge tool sets BRAVO_FROM_*_SUNBIZ
        // env on the send_gateway subprocess so the signature renders
        // THIS operator's identity (Jordan / Alex / Matt) instead of
        // the brand default. Same pattern as shop-out.
        signer_name: args.signer.name,
        signer_email: args.signer.email,
        signer_phone: args.signer.phone,
      }),
      signal: AbortSignal.timeout(50_000),
    });
    if (!sendRes.ok) {
      const txt = await sendRes.text();
      return { status: "queued", reason: `exec-tool HTTP ${sendRes.status}: ${txt.slice(0, 120)}` };
    }
    const sendData = await sendRes.json();
    if (sendData?.is_error) {
      return { status: "queued", reason: String(sendData?.output || "bridge tool is_error=true").slice(0, 240) };
    }
    // _tool_send_email passes through _run_script which returns the
    // send_gateway --json blob in `output`. Status="sent" means the gate
    // walked AND the SMTP fired.
    try {
      const parsed = JSON.parse(sendData?.output || "{}");
      if (parsed?.status === "sent") {
        return { status: "sent", agent_source: "manual_cc" };
      }
      return {
        status: "queued",
        reason: `send_gateway status=${parsed?.status || "unknown"}: ${parsed?.reason || ""}`.slice(0, 240),
      };
    } catch {
      return { status: "queued", reason: "bridge tool returned non-JSON output" };
    }
  } catch (e) {
    return {
      status: "queued",
      reason: e instanceof Error ? e.message : "auto-trigger threw unknown error",
    };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT = 200;
const MAX_BODY = 32_000;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return NextResponse.json({ ok: false, error: "invalid_lead_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  const access = await assertMayWorkLead({
    teamRole: sess.teamRole,
    userId: sess.userId,
    tenantId: sess.tenantId,
    leadId,
    isOwner: sess.isTrueAdmin,
    adminAccess: sess.adminAccess,
    accessMode: "owned_oasis_sales",
  });
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error, message: access.message },
      { status: access.status },
    );
  }

  let body: { to_email?: unknown; subject?: unknown; body?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const toEmail = typeof body.to_email === "string" ? body.to_email.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const text = typeof body.body === "string" ? body.body : "";
  if (!EMAIL_RE.test(toEmail)) {
    return NextResponse.json({ ok: false, error: "invalid_email" }, { status: 400 });
  }
  if (!subject) {
    return NextResponse.json({ ok: false, error: "subject_required" }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: "body_required" }, { status: 400 });
  }

  // Opt-out gate BEFORE we queue or send — both the direct operator-Gmail path
  // and the submissions@ queue fallback bypass send_gateway's suppression here,
  // so block up front and FAIL CLOSED (a lookup error blocks). Nothing is queued
  // for a suppressed recipient. [[fail-closed-default]] (audit 2026-07-01)
  const emailSupp = await checkEmailSuppressed(sess.tenantId, toEmail);
  if (emailSupp.suppressed) {
    return NextResponse.json(
      { ok: false, error: "suppressed", message: "Recipient previously unsubscribed — send blocked." },
      { status: 409 },
    );
  }
  if (emailSupp.checkFailed) {
    return NextResponse.json(
      { ok: false, error: "suppression_check_failed", message: "Could not verify unsubscribe status — send blocked (fail-closed)." },
      { status: 503 },
    );
  }

  const db = getServiceSupabase();
  const truncatedBody = text.slice(0, MAX_BODY);
  const truncatedSubject = subject.slice(0, MAX_SUBJECT);

  // Insert the queued interaction. send_gateway.py polls
  // lead_interactions WHERE status='queued' AND channel='email' and
  // performs the actual send + status update.
  const ins = await db
    .from("lead_interactions")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: leadId,
      // type is NOT NULL — explicit. 'email_queued' distinguishes
      // dashboard-queued rows from daemon-sent rows ('email_sent')
      // so send_gateway can pick them up without re-sending the
      // existing 275 historical 'email_sent' rows.
      type: "email_queued",
      channel: "email",
      direction: "outbound",
      agent_source: "dashboard_drawer",
      // Canonical "who queued this" — companion to migration 078.
      // metadata.acted_by_user_id retained for the consumer daemon
      // which already reads from it.
      actor_user_id: sess.userId,
      subject: truncatedSubject,
      content: truncatedBody,
      content_preview: truncatedBody.slice(0, 1024),
      to_email: toEmail,
      metadata: {
        requested_by_profile_id: sess.profileId,
        requested_by_email: sess.email,
        // Phase 4 SunBiz multi-employee personalization: the consumer
        // daemon reads acted_by_user_id and, if the user has connected
        // their personal Gmail via Settings → Personal, sends from
        // THEIR address instead of the tenant-shared submissions@.
        acted_by_user_id: sess.userId,
        status: "queued",
      },
    })
    .select("id, created_at")
    .single();
  if (ins.error) {
    return NextResponse.json({ ok: false, error: ins.error.message }, { status: 500 });
  }
  const trackingWarnings: string[] = [];
  const queuedAt =
    typeof ins.data.created_at === "string" && Number.isFinite(Date.parse(ins.data.created_at))
      ? new Date(ins.data.created_at).toISOString()
      : new Date().toISOString();
  try {
    await persistCanonicalLeadTouch(db, {
      tenantId: sess.tenantId,
      leadId,
      occurredAt: queuedAt,
    });
  } catch (err) {
    trackingWarnings.push("canonical_touch_failed");
    console.error("[leads.email] canonical touch update failed", err);
  }

  // Phase 3 spine live-refresh (plan §7): the insert above just fired the
  // conv_thread_upsert trigger (when the migration is applied), so nudge any
  // open Conversations tab to refresh. Best-effort/fail-silent — see
  // lib/realtime/conversations-nudge.ts.
  await nudgeConversations(sess.tenantId);

  // Emit an agent_event so send_gateway's event-bus listener picks it
  // up immediately instead of waiting for its next poll cycle.
  // Failure to emit is non-fatal — the daemon's polling fallback will
  // still find the row. Uses the canonical publishAgentEvent helper so
  // the schema (correlation_id, publisher_agent, severity) is right.
  await publishAgentEvent({
    eventType: "BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD",
    tenantId: sess.tenantId,
    publisher: "dashboard",
    targetAgent: "send_gateway",
    payload: {
      lead_id: leadId,
      interaction_id: ins.data.id,
      channel: "email",
      to_email: toEmail,
    },
  });

  // Engine moves the lead forward through the sales motion. For SunBiz
  // that's imported → sent_application; for OASIS that's researched/
  // assigned → attempting_contact. The dispatcher picks the right rules
  // based on tenant.
  // Engine guards manual overrides so an operator-set stage isn't yanked.
  let stageBumped: string | null = null;
  try {
    const stageEvent = await dispatchLeadStageEvent({
      type: "outbound_email_queued",
      tenantId: sess.tenantId,
      leadId,
    });
    stageBumped = stageEvent.fired ? stageEvent.to : null;
  } catch (err) {
    trackingWarnings.push("stage_dispatch_failed");
    console.error("[leads.email] stage dispatch failed", err);
  }

  // Resolve tenant slug → brand for the auto-trigger. send_gateway
  // defaults to OASIS brand if unset, which would ship a SunBiz lead
  // email under the wrong identity. One extra lookup; cheap.
  const tenantRes = await db
    .from("tenants")
    .select("slug")
    .eq("id", sess.tenantId)
    .maybeSingle();
  if (tenantRes.error) {
    trackingWarnings.push("tenant_brand_lookup_failed");
    console.error("[leads.email] tenant brand lookup failed", tenantRes.error);
  }
  const tenantSlug = (tenantRes.data as { slug: string } | null)?.slug || "";
  const brand =
    tenantSlug === "submissions" ? "sunbiz" : tenantSlug ? "oasis" : undefined;

  // Resolve operator → signer (shared helper, same shape as shop-out
  // and lender-threads retry).
  // Brand passed explicitly: the signer fallback is otherwise a hardcoded
  // SunBiz identity, which is what put "SunBiz Submissions" at the bottom of
  // OASIS lead emails above an OASIS footer.
  const signer = resolveSignerForOperator(sess.email, { brand });

  /**
   * Who gets copied: the rep the lead BELONGS to, then the person who sent it.
   *
   * Why a copy is not optional. On this tenant no rep has a mailbox connected
   * (user_integration_credentials holds zero rows for it), so every send leaves
   * from a shared mailbox. The rep's Sent folder stays empty and their Inbox
   * never sees it, so from where they sit a successful send and a total failure
   * look identical — which is precisely what happened on 2026-09-08: a send the
   * ledger records as delivered was reported as "never sent", and pressing the
   * button again produced a duplicate.
   *
   * Why it is keyed on ASSIGNMENT rather than on who pressed the button
   * (CC, 2026-09-09). The previous version copied `sess.email` alone, which got
   * both halves wrong at once. The rep who owns the lead was never copied —
   * Broadway Locksmith is schneur@oasisai.work's, and he saw nothing. And when
   * the sender IS the shared mailbox, it copied that mailbox onto its own
   * outgoing mail: From, Cc and Reply-To all one address, a duplicate of
   * something already in its own Sent folder.
   *
   * The lead's assignee is now first in the list, so they are copied whoever
   * sends, and they become the Reply-To — a prospect's answer should reach the
   * person holding the relationship. The sending mailbox is excluded inside the
   * sender, which is the only layer that knows its own From address.
   */
  // The route never loaded the lead before now. `assigned_to` was read in only
  // one place — assertMayWorkLead's non-admin branch — and an admin skips that
  // query entirely, which is why an admin's send could never have found the
  // assignee even in principle. Soft-fails: a lookup error costs the rep copy,
  // never the prospect's email.
  const { data: leadRow, error: leadRowError } = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", sess.tenantId)
    .eq("entity_type", "lead")
    .eq("id", leadId)
    .maybeSingle();
  if (leadRowError) trackingWarnings.push("assignee_lead_read_failed");
  const leadData = (leadRow?.data || {}) as Record<string, unknown>;

  const assignee = await resolveAssigneeEmail(
    sess.tenantId,
    typeof leadData.assigned_to === "string" ? leadData.assigned_to : null,
  );
  // An owner who should have been copied and was not is worth a warning. Without
  // this, a failed roster read looks exactly like an unassigned lead and the
  // send still reports success — the rep simply never hears about their lead.
  if (assignee.status === "lookup_failed") trackingWarnings.push("assignee_lookup_failed");
  if (assignee.status === "no_address") trackingWarnings.push("assignee_has_no_address");
  const assignedRepEmail = assignee.status === "resolved" ? assignee.email : null;
  // The sending mailbox is excluded HERE, not only inside the shared sender.
  // The bridge fallback leaves from the same address and has no way to know it,
  // so a send that fell through to the bridge could still copy the From address
  // onto its own message. Excluding once, at the point the list is built, closes
  // every transport at the same place.
  const oasisMailboxFrom = brand === "oasis" ? await resolveOasisMailboxFrom(sess.tenantId) : null;
  const copyList = buildCopyList({
    assignedRepEmail,
    senderEmail: sess.email,
    toEmail,
    excludeAddresses: [oasisMailboxFrom],
  });

  // Send. Preference order:
  //   1. The operator's OWN connected Gmail (immediate, from THEIR address) —
  //      the personal-send path the Phase-4 comment above anticipated.
  //   2. Fall back to the submissions@ queue (bridge → send_gateway) when the
  //      operator hasn't connected Gmail, or their token is dead/send fails.
  type SendOutcome =
    | { status: "sent"; agent_source?: string; via?: string; from_address?: string }
    | { status: "queued"; reason: string };
  let sendResult: SendOutcome;
  let gmailFrom: string | null = null;
  let gmailMsgId: string | null = null;

  // Send preference: operator app-password (our OAuth-free working path — sends
  // FROM the operator's own address) → operator OAuth → submissions@ queue. Each
  // path falls through to the next on any failure so the email still goes out.
  const queueFallback = async (): Promise<SendOutcome> => {
    // SunBiz's shared submissions mailbox is provisioned in encrypted tenant
    // integrations. Use that App Password directly before relying on the
    // bridge/daemon, so dashboard merchant emails work from Vercel itself.
    if (brand === "sunbiz") {
      const signedBody = appendSignatureAndFooter(truncatedBody, {
        signer,
        fromAddress: "submissions@sunbizfunding.com",
      });
      const shared = await sendGmail({
        tenantId: sess.tenantId,
        brand: "sunbiz",
        to: toEmail,
        subject: truncatedSubject,
        body: signedBody,
        retryTransient: false,
      });
      if (shared.ok) {
        return {
          status: "sent",
          agent_source: "submissions_gmail_apppassword",
          via: "submissions_gmail_apppassword",
          from_address: shared.from_identity,
        };
      }
    }
    // OASIS: the shared team mailbox, from Vercel, with the rep CC'd.
    //
    // Tried BEFORE the bridge because the bridge runs send_gateway on CC's own
    // machine and is only alive while that machine is — five emails have sat
    // queued since 2026-08-20 for exactly that reason. This path has no such
    // dependency.
    //
    // Falls through silently when the mailbox is not configured yet, so the
    // behaviour before the credential is stored is byte-for-byte what shipped
    // today. Nothing to roll back if it is never set.
    if (brand === "oasis") {
      const shared = await sendOasisSharedGmail({
        tenantId: sess.tenantId,
        to: toEmail,
        cc: copyList,
        replyTo: pickReplyTo(copyList),
        subject: truncatedSubject,
        body: truncatedBody,
        // THE HTML IS A RENDERING OF `body`, NEVER A SECOND COMPOSITION.
        //
        // Same string, dressed. The rep edits plain text in the composer and
        // that edit has to be what the prospect reads, so the markup is derived
        // from the final text rather than assembled in parallel — two authored
        // versions would drift the first time a rep changed a word, and only
        // one of them gets reviewed.
        //
        // `body` also stays the plain-text alternative on the wire and the
        // string stored in lead_interactions.content_preview, which the
        // conversations thread renders as escaped text. Storing markup there
        // would put tags in the rep's own timeline.
        //
        // Deliberately ONLY on this branch. The operator-Gmail senders hardcode
        // Content-Type: text/plain, and send_gateway auto-promotes anything
        // HTML-shaped into an html part while tag-stripping the text — so a
        // body that carried markup would render differently on each transport,
        // and correctly on none.
        html: renderQuickEmailHtml(truncatedBody, {
          signerName: signer?.name ?? null,
          signerEmail: pickReplyTo(copyList),
          preheader: truncatedSubject,
        }),
        signer,
      });
      if (shared.ok) {
        // RECORD THE RECEIPT. Two reasons, and the first one already cost us a
        // day: Ariel's 2026-09-08 send stored from_email and provider as NULL,
        // so there was no way to tell from the row WHICH path had sent it or
        // from which mailbox, and the incident had to be traced through code
        // instead of read off the ledger.
        //
        // The second is not cosmetic. The rep is CC'd, so the message also
        // arrives in monitored work mail, and that ingest de-duplicates on
        // metadata.gmail_message_id. A row without the id does not match, and
        // the same message gets inserted a second time as if it were inbound.
        gmailFrom = shared.from_address;
        gmailMsgId = shared.gmail_message_id;
        return {
          status: "sent",
          agent_source: "oasis_shared_gmail",
          via: "oasis_shared_gmail",
          from_address: shared.from_address,
        };
      }
      // A SUPPRESSED recipient is a decision, not a transport failure. Falling
      // through to the bridge here would re-attempt a send to someone who has
      // opted out — the gateway would refuse it again, but only by luck of
      // having its own gate. Stop here and say so.
      if (shared.reason === "suppressed" || shared.reason === "suppression_error") {
        return { status: "queued", reason: `oasis_shared_gmail: ${shared.error}`.slice(0, 240) };
      }
    }

    return triggerImmediateSend(req, {
      to: toEmail,
      subject: truncatedSubject,
      body: truncatedBody,
      leadId,
      brand,
      signer,
      // Assigned rep first, then the sender. bridge_tools._tool_send_email
      // accepts a list and normalises it through send_gateway.normalize_cc,
      // so all three call sites agree on the shape.
      cc: copyList,
    });
  };

  if (await operatorHasAppPassword(sess.tenantId, sess.userId)) {
    const g = await sendGmailAppPasswordAsOperator({
      tenantId: sess.tenantId,
      userId: sess.userId,
      to: toEmail,
      // The assignee is copied on EVERY transport, not only the shared mailbox.
      // This branch runs when the SENDER has their own mailbox connected, which
      // gives the sender a Sent copy and still leaves the rep who owns the lead
      // with nothing — the half of the problem that has nothing to do with which
      // transport carried the message. The sender filters out its own From.
      cc: copyList,
      subject: truncatedSubject,
      body: truncatedBody,
      // Session-resolved rep — the direct path signs "— Jordan" etc. exactly
      // like the queue path does (parity fix 2026-07-10).
      signer,
    });
    if (g.ok) {
      sendResult = { status: "sent", agent_source: "gmail_apppassword", via: "gmail_apppassword", from_address: g.from_address };
      gmailFrom = g.from_address;
      gmailMsgId = g.gmail_message_id;
    } else {
      // not_connected / send_failed → fall back to the queue (the daemon re-checks
      // suppression, so a suppressed recipient still won't actually go out).
      sendResult = await queueFallback();
    }
  } else if (await operatorHasGmailOAuth(sess.tenantId, sess.userId)) {
    const g = await sendGmailAsOperator({
      tenantId: sess.tenantId,
      userId: sess.userId,
      to: toEmail,
      // Same reason as the app-password branch above.
      cc: copyList,
      subject: truncatedSubject,
      body: truncatedBody,
      // Session-resolved rep — the direct path signs "— Jordan" etc. exactly
      // like the queue path does (parity fix 2026-07-10).
      signer,
    });
    if (g.ok) {
      sendResult = { status: "sent", agent_source: "gmail_oauth", via: "gmail_oauth", from_address: g.from_address };
      gmailFrom = g.from_address;
      gmailMsgId = g.gmail_message_id;
    } else {
      // not_connected / refresh_failed / send_failed → fall back to the queue so
      // the email still goes out via submissions@.
      sendResult = await queueFallback();
    }
  } else {
    sendResult = await queueFallback();
  }

  // If the send actually fired, flip the queued row to sent so the timeline
  // reflects reality and the daemon doesn't double-send. Non-fatal on failure.
  if (sendResult.status === "sent") {
    const statusUpdate = await db
      .from("lead_interactions")
      .update({
        metadata: {
          requested_by_profile_id: sess.profileId,
          requested_by_email: sess.email,
          acted_by_user_id: sess.userId,
          status: gmailFrom ? "sent" : "auto_sent",
          sent_via: sendResult.agent_source,
          ...(gmailFrom ? { from_address: gmailFrom } : {}),
          ...(gmailMsgId ? { gmail_message_id: gmailMsgId } : {}),
          sent_at: new Date().toISOString(),
        },
      })
      .eq("id", ins.data.id)
      .eq("tenant_id", sess.tenantId);
    if (statusUpdate.error) {
      trackingWarnings.push("interaction_status_update_failed");
      console.error("[leads.email] sent status update failed", statusUpdate.error);
    }
  }

  return NextResponse.json({
    ok: true,
    interaction_id: ins.data.id,
    queued_at: ins.data.created_at,
    stage_bumped: stageBumped,
    tracking_warning: trackingWarnings.length ? trackingWarnings.join(",") : null,
    // Real send outcome — UI uses this to render "Sent" vs "Queued
    // (retrying)" vs the explicit error reason.
    send_status: sendResult,
  });
}
