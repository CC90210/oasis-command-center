/**
 * POST /api/leads/[id]/email — send an outbound email to a lead from
 * the dashboard, with the background consumer as the final fallback.
 *
 * On OASIS, the route first writes a private `direct_reserved` row. Immediately
 * before the first provider call it atomically becomes `direct_attempting`.
 * Confirmed delivery is terminal, confirmed pre-delivery failure may become
 * queued, and an ambiguous provider result becomes `delivery_unknown` and is
 * never retried automatically. Other tenants retain their established path.
 *
 * Auth: session-cookie → tenant.
 * Body: { to_email: string, subject: string, body: string }
 */

import { randomUUID } from "node:crypto";
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
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import { persistCanonicalLeadTouch } from "@/lib/leads/canonical-touch";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { buildCopyList, leadEmailCopiesReps, pickReplyTo } from "@/lib/leads/lead-copy-recipients";
import { resolveAssigneeEmail } from "@/lib/leads/assignee-email";
import { renderQuickEmailHtml } from "@/lib/leads/quick-email-html";
import { gmailMessageIdForIdempotencyKey } from "@/lib/integrations/email-delivery-safety";

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
 * for non-admin). A tenant-scoped fallback consumer drains that queue on its
 * configured host, so members and bridge interruptions still have a recovery
 * path without one tenant's worker claiming another tenant's mail.
 *
 * Failure modes: timeout / bridge offline / role denied return a fallback
 * outcome. On OASIS, the caller then atomically exposes the reservation as
 * `queued`; the configured fallback consumer drains it on its next poll.
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

/** A structured refusal made before any provider or durable queue boundary.
 * Clients may safely preserve the draft and offer retry only when this marker
 * is present. Every later failure is intentionally treated as unconfirmed. */
