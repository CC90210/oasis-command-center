/**
 * lib/ai-audit/follow-up.ts — one follow-up email when a delivered audit
 * stalls, sent only on CC's approval (phase 5).
 *
 * THE DRAFT. When the tick flags a stall (lib/ai-audit/tick.ts step 7), it
 * also files one "follow_up_ai_audit" approval: a short note that resends the
 * same private link, written for the stall (not opened, or opened but not
 * paid). One per link and reason, never more: the idempotency key says so.
 * Nothing is sent from here.
 *
 * THE SEND (the executor), only after CC approves, re-checks that the follow-up
 * still makes sense: the owner approved it; the engagement is still waiting on
 * the client and unpaid; the link is still the engagement's own, unrevoked and
 * unexpired; the address is still the client's. It then re-derives the SAME
 * link the delivery minted (from the delivery approval's idempotency key; the
 * link is never stored), checks it against the stored hash, and sends through
 * the OASIS mailbox under the approval's own idempotency key. Dry run unless
 * LIVE_SEND_AI_AUDIT is set, as for the delivery itself.
 */
import "server-only";
import type { Client } from "@libsql/client";
import {
  FOLLOW_UP_AI_AUDIT_KIND,
  FOLLOW_UP_LINK_PLACEHOLDER,
  validateFollowUpAiAuditPayload,
  type FollowUpAiAuditPayload,
  type FollowUpReason,
} from "@/lib/ai-audit/follow-up-payload";
import { mintLinkToken, tokenHash, type ShareLink } from "@/lib/ai-audit/link";
import { defaultAiAuditExecutorDeps } from "@/lib/ai-audit/delivery";
import { WAITING_ON_CLIENT_STAGES, shortName } from "@/lib/ai-audit/rules";
import { eventStatement, getEngagement, requireTenant, type Engagement } from "@/lib/ai-audit/store";
import { createApproval, getApprovalInTenant } from "@/lib/os/approvals/store";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import type { Executor, ExecutorContext, ExecutorOutcome } from "@/lib/os/approvals/executors";

/** A follow-up approval waits this long, then expires unused. */
const FOLLOW_UP_TTL_DAYS = 7;
const EMAIL_PROVIDER = "oasis_shared_gmail";

/** The follow-up's words, for the stall it answers. No pressure, no promise, the same link. */
export function followUpEmail(input: { contactName: string | null; businessName: string; reason: FollowUpReason; base: string }): { subject: string; body: string } {
  const greeting = input.contactName ? `Hi ${input.contactName.trim().split(/\s+/)[0]},` : "Hi,";
  const name = input.businessName || "your business";
  if (input.reason === "not_opened") {
    return {
      subject: `Your free AI audit for ${name}`,
      body: [
        greeting,
        "",
        `I wanted to make sure the free AI audit I prepared for ${name} reached you. Here is your private link again:`,
        FOLLOW_UP_LINK_PLACEHOLDER,
        "",
        "If now is not a good time, that is completely fine. Reply whenever you like, with any questions or to pick it up later.",
      ].join("\n"),
    };
  }
  return {
    subject: `Questions about your AI audit for ${name}?`,
    body: [
      greeting,
      "",
      `Thank you for taking a look at the audit for ${name}. If anything in it, or in the proposal, is unclear, I am happy to walk you through it. Your private link is here:`,
      FOLLOW_UP_LINK_PLACEHOLDER,
      "",
      `Reply here, or pick a time to talk: ${input.base}/book`,
    ].join("\n"),
  };
}

/**
 * File the follow-up for a stall, once per link and reason. Answers whether a
 * card was filed now (false when one exists already, or there is no address).
 */
export async function fileFollowUp(
  db: Client,
  input: { tenantId: string; engagement: Engagement; link: ShareLink; reason: FollowUpReason; base: string; now: Date },
): Promise<boolean> {
  const t = requireTenant(input.tenantId);
  const e = input.engagement;
  if (!e.contact_email) return false;
  const { subject, body } = followUpEmail({ contactName: e.contact_name, businessName: e.business_name || "", reason: input.reason, base: input.base });
  const payload: FollowUpAiAuditPayload = {
    engagement_id: e.id,
    lead_id: e.lead_id,
    business_name: e.business_name || "your business",
    share_link_id: input.link.id,
    reason: input.reason,
    to: e.contact_email.trim().toLowerCase(),
    subject,
    body,
  };
  const created = await createApproval(
    db,
    {
      tenantId: t,
      departmentKey: null,
      requestedBy: { type: "routine", id: "ai-audit" },
      actionKind: FOLLOW_UP_AI_AUDIT_KIND,
      title: `Follow-up email for ${shortName(e.business_name, "an AI audit")}`,
      targetRef: `ai_audit_engagement:${e.id}`,
      payload: payload as unknown as Record<string, unknown>,
      idempotencyKey: `ai-audit-follow-up:${e.id}:${input.link.id}:${input.reason}`,
      expiresAt: new Date(input.now.getTime() + FOLLOW_UP_TTL_DAYS * 86_400_000).toISOString(),
    },
    input.now,
  );
  if (!created.ok) {
    if (created.error === "idempotency_key_reused") return false;
    throw new Error(`the follow-up approval was not filed: ${created.error}`);
  }
  return created.created;
}

