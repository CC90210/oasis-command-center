/**
 * lib/agents/operator-email/ingest.ts — turn monitored Gmail messages into
 * lead_interactions rows so deal email threads under the Conversations "Email"
 * section + the lead timeline.
 *
 * PRIVACY GATE (load-bearing): a message is only written if its counterparty
 * matches an existing lead (findExistingLead). Unmatched / personal mail is
 * DROPPED here — never stored, never sent to an LLM, never logged in the clear.
 * That's how "monitor work + personal inboxes but only surface deal email" holds.
 *
 * Idempotent: dedupes on metadata.gmail_message_id. DRY-RUN logs only.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { findExistingLead } from "@/lib/forms/agent-routing";
import { classifyDealEmail } from "./classify";
import { classifyLenderReply } from "@/lib/lenders/classify-reply";
import type { MonitoredMessage } from "./gmail-read";

export interface IngestResult {
  scanned: number;
  matched: number;
  ingested: number;
  dropped: number; // unmatched / personal — intentionally not stored
  skipped: number; // already ingested (dedupe)
  /**
   * Classification was still in flight, so the message was NOT written and must
   * be seen again. Counted separately from `skipped` because the caller has to
   * act on it: advancing the mailbox cursor past a deferred message loses it
   * for good.
   */
  deferred: number;
  /**
   * ISO date of the OLDEST deferred message, if any. The caller advances its
   * cursor to just before this instead of freezing it — see markProcessed.
   */
  oldestDeferredAt?: string | null;
}

function emailFromHeader(h: string): string {
  const m = String(h || "").match(/<([^>]+)>/);
  return (m ? m[1] : String(h || "")).trim().toLowerCase();
}

