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
 * unexpired; a "not opened" note's client still has not opened it; the address
 * is the one the audit went to (the delivery approval's, never the contact
 * field, which an admin may edit: review of phase 5). It then re-derives the SAME
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
import { DELIVER_AI_AUDIT_KIND, validateDeliverAiAuditPayload } from "@/lib/ai-audit/delivery-payload";
import { mintLinkToken, tokenHash, type ShareLink } from "@/lib/ai-audit/link";
import { EMAIL_PROVIDER, defaultAiAuditExecutorDeps, failed } from "@/lib/ai-audit/delivery";
import { WAITING_ON_CLIENT_STAGES, shortName } from "@/lib/ai-audit/rules";
import { eventStatement, getEngagement, requireTenant, type Engagement } from "@/lib/ai-audit/store";
import { cancelPendingApproval, createApproval, getApprovalInTenant, parsePayload } from "@/lib/os/approvals/store";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import type { Executor, ExecutorContext, ExecutorOutcome } from "@/lib/os/approvals/executors";

/** A follow-up approval waits this long, then expires unused. */
const FOLLOW_UP_TTL_DAYS = 7;

/** The business's name as a follow-up says it: one line and short, so a long name never refuses the card (review of phase 5). */
const nameOf = (name: string | null | undefined) => shortName((name ?? "").replace(/\s+/g, " "), "your business", 80);

/** The address the audit itself went to, and the delivery's key (the link is derived from it): follow-ups go there only. */
async function deliveredTo(db: Client, t: string, approvalId: string): Promise<{ to: string; idempotencyKey: string } | null> {
  const delivery = await getApprovalInTenant(db, t, approvalId);
  if (!delivery || delivery.action_kind !== DELIVER_AI_AUDIT_KIND) return null;
  let payload: Record<string, unknown>;
  try {
    payload = parsePayload(delivery);
  } catch {
    return null;
  }
  const v = validateDeliverAiAuditPayload(payload);
  return v.ok ? { to: v.value.to, idempotencyKey: delivery.idempotency_key } : null;
}

/** The follow-up's words, for the stall it answers. No pressure, no promise, the same link. */
export function followUpEmail(input: { contactName: string | null; businessName: string; reason: FollowUpReason; base: string }): { subject: string; body: string } {
  const greeting = input.contactName ? `Hi ${input.contactName.trim().split(/\s+/)[0]},` : "Hi,";
  const name = nameOf(input.businessName);
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
 * card was filed now: false when one exists already, when the link no longer
 * opens, or when the delivery it came from cannot be read.
 */
export async function fileFollowUp(
  db: Client,
  input: { tenantId: string; engagement: Engagement; link: ShareLink; reason: FollowUpReason; base: string; now: Date },
): Promise<boolean> {
  const t = requireTenant(input.tenantId);
  const e = input.engagement;
  if (input.link.revoked_at || Date.parse(input.link.expires_at) <= input.now.getTime()) return false;
  const delivered = await deliveredTo(db, t, input.link.approval_id);
  if (!delivered) return false;
  const { subject, body } = followUpEmail({ contactName: e.contact_name, businessName: e.business_name || "", reason: input.reason, base: input.base });
  const payload: FollowUpAiAuditPayload = {
    engagement_id: e.id,
    lead_id: e.lead_id,
    business_name: nameOf(e.business_name),
    share_link_id: input.link.id,
    reason: input.reason,
    to: delivered.to,
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
      title: `Follow-up email for ${nameOf(e.business_name)}`,
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

/**
 * Follow-ups still waiting for CC that no longer fit (the client paid, declined
 * or was sent a new link, or opened the audit a "not opened" note is about):
 * withdrawn, so no stale card sits in Needs you (review of phase 5). Answers
 * how many.
 */
export async function withdrawStaleFollowUps(db: Client, tenantId: string, now: Date): Promise<number> {
  const t = requireTenant(tenantId);
  const cards = await db.execute({
    sql: `SELECT id, json_extract(payload_json, '$.engagement_id') AS engagement_id, json_extract(payload_json, '$.share_link_id') AS link_id, json_extract(payload_json, '$.reason') AS reason
            FROM approvals WHERE tenant_id = ? AND action_kind = ? AND status = 'pending' LIMIT 50`,
    args: [t, FOLLOW_UP_AI_AUDIT_KIND],
  });
  let n = 0;
  for (const card of cards.rows) {
    const e = await getEngagement(db, t, String(card.engagement_id ?? ""));
    const link =
      e && e.share_link_id === String(card.link_id ?? "")
        ? (await db.execute({ sql: "SELECT revoked_at, first_viewed_at FROM ai_audit_share_links WHERE tenant_id = ? AND id = ? LIMIT 1", args: [t, e.share_link_id] })).rows[0]
        : undefined;
    const fits =
      !!e &&
      !!link &&
      link.revoked_at === null &&
      WAITING_ON_CLIENT_STAGES.includes(e.stage) &&
      (e.payment_status === "none" || e.payment_status === "pending") &&
      !(String(card.reason) === "not_opened" && link.first_viewed_at !== null);
    if (fits) continue;
    if (await cancelPendingApproval(db, t, String(card.id), { type: "routine", id: "ai-audit" }, { reason: "follow_up_no_longer_fits" }, now)) n += 1;
  }
  return n;
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
  const linkRow = (
    await ctx.db.execute({
      sql: "SELECT approval_id, token_sha256, expires_at, revoked_at, first_viewed_at FROM ai_audit_share_links WHERE tenant_id = ? AND id = ? AND engagement_id = ? LIMIT 1",
      args: [t, p.share_link_id, engagement.id],
    })
  ).rows[0];
  if (!linkRow || linkRow.revoked_at !== null || Date.parse(String(linkRow.expires_at)) <= Date.now()) {
    return failed("link_closed", "The audit's link has expired or was revoked, so the follow-up was not sent.");
  }
  // The stall it answers must still be so: "not opened" to a client who has opened it is the wrong email.
  if (p.reason === "not_opened" && linkRow.first_viewed_at !== null) return failed("reason_gone", "The client opened the audit since this was written, so this follow-up was not sent.");
  const delivered = await deliveredTo(ctx.db, t, String(linkRow.approval_id));
  if (!delivered) return failed("link_unknown", "The delivery this link came from cannot be found, so nothing was sent.");
  // Only the address the audit itself went to, whatever the contact field says now (review of phase 5).
  if (delivered.to !== p.to) return failed("recipient_changed", "This follow-up is not addressed to where the audit was sent, so it was not sent.");
  const secret = deps.linkSecret();
  if (!secret) return failed("not_configured", "AI_AUDIT_LINK_SECRET is not set on this deployment, so the link cannot be made. Nothing was sent.");
  // The same link the client already has, or nothing: never a new one from here.
  const token = mintLinkToken(secret, delivered.idempotencyKey);
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