function failed(reason: string, message: string): ExecutorOutcome {
  return { ok: false, result: { outcome: "failed", reason, message, provider: null } };
}

async function runFollowUp(ctx: ExecutorContext): Promise<ExecutorOutcome> {
  const deps = ctx.deps.aiAudit ?? defaultAiAuditExecutorDeps();
  const t = ctx.tenant.id;
  const approverId = ctx.approver?.userId ?? "";
  if (!approverId || !(await deps.isOwner(ctx.db, t, approverId))) {
    return failed("owner_only", "Only the workspace owner can approve a follow-up to a client, so nothing was sent.");
  }
  const v = validateFollowUpAiAuditPayload(ctx.payload);
  if (!v.ok) return failed("payload_invalid", `The stored follow-up is not valid (${v.error}).`);
  const p = v.value;
  const engagement = await getEngagement(ctx.db, t, p.engagement_id);
  if (!engagement) return failed("engagement_missing", "The engagement no longer exists, so nothing was sent.");
  // Still waiting on the client, and unpaid: a follow-up after they paid or declined would be wrong.
  if (!WAITING_ON_CLIENT_STAGES.includes(engagement.stage) || (engagement.payment_status !== "none" && engagement.payment_status !== "pending")) {
    return failed("stage_moved", "The engagement is no longer waiting on the client, so the follow-up was not sent.");
  }
  if (engagement.share_link_id !== p.share_link_id) return failed("link_changed", "The audit was sent again with a new link since this was written, so it was not sent.");
  if ((engagement.contact_email ?? "").trim().toLowerCase() !== p.to) return failed("recipient_changed", "The client's email address changed since this was written, so it was not sent.");
  const linkRow = (
    await ctx.db.execute({ sql: "SELECT approval_id, token_sha256, expires_at, revoked_at FROM ai_audit_share_links WHERE tenant_id = ? AND id = ? AND engagement_id = ? LIMIT 1", args: [t, p.share_link_id, engagement.id] })
  ).rows[0];
  if (!linkRow || linkRow.revoked_at !== null || Date.parse(String(linkRow.expires_at)) <= Date.now()) {
    return failed("link_closed", "The audit's link has expired or was revoked, so the follow-up was not sent.");
  }
  const secret = deps.linkSecret();
  if (!secret) return failed("not_configured", "AI_AUDIT_LINK_SECRET is not set on this deployment, so the link cannot be made. Nothing was sent.");
  const delivery = await getApprovalInTenant(ctx.db, t, String(linkRow.approval_id));
  if (!delivery) return failed("link_unknown", "The delivery this link came from cannot be found, so nothing was sent.");
  // The same link the client already has, or nothing: never a new one from here.
  const token = mintLinkToken(secret, delivery.idempotency_key);
  if (tokenHash(token) !== String(linkRow.token_sha256)) return failed("link_unknown", "The link could not be made again exactly as delivered, so nothing was sent.");

  if (ctx.deps.isDryRun("ai_audit_delivery")) {
    await ctx.db.execute(
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "follow_up_dry_run", actor: { type: "user", id: approverId }, at: new Date().toISOString(), refType: "approval", refId: ctx.approval.id, meta: { to: p.to, reason: p.reason } }),
    );
    return { ok: true, result: { outcome: "dry_run", provider: EMAIL_PROVIDER, would_send: { to: p.to, subject: p.subject } } };
  }

  const url = `${deps.baseUrl()}/your-audit/${token}`;
  const approverEmail = (ctx.approver?.email || "").trim().toLowerCase() || null;
  const sent = await ctx.deps.sendEmail({
    tenantId: t,
    to: p.to,
    cc: approverEmail && approverEmail !== p.to ? [approverEmail] : [],
    subject: p.subject,
    body: p.body.replace(FOLLOW_UP_LINK_PLACEHOLDER, url),
    signer: ctx.deps.signerFor(approverEmail, "oasis"),
    idempotencyKey: ctx.approval.idempotency_key,
    purpose: "sales",
  });
  if (!sent.ok) {
    // A follow-up is not a delivery: a lost answer means "check the Sent folder", never a second send from here.
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
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "follow_up_sent", actor: { type: "user", id: approverId }, at: new Date().toISOString(), refType: "approval", refId: ctx.approval.id, meta: { reason: p.reason, message_id: sent.gmail_message_id || null } }),
    )
    .catch((err: unknown) => console.error("[ai-audit.follow-up] sent, but the trail was not written", err instanceof Error ? err.message : err));
  return { ok: true, result: { outcome: "sent", provider: sent.provider, message_id: sent.gmail_message_id || null, from: sent.from_address } };
}

export const followUpAiAuditExecutor: Executor = {
  readiness: (tenant, deps) => {
    if (!isOasisInternalTenant(tenant.id)) return "AI audits run only in OASIS's own workspaces.";
    if (!(deps.aiAudit ?? defaultAiAuditExecutorDeps()).linkSecret()) return "AI_AUDIT_LINK_SECRET is not set on this deployment, so the link cannot be made yet.";
    return null;
  },
  run: runFollowUp,
};