function toISO(dateHeader: string): string | null {
  const t = Date.parse(dateHeader);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Route an inbound reply's conversation thread to the rep who owns it
 * (2026-07-10). The conv_thread_upsert trigger (migration 112) creates/bumps
 * the thread but never sets assigned_to, so every inbound reply used to land
 * in needs_reply UNASSIGNED and reps triaged each other's deals by hand.
 *
 * Assignment preference:
 *   1. the lead's assigned rep (tenant_records data.assigned_to — the
 *      auth_user_id the lead drawer's "Assign to" writes), else
 *   2. the monitored-mailbox owner (this reply arrived in THEIR inbox).
 *
 * Only fills a NULL assigned_to — a manual assignment (threads/[key] PATCH)
 * is never clobbered. Best-effort + fail-open, same philosophy as the
 * trigger: thread routing must never break ingest.
 */
async function autoAssignThreadForInbound(
  db: ReturnType<typeof getServiceSupabase>,
  args: { tenantId: string; leadId: string; mailboxOwnerUserId: string },
): Promise<void> {
  try {
    let assignee = "";
    const rec = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", args.tenantId)
      .eq("id", args.leadId)
      .maybeSingle();
    const data = (rec.data as { data?: Record<string, unknown> } | null)?.data;
    if (data && typeof data.assigned_to === "string") assignee = data.assigned_to.trim();
    if (!assignee) assignee = (args.mailboxOwnerUserId || "").trim();
    if (!assignee) return;

    await db
      .from("conversation_threads")
      .update({ assigned_to: assignee, updated_at: new Date().toISOString() })
      .eq("tenant_id", args.tenantId)
      .eq("thread_key", `lead:${args.leadId}`)
      .is("assigned_to", null);
  } catch {
    // fail open — routing is a convenience; the interaction row is the ledger
  }
}

/**
 * Ingest a batch for one operator/mailbox. `dryRun` (monitor validation) logs
 * the decision without writing. Returns counts for the tick summary.
 */
export async function ingestMessages(
  args: { tenantId: string; userId: string; mailbox: "work" | "personal"; dryRun: boolean },
  messages: MonitoredMessage[],
): Promise<IngestResult> {
  const db = getServiceSupabase();
  const res: IngestResult = { scanned: messages.length, matched: 0, ingested: 0, dropped: 0, skipped: 0, deferred: 0, oldestDeferredAt: null };

  for (const msg of messages) {
    const fromEmail = emailFromHeader(msg.from);
    const toEmail = emailFromHeader(msg.to);
    const mailbox = (msg.mailboxAddress || "").trim().toLowerCase();
    // Direction relative to Alex's own address; counterparty is the other side.
    const outbound = !!mailbox && fromEmail === mailbox;
    const counterparty = outbound ? toEmail : fromEmail;
    if (!counterparty) { res.dropped += 1; continue; }

    // PRIVACY GATE — only deal/merchant email (matches a lead) is kept.
    let lead: { id: string } | null = null;
    try {
      lead = await findExistingLead(args.tenantId, { email: counterparty });
    } catch {
      lead = null;
    }
    // Mirror every work-mailbox message. Personal mailboxes retain the
    // deal-only privacy gate so unrelated personal email is never shared.
    if (!lead && args.mailbox === "personal") { res.dropped += 1; continue; }
    if (lead) res.matched += 1;

    // Dedupe on the Gmail message id.
    try {
      const dup = await db
        .from("lead_interactions")
        .select("id")
        .eq("tenant_id", args.tenantId)
        .filter("metadata->>gmail_message_id", "eq", msg.id)
        .limit(1);
      if (!dup.error && Array.isArray(dup.data) && dup.data.length > 0) { res.skipped += 1; continue; }
    } catch {
      // if the dedupe check errors, skip writing (fail-closed on duplicate risk)
      res.skipped += 1;
      continue;
    }

    // Intelligence (Fable 5) — matched email only, so no personal/unmatched mail
    // ever reaches the model. Lender replies additionally get terms/decline
    // extracted (the learning signal). Both classifiers fence + fail closed.
    /*
     * DRY RUN SPENDS NOTHING. Both classifiers now queue through the
     * subscription seam, which PERSISTS the prompt in inference_jobs and
     * consumes CLI work. This function documents dryRun as "logs only", and the
     * operator cron defaults to it — so classifying here meant a validation tick
     * repeatedly storing email content and doing real inference for output
     * nobody keeps. Dry runs report the match, not a classification.
     * Caught by Codex review 2026-08-04.
     *
     * Tenant-scoped for the same reason as the lender classifier below: the
     * prompt carries merchant email content and is persisted, so it must carry
     * its owner.
     */
    const cls =
      lead && !args.dryRun
        ? await classifyDealEmail(msg.subject, msg.body, { tenantId: args.tenantId })
        : { type: "other" as const, needs_attention: false, summary: "" };

    /*
     * Still in flight — defer, do NOT persist.
     *
     * THIS ONLY WORKS IF THE CALLER HOLDS THE CURSOR. Not writing the row is
     * necessary but not sufficient: the cron advances `last_processed_at` via
     * markProcessed() and reads with `after:<that>`, so a deferred message would
     * fall outside the next window and be lost for good. It is reported as
     * `deferred` so the caller can hold the cursor. (An earlier version of this
     * comment claimed there was no cursor to advance — there is one, in
     * app/api/cron/operator-email-agent/route.ts. Codex review caught it.)
     *
     * A permanently slow queue cannot wedge the cursor forever: queueInfer
     * reports a STALLED queue with timedOut false, which returns the plain
     * fallback rather than pending.
     */
    if (cls.pending) {
      res.deferred += 1;
      const at = toISO(msg.date);
      if (at && (!res.oldestDeferredAt || at < res.oldestDeferredAt)) res.oldestDeferredAt = at;
      continue;
    }

    let lenderEnrichment: Record<string, unknown> = {};
    if (lead && !args.dryRun && cls.type === "lender_reply") {
      try {
        // Tenant-scope the queued prompt: the classifier now PERSISTS this
        // content in inference_jobs, so it must carry its owner.
        const lr = await classifyLenderReply(msg.subject, msg.body, {
          tenantId: args.tenantId,
        });
        lenderEnrichment = {
          lender_category: lr.category,
          lender_amount: lr.amount,
          lender_term_months: lr.term_months,
          lender_factor: lr.factor_rate,
        };
      } catch { /* fail closed — no terms */ }
    }
    const enrichment = {
      email_type: cls.type,
      needs_attention: cls.needs_attention,
      summary: cls.summary,
      ...lenderEnrichment,
    };

    if (args.dryRun) {
      // type is deliberately absent: a dry run does not classify, so printing
      // "other" here would read as a real verdict on every message.
      console.log(`[operator-email] DRY ${outbound ? "out" : "in"} msg=${msg.id} lead=${lead?.id || "unmatched"} type=not-classified(dry) "${msg.subject.slice(0, 50)}"`);
      res.ingested += 1;
      continue;
    }

    const row = {
      tenant_id: args.tenantId,
      lead_id: lead?.id || null,
      type: outbound ? "email_sent" : "email_received",
      channel: "email",
      direction: outbound ? "outbound" : "inbound",
      agent_source: "gmail_monitor",
      actor_user_id: args.userId,
      subject: msg.subject.slice(0, 500),
      content: msg.body,
      content_preview: msg.body.slice(0, 1024),
      to_email: counterparty,
      sent_at: toISO(msg.date),
      metadata: {
        gmail_message_id: msg.id,
        gmail_thread_id: msg.threadId,
        from_address: fromEmail,
        monitored_mailbox: args.mailbox,
        routed_to_user_id: args.userId,
        unmatched_work_email: !lead,
        ...enrichment,
      },
    };
    try {
      const ins = await db.from("lead_interactions").insert(row);
      if (ins.error) { res.dropped += 1; continue; }
      res.ingested += 1;
      // Inbound replies route their thread to the owning rep (see helper
      // above). Outbound is skipped — sends don't change ownership.
      if (!outbound && lead) {
        await autoAssignThreadForInbound(db, {
          tenantId: args.tenantId,
          leadId: lead.id,
          mailboxOwnerUserId: args.userId,
        });
      }
    } catch {
      res.dropped += 1;
    }
  }
  return res;
}