function emailNotStarted(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(
    { ok: false, delivery_state: "not_started", ...payload },
    { status },
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await ctx.params;
  if (!UUID_RE.test(leadId)) {
    return emailNotStarted({ error: "invalid_lead_id" }, 400);
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return emailNotStarted({ error: sess.reason }, 401);
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
    return emailNotStarted(
      { error: access.error, message: access.message },
      access.status,
    );
  }

  let body: { to_email?: unknown; subject?: unknown; body?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return emailNotStarted({ error: "invalid_json" }, 400);
  }
  const toEmail = typeof body.to_email === "string" ? body.to_email.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const text = typeof body.body === "string" ? body.body : "";
  if (!EMAIL_RE.test(toEmail)) {
    return emailNotStarted({ error: "invalid_email" }, 400);
  }
  if (!subject) {
    return emailNotStarted({ error: "subject_required" }, 400);
  }
  if (!text.trim()) {
    return emailNotStarted({ error: "body_required" }, 400);
  }

  // Opt-out gate BEFORE we queue or send — both the direct operator-Gmail path
  // and the submissions@ queue fallback bypass send_gateway's suppression here,
  // so block up front and FAIL CLOSED (a lookup error blocks). Nothing is queued
  // for a suppressed recipient. [[fail-closed-default]] (audit 2026-07-01)
  const emailSupp = await checkEmailSuppressed(sess.tenantId, toEmail);
  if (emailSupp.suppressed) {
    return emailNotStarted(
      { error: "suppressed", message: "Recipient previously unsubscribed — send blocked." },
      409,
    );
  }
  if (emailSupp.checkFailed) {
    return emailNotStarted(
      { error: "suppression_check_failed", message: "Could not verify unsubscribe status — send blocked (fail-closed)." },
      503,
    );
  }

  const db = getServiceSupabase();
  const truncatedBody = text.slice(0, MAX_BODY);
  const truncatedSubject = subject.slice(0, MAX_SUBJECT);

  // ---- RESOLVE THE SENDING IDENTITY BEFORE QUEUEING ANYTHING ------------
  //
  // This block used to sit AFTER the insert below, and CodeRabbit was right to
  // call that critical: the row is queued and an agent_event is published
  // before the check ran, so returning 409 refused the CALLER while leaving a
  // queued row that dashboard_email_consumer would then drain and send — under
  // its own _DEFAULT_BRAND, which is the exact default this work removes. A
  // guard that returns an error while the message still goes out is worse than
  // no guard, because the operator is told it was stopped.
  //
  // Resolved from an explicit, fail-closed map (lib/email/brand-for-tenant.ts).
  // It was: `tenantSlug === "submissions" ? "sunbiz" : tenantSlug ? "oasis" : undefined`
  // — the lookup only WARNS on error, so a transient failure made brand
  // `undefined`, which every downstream helper read as SunBiz; and the middle
  // branch branded EVERY non-SunBiz tenant OASIS, across 49 live tenants of
  // which 47 are self-signup accounts including real third parties.
  const tenantRes = await db
    .from("tenants")
    .select("slug")
    .eq("id", sess.tenantId)
    .maybeSingle();
  const tenantSlug = (tenantRes.data as { slug: string } | null)?.slug || "";
  const brand = brandForTenant({ tenantId: sess.tenantId, tenantSlug });
  if (!brand) {
    // Nothing has been queued yet, so this refusal actually refuses.
    return emailNotStarted(
      {
        error: "no_sending_brand",
        detail:
          `This workspace (${tenantSlug || sess.tenantId}) has no sending identity configured, ` +
          "so nothing was queued or sent. Map it in lib/email/brand-for-tenant.ts.",
      },
      409,
    );
  }
  const directReservedAt = new Date().toISOString();
  const attemptToken = randomUUID();
  const rfc822MessageId = gmailMessageIdForIdempotencyKey(attemptToken);

  // Reserve the interaction before attempting any transport, but do NOT make
  // it drainable and do not yet claim that a provider call began. A terminated
  // request in `direct_reserved` is safely queueable by the cron reconciler; a
  // terminated request in `direct_attempting` is not, because delivery may have
  // succeeded before its response was lost.
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
        status: brand === "oasis" ? "direct_reserved" : "queued",
        ...(brand === "oasis"
          ? {
              direct_reserved_at: directReservedAt,
              attempt_token: attemptToken,
              rfc822_message_id: rfc822MessageId,
            }
          : {}),
      },
    })
    .select("id, created_at")
    .single();
  if (ins.error) {
    return emailNotStarted({ error: ins.error.message }, 500);
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

  // Preserve the established queue-first behavior for every other tenant. The
  // OASIS path publishes only after its direct reservation becomes queued.
  if (brand !== "oasis") {
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
  }

  // Engine moves the lead forward through the sales motion. For SunBiz
  // that's imported → sent_application; for OASIS that's researched/
  // assigned → attempting_contact. The dispatcher picks the right rules
  // based on tenant.
  // Engine guards manual overrides so an operator-set stage isn't yanked.
  let stageBumped: string | null = null;
  const bumpLeadStage = async () => {
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
  };
  if (brand !== "oasis") {
    await bumpLeadStage();
  }

  // brand + tenantSlug were resolved BEFORE the queue insert above, so a
  // tenant with no sending identity never gets a queued row at all.
  if (tenantRes.error) {
    trackingWarnings.push("tenant_brand_lookup_failed");
    console.error("[leads.email] tenant brand lookup failed", tenantRes.error);
  }

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
  // OASIS ONLY. All of this was built for OASIS's shared mailbox and reached
  // SunBiz because the route is shared: a merchant's email from a rep's own
  // Gmail or the bridge started carrying the lead's rep and the sender in Cc,
  // and every SunBiz send picked up a lead read, a roster lookup and warnings
  // it never had. Before #405 this route copied nobody on SunBiz. There the
  // list stays empty, which every transport below already sends with no Cc
  // header. See leadEmailCopiesReps.
  let oasisMailboxFrom: string | null = null;
  let copyList: string[] = [];
  if (leadEmailCopiesReps(brand)) {
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
    oasisMailboxFrom = brand === "oasis" ? await resolveOasisMailboxFrom(sess.tenantId) : null;
    copyList = buildCopyList({
      assignedRepEmail,
      senderEmail: sess.email,
      toEmail,
      excludeAddresses: [oasisMailboxFrom],
    });
  }

  // ---- WHO SIGNS THE MESSAGE ---------------------------------------------
  //
  // ONE person signs it, and on a SHARED mailbox that person is whoever gets
  // the reply — not whoever pressed the button.
  //
  // The sign-off used to take its NAME from the acting operator and its
  // ADDRESS from the lead's owner. CC pressed send on a lead of Ariel's and
  // the prospect received "Conaugh" printed above "ariel@oasisai.work"
  // (CC, 2026-09-09: "signing off as my name, and under that, it's the rep's
  // email, which is just a bit confusing"). Whoever is NAMED must be whoever
  // is REACHABLE, or the signature is a promise the message cannot keep.
  //
  // Resolved HERE rather than inside one transport branch, because two
  // transports send from the shared mailbox — the direct Vercel sender and the
  // bridge fallback — and fixing only the one that happened to be reported
  // would leave the other signing the operator's name the next time the first
  // was unavailable.
  //
  // OASIS ONLY, deliberately. SunBiz mail signs with its shared roster
  // identity resolved from the ACTING operator, which is correct there and is
  // what lender and merchant correspondence relies on; re-anchoring it to the
  // assignee would change a client's live behaviour to fix a problem it does
  // not have.
  //
  // The operator-Gmail branches below are untouched for the same reason: they
  // send from the operator's OWN address, so the operator's own name above it
  // is already coherent.
  const replyToAddress = pickReplyTo(copyList);
  const messageSigner =
    brand === "oasis" && replyToAddress
      ? resolveSignerForOperator(replyToAddress, { brand })
      : signer;

  // Send. Preference order:
  //   1. The operator's OWN connected Gmail (immediate, from THEIR address) —
  //      the personal-send path the Phase-4 comment above anticipated.
  //   2. Fall back to the submissions@ queue (bridge → send_gateway) when the
  //      operator hasn't connected Gmail, or their token is dead/send fails.
  type SendOutcome =
    | { status: "sent"; agent_source?: string; via?: string; from_address?: string }
    | { status: "queued"; reason: string }
    | { status: "delivery_unknown"; reason: string }
    | { status: "blocked"; reason: string }
    | { status: "reservation_failed"; reason: string };
  let sendResult: SendOutcome;
  let gmailFrom: string | null = null;
  let gmailMsgId: string | null = null;
  let oasisReservationState: "direct_reserved" | "direct_attempting" = "direct_reserved";
  let directAttemptStartedAt: string | null = null;

  // Move the private reservation to `direct_attempting` immediately before the
  // first provider call. A compare-and-set failure stops the send: proceeding
  // without a durable marker would let the stale reconciler queue the same row.
  const beginOasisDirectAttempt = async (): Promise<string | null> => {
    if (brand !== "oasis" || oasisReservationState === "direct_attempting") return null;
    const startedAt = new Date().toISOString();
    try {
      const started = await db
        .from("lead_interactions")
        .update({
          metadata: {
            requested_by_profile_id: sess.profileId,
            requested_by_email: sess.email,
            acted_by_user_id: sess.userId,
            status: "direct_attempting",
            direct_reserved_at: directReservedAt,
            direct_attempt_started_at: startedAt,
            attempt_token: attemptToken,
            rfc822_message_id: rfc822MessageId,
          },
        })
        .eq("id", ins.data.id)
        .eq("tenant_id", sess.tenantId)
        .eq("metadata->>status", "direct_reserved")
        .eq("metadata->>attempt_token", attemptToken)
        .select("id")
        .maybeSingle();
      if (started.error || !started.data?.id) {
        throw started.error || new Error("reservation_state_mismatch");
      }
    } catch (err) {
      console.error("[leads.email] direct attempt transition failed", {
        interaction_id: ins.data.id,
        tenant_id: sess.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return err instanceof Error ? err.message : "reservation_transition_failed";
    }
    oasisReservationState = "direct_attempting";
    directAttemptStartedAt = startedAt;
    return null;
  };

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
        // Inside `if (brand === "sunbiz")`, so this is SunBiz by construction —
        // stated rather than inherited from a default that no longer exists.
        brand: "sunbiz",
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
      // No provider is configured, so no delivery attempt happened. The row
      // remains `direct_reserved` and is safe to expose to the durable queue.
      if (!oasisMailboxFrom) {
        return { status: "queued", reason: "no immediate OASIS mailbox configured" };
      }
      const reservationError = await beginOasisDirectAttempt();
      if (reservationError) {
        return { status: "reservation_failed", reason: reservationError };
      }
      const shared = await sendOasisSharedGmail({
        tenantId: sess.tenantId,
        to: toEmail,
        cc: copyList,
        replyTo: replyToAddress,
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
          // Both halves from the SAME person — see messageSigner above.
          signerName: messageSigner?.name ?? null,
          signerEmail: replyToAddress,
          preheader: truncatedSubject,
        }),
        // ...and the plain-text alternative signs identically. A prospect whose
        // client blocks HTML must not see a different name from one who does.
        signer: messageSigner,
        idempotencyKey: attemptToken,
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
      if (
        shared.reason === "suppressed" ||
        shared.reason === "suppression_error" ||
        shared.reason === "brand_mismatch"
      ) {
        return { status: "blocked", reason: `oasis_shared_gmail: ${shared.error}`.slice(0, 240) };
      }
      if (shared.reason === "delivery_unknown") {
        return {
          status: "delivery_unknown",
          reason: `oasis_shared_gmail: ${shared.error}`.slice(0, 240),
        };
      }
      // A confirmed pre-delivery failure is handed to the durable queue. Do
      // not call the bridge synchronously here: losing its response after a
      // successful send would make an automatic fallback a duplicate.
      return { status: "queued", reason: `oasis_shared_gmail: ${shared.error}`.slice(0, 240) };
    }

    return triggerImmediateSend(req, {
      to: toEmail,
      subject: truncatedSubject,
      body: truncatedBody,
      leadId,
      brand,
      // Same signer as the direct shared-mailbox path above. This branch also
      // sends from the shared mailbox, so it had the identical defect: it
      // signed with the acting operator's name while the reply went to the
      // lead's owner.
      signer: messageSigner,
      // Assigned rep first, then the sender. bridge_tools._tool_send_email
      // accepts a list and normalises it through send_gateway.normalize_cc,
      // so all three call sites agree on the shape.
      cc: copyList,
    });
  };

  if (await operatorHasAppPassword(sess.tenantId, sess.userId)) {
    const reservationError = await beginOasisDirectAttempt();
    if (reservationError) {
      return NextResponse.json(
        {
          ok: false,
          error: "direct_reservation_transition_failed",
          interaction_id: ins.data.id,
          message: "The send could not be confirmed. Check the timeline before trying again.",
        },
        { status: 503 },
      );
    }
    const g = await sendGmailAppPasswordAsOperator({
      ...(brand === "oasis" ? { idempotencyKey: attemptToken } : {}),
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
      // The rep's own mailbox carries the message, but the FOOTER is the
      // company's. Without this the helper defaulted to SunBiz, so a rep on an
      // OASIS lead sent a prospect the client's legal identity.
      brand,
    });
    if (g.ok) {
      sendResult = { status: "sent", agent_source: "gmail_apppassword", via: "gmail_apppassword", from_address: g.from_address };
      gmailFrom = g.from_address;
      gmailMsgId = g.gmail_message_id;
    } else if (brand === "oasis" && g.reason === "delivery_unknown") {
      sendResult = {
        status: "delivery_unknown",
        reason: `gmail_apppassword: ${g.error}`.slice(0, 240),
      };
    } else if (
      brand === "oasis" &&
      (g.reason === "suppressed" || g.reason === "suppression_error")
    ) {
      sendResult = { status: "blocked", reason: `gmail_apppassword: ${g.error}`.slice(0, 240) };
    } else {
      // not_connected / send_failed → fall back to the queue (the daemon re-checks
      // suppression, so a suppressed recipient still won't actually go out).
      sendResult = await queueFallback();
    }
  } else if (await operatorHasGmailOAuth(sess.tenantId, sess.userId)) {
    const reservationError = await beginOasisDirectAttempt();
    if (reservationError) {
      return NextResponse.json(
        {
          ok: false,
          error: "direct_reservation_transition_failed",
          interaction_id: ins.data.id,
          message: "The send could not be confirmed. Check the timeline before trying again.",
        },
        { status: 503 },
      );
    }
    const g = await sendGmailAsOperator({
      ...(brand === "oasis" ? { idempotencyKey: attemptToken } : {}),
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
      // Same reason as the app-password branch: the mailbox is the rep's, the
      // legal footer is the company's.
      brand,
    });
    if (g.ok) {
      sendResult = { status: "sent", agent_source: "gmail_oauth", via: "gmail_oauth", from_address: g.from_address };
      gmailFrom = g.from_address;
      gmailMsgId = g.gmail_message_id;
    } else if (brand === "oasis" && g.reason === "delivery_unknown") {
      sendResult = {
        status: "delivery_unknown",
        reason: `gmail_oauth: ${g.error}`.slice(0, 240),
      };
    } else if (
      brand === "oasis" &&
      (g.reason === "suppressed" ||
        g.reason === "suppression_error" ||
        g.reason === "sender_mismatch")
    ) {
      sendResult = { status: "blocked", reason: `gmail_oauth: ${g.error}`.slice(0, 240) };
    } else {
      // not_connected / refresh_failed / send_failed → fall back to the queue so
      // the email still goes out via submissions@.
      sendResult = await queueFallback();
    }
  } else {
    sendResult = await queueFallback();
  }

  if (sendResult.status === "reservation_failed") {
    return NextResponse.json(
      {
        ok: false,
        error: "direct_reservation_transition_failed",
        interaction_id: ins.data.id,
        message: "The send could not be confirmed. Check the timeline before trying again.",
      },
      { status: 503 },
    );
  }

  // Only now, after every immediate transport declined or failed, may the OASIS
  // fallback consumer see the row. This is a compare-and-set from our private
  // reservation state: a terminal receipt can never be put back on the queue.
  if (brand === "oasis" && sendResult.status === "queued") {
    const queuedAt = new Date().toISOString();
    try {
      const queueTransition = await db
        .from("lead_interactions")
        .update({
          metadata: {
            requested_by_profile_id: sess.profileId,
            requested_by_email: sess.email,
            acted_by_user_id: sess.userId,
            status: "queued",
            direct_reserved_at: directReservedAt,
            attempt_token: attemptToken,
            rfc822_message_id: rfc822MessageId,
            ...(directAttemptStartedAt
              ? { direct_attempt_started_at: directAttemptStartedAt }
              : {}),
            queued_at: queuedAt,
            queue_reason: sendResult.reason,
          },
        })
        .eq("id", ins.data.id)
        .eq("tenant_id", sess.tenantId)
        .eq("metadata->>status", oasisReservationState)
        .eq("metadata->>attempt_token", attemptToken)
        .select("id")
        .maybeSingle();
      if (queueTransition.error || !queueTransition.data?.id) {
        throw queueTransition.error || new Error("reservation_state_mismatch");
      }
    } catch (err) {
      console.error("[leads.email] queue transition failed", {
        interaction_id: ins.data.id,
        tenant_id: sess.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        {
          ok: false,
          error: "queue_transition_failed",
          interaction_id: ins.data.id,
          message: "Direct delivery did not complete and the fallback queue could not be confirmed.",
        },
        { status: 503 },
      );
    }

    // Publish only after the row is drainable. The polling consumer can still
    // recover a queued row if publication fails, so that bookkeeping failure is
    // loud in logs and in the response warning but must not invite a resend.
    let queueEventFailure: unknown = null;
    try {
      const queueEvent = await db.from("agent_events").insert({
        event_type: "BRAVO_OUTBOUND_QUEUED_FROM_DASHBOARD",
        publisher_agent: "dashboard",
        severity: "info",
        target_agent: "send_gateway",
        correlation_id: sess.tenantId,
        payload: {
          tenant_id: sess.tenantId,
          lead_id: leadId,
          interaction_id: ins.data.id,
          channel: "email",
          to_email: toEmail,
        },
      });
      queueEventFailure = queueEvent.error;
    } catch (err) {
      queueEventFailure = err;
    }
    if (queueEventFailure) {
      trackingWarnings.push("queue_event_publish_failed");
      console.error("[leads.email] queue event publish failed", {
        interaction_id: ins.data.id,
        tenant_id: sess.tenantId,
        error:
          queueEventFailure instanceof Error
            ? queueEventFailure.message
            : String(queueEventFailure),
      });
    }
  }

  // An ambiguous delivery or a policy refusal is terminal. Freeze it for an
  // operator to review; never expose it to either automatic sender and never
  // advance the sales stage on an unconfirmed touch.
  if (
    brand === "oasis" &&
    (sendResult.status === "delivery_unknown" || sendResult.status === "blocked")
  ) {
    const terminalStatus = sendResult.status;
    try {
      const unknownTransition = await db
        .from("lead_interactions")
        .update({
          metadata: {
            requested_by_profile_id: sess.profileId,
            requested_by_email: sess.email,
            acted_by_user_id: sess.userId,
            status: terminalStatus,
            direct_reserved_at: directReservedAt,
            direct_attempt_started_at: directAttemptStartedAt,
            attempt_token: attemptToken,
            rfc822_message_id: rfc822MessageId,
            ...(terminalStatus === "delivery_unknown"
              ? { delivery_unknown_at: new Date().toISOString() }
              : { blocked_at: new Date().toISOString() }),
            send_error: sendResult.reason,
            needs_operator_review: true,
          },
        })
        .eq("id", ins.data.id)
        .eq("tenant_id", sess.tenantId)
        .eq("metadata->>status", "direct_attempting")
        .eq("metadata->>attempt_token", attemptToken)
        .select("id")
        .maybeSingle();
      if (unknownTransition.error || !unknownTransition.data?.id) {
        trackingWarnings.push("terminal_send_receipt_update_failed");
        console.error("[leads.email] terminal send receipt update failed", {
          interaction_id: ins.data.id,
          tenant_id: sess.tenantId,
          error: unknownTransition.error?.message || "reservation_state_mismatch",
        });
      }
    } catch (err) {
      trackingWarnings.push("terminal_send_receipt_update_failed");
      console.error("[leads.email] terminal send receipt update failed", {
        interaction_id: ins.data.id,
        tenant_id: sess.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A confirmed direct delivery becomes terminal from the same private
  // reservation. The queue branch above is mutually exclusive, so this row can
  // never be exposed to the consumer after a successful send.
  if (sendResult.status === "sent") {
    const sentMetadata = {
      requested_by_profile_id: sess.profileId,
      requested_by_email: sess.email,
      acted_by_user_id: sess.userId,
      status: brand === "oasis" ? "sent" : gmailFrom ? "sent" : "auto_sent",
      ...(brand === "oasis"
        ? {
            direct_reserved_at: directReservedAt,
            direct_attempt_started_at: directAttemptStartedAt,
            attempt_token: attemptToken,
            rfc822_message_id: rfc822MessageId,
          }
        : {}),
      sent_via: sendResult.agent_source,
      ...(gmailFrom ? { from_address: gmailFrom } : {}),
      ...(gmailMsgId ? { gmail_message_id: gmailMsgId } : {}),
      sent_at: new Date().toISOString(),
    };
    if (brand === "oasis") {
      try {
        const statusUpdate = await db
          .from("lead_interactions")
          .update({ metadata: sentMetadata })
          .eq("id", ins.data.id)
          .eq("tenant_id", sess.tenantId)
          .eq("metadata->>status", "direct_attempting")
          .eq("metadata->>attempt_token", attemptToken)
          .select("id")
          .maybeSingle();
        if (statusUpdate.error || !statusUpdate.data?.id) {
          trackingWarnings.push("sent_receipt_update_failed");
          console.error("[leads.email] sent receipt update failed", {
            interaction_id: ins.data.id,
            tenant_id: sess.tenantId,
            error: statusUpdate.error?.message || "reservation_state_mismatch",
          });
        }
      } catch (err) {
        trackingWarnings.push("sent_receipt_update_failed");
        console.error("[leads.email] sent receipt update failed", {
          interaction_id: ins.data.id,
          tenant_id: sess.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // The established non-OASIS path intentionally keeps its original
      // unconditional terminal receipt update.
      const statusUpdate = await db
        .from("lead_interactions")
        .update({ metadata: sentMetadata })
        .eq("id", ins.data.id)
        .eq("tenant_id", sess.tenantId);
      if (statusUpdate.error) {
        trackingWarnings.push("interaction_status_update_failed");
        console.error("[leads.email] sent status update failed", statusUpdate.error);
      }
    }
  }

  // The OASIS sales stage advances only after the message is confirmed sent or
  // the fallback reservation is confirmed queued. A failed queue transition
  // returns above and therefore cannot move a lead for an email that may vanish.
  if (brand === "oasis" && (sendResult.status === "sent" || sendResult.status === "queued")) {
    await bumpLeadStage();
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
