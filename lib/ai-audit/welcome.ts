/**
 * lib/ai-audit/welcome.ts — a paying client's welcome email, sent only on CC's
 * approval.
 *
 * Onboarding (lib/ai-audit/onboarding.ts step 5) writes it once Stripe has
 * confirmed the payment, as a "welcome_ai_audit" card. It is the audit's own
 * kind so the audit's switch (LIVE_SEND_AI_AUDIT) carries it, as it carries the
 * audit and its follow-ups. As a plain send_email card it waited on the
 * dashboard-wide email switch, which is off, so approving it recorded a test run
 * and the client never had the onboarding form or the kickoff link (2026-10-27).
 *
 * THE SEND (the executor) re-checks, after CC approves: the owner approved it;
 * the engagement is paid and onboarding (or done), never refunded or disputed;
 * the address is the one the audit went to (the delivery approval's), whatever
 * the contact field says now, as for the follow-ups. It then sends through the
 * OASIS mailbox under the approval's own idempotency key, as support mail to
 * the new client. Dry run unless LIVE_SEND_AI_AUDIT is set.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { validateWelcomeAiAuditPayload } from "@/lib/ai-audit/welcome-payload";
import { EMAIL_PROVIDER, defaultAiAuditExecutorDeps, failed } from "@/lib/ai-audit/delivery";
import { deliveredTo } from "@/lib/ai-audit/follow-up";
import { getShareLink } from "@/lib/ai-audit/link";
import type { AiAuditStage, PaymentStatus } from "@/lib/ai-audit/rules";
import { eventStatement, getEngagement, type Engagement } from "@/lib/ai-audit/store";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import type { Executor, ExecutorContext, ExecutorOutcome } from "@/lib/os/approvals/executors";

/** Where a welcome fits: paid, and onboarding begun or done. */
const WELCOME_STAGES: readonly AiAuditStage[] = ["payment_confirmed", "onboarding", "active_client"];
/** Paid, including a second paid session held for review; never refunded, part refunded or disputed. */
const WELCOME_PAYMENTS: readonly PaymentStatus[] = ["paid", "overpaid_review"];

/** The address the client's audit was sent to (its current link's delivery), or null when it cannot be read. */
export async function welcomeRecipient(db: Client, tenantId: string, engagement: Pick<Engagement, "share_link_id">): Promise<string | null> {
  if (!engagement.share_link_id) return null;
  const link = await getShareLink(db, tenantId, engagement.share_link_id);
  if (!link) return null;
  return (await deliveredTo(db, tenantId, link.approval_id))?.to ?? null;
}

async function runWelcome(ctx: ExecutorContext): Promise<ExecutorOutcome> {
  const deps = ctx.deps.aiAudit ?? defaultAiAuditExecutorDeps();
  const t = ctx.tenant.id;
  const approverId = ctx.approver?.userId ?? "";
  if (!approverId || !(await deps.isOwner(ctx.db, t, approverId))) {
    return failed("owner_only", "Only the workspace owner can approve a client's welcome email, so nothing was sent.");
  }
  const v = validateWelcomeAiAuditPayload(ctx.payload);
  if (!v.ok) return failed("payload_invalid", `The stored welcome email is not valid (${v.error}).`);
  const p = v.value;
  const engagement = await getEngagement(ctx.db, t, p.engagement_id);
  if (!engagement) return failed("engagement_missing", "The engagement no longer exists, so nothing was sent.");
  if (!WELCOME_STAGES.includes(engagement.stage) || !WELCOME_PAYMENTS.includes(engagement.payment_status)) {
    return failed("not_paid", "The engagement is no longer paid and onboarding (a refund, a dispute or a cancellation), so the welcome email was not sent.");
  }
  const to = await welcomeRecipient(ctx.db, t, engagement);
  if (!to) return failed("recipient_unknown", "The address the audit was sent to cannot be read, so nothing was sent.");
  if (to !== p.to) return failed("recipient_changed", "This welcome email is not addressed to where the audit was sent, so it was not sent.");

  if (ctx.deps.isDryRun("ai_audit_delivery")) {
    await ctx.db.execute(
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "welcome_dry_run", actor: { type: "user", id: approverId }, at: new Date().toISOString(), refType: "approval", refId: ctx.approval.id, meta: { to: p.to } }),
    );
    return { ok: true, result: { outcome: "dry_run", provider: EMAIL_PROVIDER, would_send: { to: p.to, subject: p.subject } } };
  }

  const approverEmail = (ctx.approver?.email || "").trim().toLowerCase() || null;
  const sent = await ctx.deps.sendEmail({
    tenantId: t,
    to: p.to,
    cc: approverEmail && approverEmail !== p.to ? [approverEmail] : [],
    subject: p.subject,
    body: p.body,
    signer: ctx.deps.signerFor(approverEmail, "oasis"),
    idempotencyKey: ctx.approval.idempotency_key,
    purpose: "support",
  });
  if (!sent.ok) {
    return {
      ok: false,
      result: {
        outcome: "failed",
        reason: sent.reason,
        message: (sent.reason === "delivery_unknown" ? "The email may have been sent: the mail server stopped answering after taking it. Check the Sent folder." : `The email was not sent (${sent.reason}): ${sent.error}`).slice(0, 500),
        provider: sent.provider,
      },
    };
  }
  await ctx.db
    .execute(
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "welcome_sent", actor: { type: "user", id: approverId }, at: new Date().toISOString(), refType: "approval", refId: ctx.approval.id, meta: { message_id: sent.gmail_message_id || null } }),
    )
    .catch((err: unknown) => console.error("[ai-audit.welcome] sent, but the trail was not written", err instanceof Error ? err.message : err));
  return { ok: true, result: { outcome: "sent", provider: sent.provider, message_id: sent.gmail_message_id || null, from: sent.from_address } };
}

export const welcomeAiAuditExecutor: Executor = {
  readiness: (tenant) => (isOasisInternalTenant(tenant.id) ? null : "AI audits run only in OASIS's own workspaces."),
  run: runWelcome,
};
