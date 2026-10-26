/**
 * lib/ai-audit/delivery.ts — from a finished draft to the client's inbox.
 *
 *   1. submitForFinalApproval: CC says the draft is done. The audit and the
 *      proposal are checked (every evidence rule, every price), then frozen
 *      (awaiting_approval; the database refuses edits from here), and the Mac
 *      is asked to print the PDF.
 *   2. requestDeliveryApproval (the tick, once the PDF exists): Gate 2, an
 *      approval of kind deliver_ai_audit bound to the audit hash, proposal
 *      hash, PDF hash and the exact email.
 *   3. deliverAiAuditExecutor (CC presses Approve): re-checks all of it, then
 *      mints the private link and sends the one email. Nothing else ever sends
 *      an audit or a proposal.
 *
 * reopenForEdits undoes step 1 before delivery: the frozen versions are
 * withdrawn, a pending Gate 2 is cancelled, and new drafts carry the content.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { contentHash, sha256Hex } from "@/lib/ai-audit/hash";
import { blockingIssues } from "@/lib/ai-audit/doc";
import { proposalBlockers, proposalTotals, AUDIT_LINK_PLACEHOLDER } from "@/lib/ai-audit/proposal";
import { DELIVER_AI_AUDIT_KIND, validateDeliverAiAuditPayload, type DeliverAiAuditPayload } from "@/lib/ai-audit/delivery-payload";
import { createShareLink, linkForApproval, mintLinkToken, revokeShareLink } from "@/lib/ai-audit/link";
import { aiAuditBaseUrl, aiAuditLinkSecret } from "@/lib/ai-audit/env";
import { queuePdfJob, r2PdfStorage } from "@/lib/ai-audit/pdf";
import { syncLeadStage } from "@/lib/ai-audit/lifecycle";
import { authorizedProfile } from "@/lib/ai-audit/authorize";
import { getSettings } from "@/lib/ai-audit/store";
import {
  getAuditVersion,
  getProposalVersion,
  normalizeProposal,
  saveAuditDraft,
  saveProposalDraft,
  type AuditVersion,
  type ProposalVersion,
} from "@/lib/ai-audit/versions";
import {
  casWrite,
  engagementUpdateStatement,
  eventStatement,
  getEngagement,
  patchEngagement,
  requireTenant,
  type Actor,
  type Engagement,
} from "@/lib/ai-audit/store";
import { cancelPendingApproval, createApproval, getApprovalInTenant, parsePayload } from "@/lib/os/approvals/store";
import { getTenantIntegrationValue } from "@/lib/tenant-integration-store";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { dbBool } from "@/lib/db-bool";
import { isOasisInternalTenant } from "@/lib/ai/tools/client-safe-registry";
import type { Executor, ExecutorContext, ExecutorOutcome } from "@/lib/os/approvals/executors";

export type SubmitResult =
  | { ok: true; engagement: Engagement; audit: AuditVersion; proposal: ProposalVersion }
  | { ok: false; error: string; problems?: string[] };

// Only after Gate 1: an engagement reaches generating only through CC's authorization.
const SUBMITTABLE = new Set(["generating", "final_review"]);

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Check, freeze and queue the PDF. Nothing is sent here. */
export async function submitForFinalApproval(
  db: Client,
  input: { tenantId: string; engagementId: string; expectedRowVersion: number; actor: Actor; now: Date },
): Promise<SubmitResult> {
  const t = requireTenant(input.tenantId);
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement) return { ok: false, error: "not_found" };
  if (engagement.row_version !== input.expectedRowVersion) return { ok: false, error: "conflict" };
  if (!SUBMITTABLE.has(engagement.stage)) return { ok: false, error: "not_submittable_at_this_stage" };
  // Every later step re-checks Gate 1: the frozen profile still hashes to what CC authorized.
  if (!(await authorizedProfile(db, t, engagement))) return { ok: false, error: "not_authorized", problems: ["The discovery profile is not authorized (Gate 1), or it changed since. Authorize it first."] };
  const audit = engagement.current_audit_version_id ? await getAuditVersion(db, t, engagement.current_audit_version_id) : null;
  const proposal = engagement.current_proposal_version_id ? await getProposalVersion(db, t, engagement.current_proposal_version_id) : null;
  if (!audit || audit.status !== "draft" || !audit.doc) return { ok: false, error: "no_audit_draft" };
  if (!proposal || proposal.status !== "draft" || !proposal.content) return { ok: false, error: "no_proposal_draft" };

  const problems: string[] = blockingIssues(audit.doc).map((i) => `${i.path}: ${i.message}`);
  // Prices again, against the catalogue as it is now: an item retired since the
  // draft was saved must not slip through on an old copy of its price.
  const { settings } = await getSettings(db, t);
  const renormalized = await normalizeProposal(db, t, proposal.content, proposal.content, input.actor.id ?? "", settings.tax, input.now, { allowFixtureItems: engagement.is_fixture });
  if (contentHash(renormalized) !== proposal.content_sha256) {
    problems.push("Proposal: a price or the tax rule changed since this draft was saved. Open the proposal and save it again.");
  }
  problems.push(...proposalBlockers(proposal.content, today(input.now)).map((p) => `Proposal: ${p}`));
  if (!engagement.contact_email && !proposal.content.delivery_email.to) problems.push("The client has no email address.");
  if (problems.length) return { ok: false, error: "not_ready", problems };

  const at = input.now.toISOString();
  const ok = await casWrite(db, engagementUpdateStatement(t, engagement.id, engagement.row_version, { health: "ok", health_reason: null }, at, "final_review"), [
    { sql: "UPDATE ai_audit_versions SET status = 'awaiting_approval', submitted_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'", args: [at, at, t, audit.id] },
    {
      sql: "UPDATE ai_audit_proposal_versions SET status = 'awaiting_approval', submitted_at = ?, audit_version_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'",
      args: [at, audit.id, at, t, proposal.id],
    },
    eventStatement({
      tenantId: t,
      engagementId: engagement.id,
      event: "submitted_for_final_approval",
      actor: input.actor,
      at,
      fromStage: engagement.stage,
      toStage: "final_review",
      meta: { audit_version_id: audit.id, audit_sha256: audit.content_sha256, proposal_version_id: proposal.id, proposal_sha256: proposal.content_sha256 },
    }),
  ]);
  if (!ok) return { ok: false, error: "conflict" };
  await queuePdfJob(db, { tenantId: t, engagementId: engagement.id, auditVersionId: audit.id, contentSha256: audit.content_sha256, now: input.now });
  const after = await getEngagement(db, t, engagement.id);
  if (after) await syncLeadStage(db, after, input.actor, input.now);
  const a = await getAuditVersion(db, t, audit.id);
  const p = await getProposalVersion(db, t, proposal.id);
  if (!after || !a || !p) return { ok: false, error: "not_found" };
  return { ok: true, engagement: after, audit: a, proposal: p };
}

/**
 * Before delivery: take the submitted versions back. They are withdrawn (kept
 * as they were), a pending Gate 2 is cancelled, and new drafts with the same
 * content open for editing.
 */
export async function reopenForEdits(
  db: Client,
  input: { tenantId: string; engagementId: string; expectedRowVersion: number; actor: Actor; now: Date },
): Promise<{ ok: true; engagement: Engagement } | { ok: false; error: string }> {
  const t = requireTenant(input.tenantId);
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement) return { ok: false, error: "not_found" };
  if (engagement.row_version !== input.expectedRowVersion) return { ok: false, error: "conflict" };
  if (engagement.stage !== "final_review") return { ok: false, error: "only_before_delivery" };
  const audit = engagement.current_audit_version_id ? await getAuditVersion(db, t, engagement.current_audit_version_id) : null;
  const proposal = engagement.current_proposal_version_id ? await getProposalVersion(db, t, engagement.current_proposal_version_id) : null;
  if (!audit || audit.status !== "awaiting_approval" || !audit.doc || !proposal || proposal.status !== "awaiting_approval" || !proposal.content) {
    return { ok: false, error: "nothing_submitted" };
  }
  if (engagement.delivery_approval_id) {
    await cancelPendingApproval(db, t, engagement.delivery_approval_id, { type: "user", id: input.actor.id }, { reason: "reopened_for_edits" }, input.now);
  }
  const at = input.now.toISOString();
  const ok = await casWrite(db, engagementUpdateStatement(t, engagement.id, engagement.row_version, { delivery_approval_id: null }, at, "generating"), [
    { sql: "UPDATE ai_audit_versions SET status = 'withdrawn', updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'awaiting_approval'", args: [at, t, audit.id] },
    { sql: "UPDATE ai_audit_proposal_versions SET status = 'withdrawn', updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'awaiting_approval'", args: [at, t, proposal.id] },
    eventStatement({ tenantId: t, engagementId: engagement.id, event: "reopened_for_edits", actor: input.actor, at, fromStage: "final_review", toStage: "generating" }),
  ]);
  if (!ok) return { ok: false, error: "conflict" };
  let current = await getEngagement(db, t, engagement.id);
  if (!current) return { ok: false, error: "not_found" };
  const a = await saveAuditDraft(db, { tenantId: t, engagementId: current.id, doc: audit.doc, actor: input.actor, now: input.now, expectedRowVersion: current.row_version });
  if (!a.ok) return { ok: false, error: `audit_${a.error}` };
  current = await getEngagement(db, t, engagement.id);
  if (!current) return { ok: false, error: "not_found" };
  const { settings } = await getSettings(db, t);
  const p = await saveProposalDraft(db, { tenantId: t, engagementId: current.id, content: proposal.content, actor: input.actor, now: input.now, expectedRowVersion: current.row_version, tax: settings.tax });
  if (!p.ok) return { ok: false, error: `proposal_${p.error}` };
  const after = await getEngagement(db, t, engagement.id);
  return after ? { ok: true, engagement: after } : { ok: false, error: "not_found" };
}

// ---------------------------------------------------------------------------
// Gate 2: the approval
// ---------------------------------------------------------------------------

/** The approval payload for the engagement's submitted versions, or the reason there is none yet. */
export function deliveryPayloadFor(engagement: Engagement, audit: AuditVersion, proposal: ProposalVersion): DeliverAiAuditPayload | { error: string } {
  if (audit.status !== "awaiting_approval" || proposal.status !== "awaiting_approval") return { error: "not_submitted" };
  if (!audit.pdf_sha256) return { error: "pdf_not_ready" };
  if (!proposal.content) return { error: "proposal_unreadable" };
  const totals = proposalTotals(proposal.content);
  const email = proposal.content.delivery_email;
  return {
    engagement_id: engagement.id,
    lead_id: engagement.lead_id,
    business_name: audit.doc?.business.name || engagement.business_name || "the client",
    audit_version_id: audit.id,
    audit_sha256: audit.content_sha256,
    proposal_version_id: proposal.id,
    proposal_sha256: proposal.content_sha256,
    pdf_sha256: audit.pdf_sha256,
    to: (email.to || engagement.contact_email || "").toLowerCase(),
    subject: email.subject,
    body: email.body,
    currency: proposal.currency,
    total_cents: totals.total_cents,
    due_now_cents: totals.due_now_cents,
  };
}

/**
 * File Gate 2 once the PDF exists. Idempotent on the versions and the PDF hash.
 * A previous Gate 2 that failed, expired or was sent back is NOT re-filed by
 * the tick (that would put the same card in front of CC again and again): the
 * engagement is flagged instead, and CC's "Retry delivery" (retry: true) files
 * a fresh one.
 */
export async function requestDeliveryApproval(
  db: Client,
  input: { tenantId: string; engagementId: string; now: Date; retry?: boolean; confirmNotSent?: boolean },
): Promise<{ ok: true; approvalId: string; created: boolean } | { ok: false; error: string }> {
  const t = requireTenant(input.tenantId);
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement || engagement.stage !== "final_review") return { ok: false, error: "not_in_final_review" };
  // Gate 1 must still hold when Gate 2 is filed: a transcript deleted after
  // submission voids it (Codex review of phase 2).
  if (!(await authorizedProfile(db, t, engagement))) {
    const why = "The client's information is no longer authorized (Gate 1), for example because a transcript it covered was deleted. Move the engagement back to Transcript Awaiting Approval, authorize it again, then submit again.";
    if (engagement.health !== "attention" || engagement.health_reason !== why) {
      await patchEngagement(db, { tenantId: t, id: engagement.id, expectedRowVersion: engagement.row_version, patch: { health: "attention", health_reason: why }, event: "authorization_voided", actor: { type: "system", id: null }, now: input.now });
    }
    return { ok: false, error: "not_authorized" };
  }
  if (engagement.delivery_approval_id) {
    const prior = await getApprovalInTenant(db, t, engagement.delivery_approval_id);
    const priorOutcome = (prior?.execution_result as { outcome?: unknown } | null)?.outcome;
    // An approval carried out in dry run sent nothing, so it does not count as a delivery.
    const dryRun = !!prior && prior.status === "executed" && priorOutcome === "dry_run";
    if (prior && !dryRun && ["pending", "approved", "executing", "executed"].includes(prior.status)) {
      return { ok: true, approvalId: prior.id, created: false };
    }
    const priorReason = (prior?.execution_result as { reason?: unknown } | null)?.reason;
    const uncertain = !!prior && prior.status === "failed" && priorReason === "delivery_unknown";
    if (uncertain && input.retry && !input.confirmNotSent) return { ok: false, error: "delivery_unknown_check_sent" };
    if (uncertain && input.retry && input.confirmNotSent) {
      // CC checked the Sent folder and it did not go: the old link dies before a new one is made.
      const old = await linkForApproval(db, t, prior.id);
      if (old && !old.revoked_at) await revokeShareLink(db, t, old.id, "not_sent_confirmed", input.now);
    }
    if (prior && !input.retry) {
      const why = uncertain
        ? "The email may have been sent (the mail server stopped answering). Check the Sent folder, then choose It was sent, or It was not sent: send again."
        : dryRun
        ? "Approved while audit delivery is in dry run, so nothing was sent. Turn on LIVE_SEND_AI_AUDIT, then retry delivery."
        : prior.status === "failed"
          ? `Delivery failed: ${String((prior.execution_result as { message?: unknown } | null)?.message ?? "see the approval").slice(0, 160)}`
          : prior.status === "sent_back"
            ? "Final approval was sent back. Reopen the audit to edit it, or retry delivery."
            : `Final approval ${prior.status}. Retry delivery when ready.`;
      if (engagement.health !== "attention" || engagement.health_reason !== why) {
        await patchEngagement(db, { tenantId: t, id: engagement.id, expectedRowVersion: engagement.row_version, patch: { health: "attention", health_reason: why }, event: "final_approval_needs_you", actor: { type: "system", id: null }, now: input.now, refType: "approval", refId: prior.id });
      }
      return { ok: false, error: `prior_approval_${prior.status}` };
    }
  }
  const audit = engagement.current_audit_version_id ? await getAuditVersion(db, t, engagement.current_audit_version_id) : null;
  const proposal = engagement.current_proposal_version_id ? await getProposalVersion(db, t, engagement.current_proposal_version_id) : null;
  if (!audit || !proposal) return { ok: false, error: "versions_missing" };
  const payload = deliveryPayloadFor(engagement, audit, proposal);
  if ("error" in payload) return { ok: false, error: payload.error };
  const valid = validateDeliverAiAuditPayload(payload);
  if (!valid.ok) return { ok: false, error: valid.error };
  const validUntil = proposal.content?.valid_until ? Date.parse(`${proposal.content.valid_until}T23:59:59Z`) : NaN;
  const week = input.now.getTime() + 7 * 86_400_000;
  const expiresAt = new Date(Number.isFinite(validUntil) ? Math.min(validUntil, week) : week).toISOString();
  const baseKey = `ai-audit-deliver:${audit.id}:${proposal.id}:${payload.pdf_sha256.slice(0, 16)}`;
  let idempotencyKey = baseKey;
  if (input.retry) {
    const tries = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND (idempotency_key = ? OR idempotency_key LIKE ?)", args: [t, baseKey, `${baseKey}:retry-%`] })).rows[0]?.n ?? 0);
    idempotencyKey = `${baseKey}:retry-${tries}`;
  }
  const created = await createApproval(
    db,
    {
      tenantId: t,
      departmentKey: null,
      requestedBy: { type: "routine", id: "ai-audit" },
      actionKind: DELIVER_AI_AUDIT_KIND,
      title: `Send ${payload.business_name} their Free AI Audit and proposal`,
      targetRef: `lead:${engagement.lead_id}`,
      payload: valid.value as unknown as Record<string, unknown>,
      riskLevel: "spend",
      idempotencyKey,
      expiresAt,
    },
    input.now,
  );
  if (!created.ok) return { ok: false, error: created.error };
  const at = input.now.toISOString();
  if (engagement.delivery_approval_id !== created.approval.id) {
    const fresh = (await getEngagement(db, t, engagement.id)) ?? engagement;
    await casWrite(db, engagementUpdateStatement(t, fresh.id, fresh.row_version, { delivery_approval_id: created.approval.id, health: "ok", health_reason: null }, at), [
      { sql: "UPDATE ai_audit_versions SET approval_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", args: [created.approval.id, at, t, audit.id] },
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "final_approval_requested", actor: { type: "system", id: null }, at, refType: "approval", refId: created.approval.id }),
    ]);
  }
  return { ok: true, approvalId: created.approval.id, created: created.created };
}

// ---------------------------------------------------------------------------
// Gate 2: the executor
// ---------------------------------------------------------------------------

export type AiAuditExecutorDeps = {
  linkSecret: () => string | null;
  baseUrl: () => string;
  stripeConnected: (tenantId: string) => Promise<boolean>;
  isOwner: (db: Client, tenantId: string, userId: string) => Promise<boolean>;
  /** The stored PDF's bytes, to prove the file the client will download is the one approved. */
  readPdf: (path: string) => Promise<Uint8Array | null>;
  alert: (input: Parameters<typeof writeAgentAlert>[0]) => Promise<unknown>;
};

export function defaultAiAuditExecutorDeps(): AiAuditExecutorDeps {
  return {
    linkSecret: aiAuditLinkSecret,
    baseUrl: aiAuditBaseUrl,
    stripeConnected: async (tenantId) => !!(await getTenantIntegrationValue(tenantId, "stripe", "secret_key")),
    isOwner: async (db, tenantId, userId) => {
      const row = (await db.execute({ sql: "SELECT is_owner FROM user_profiles WHERE tenant_id = ? AND auth_user_id = ? LIMIT 1", args: [tenantId, userId] })).rows[0];
      return !!row && dbBool(row.is_owner);
    },
    readPdf: async (path) => {
      const store = r2PdfStorage();
      return store ? store.download(path) : null;
    },
    alert: (input) => writeAgentAlert(input),
  };
}

function failed(reason: string, message: string): ExecutorOutcome {
  return { ok: false, result: { outcome: "failed", reason, message, provider: null } };
}

const EMAIL_PROVIDER = "oasis_shared_gmail";

async function runDelivery(ctx: ExecutorContext): Promise<ExecutorOutcome> {
  const deps = ctx.deps.aiAudit ?? defaultAiAuditExecutorDeps();
  const t = ctx.tenant.id;
  const approverId = ctx.approver?.userId ?? "";
  if (!approverId || !(await deps.isOwner(ctx.db, t, approverId))) {
    return failed("owner_only", "Only the workspace owner can approve an audit for delivery, so nothing was sent.");
  }
  const v = validateDeliverAiAuditPayload(ctx.payload);
  if (!v.ok) return failed("payload_invalid", `The stored delivery is not valid (${v.error}).`);
  const p = v.value;
  const engagement = await getEngagement(ctx.db, t, p.engagement_id);
  if (!engagement) return failed("engagement_missing", "The engagement no longer exists, so nothing was sent.");
  if (engagement.stage !== "final_review") return failed("stage_moved", "The engagement is no longer waiting for final approval, so nothing was sent.");
  // And at the moment of sending: an authorization voided after this card was filed stops it (Codex review of phase 2).
  if (!(await authorizedProfile(ctx.db, t, engagement))) {
    return failed("not_authorized", "The client's information is no longer authorized (Gate 1), so nothing was sent. Move the engagement back, authorize it again, then submit again.");
  }
  if (engagement.current_audit_version_id !== p.audit_version_id || engagement.current_proposal_version_id !== p.proposal_version_id) {
    return failed("payload_changed", "A newer version of the audit or proposal exists. Approve that one instead.");
  }
  const audit = await getAuditVersion(ctx.db, t, p.audit_version_id);
  const proposal = await getProposalVersion(ctx.db, t, p.proposal_version_id);
  if (!audit || !audit.doc || audit.status !== "awaiting_approval") return failed("payload_changed", "The audit is no longer the one submitted, so nothing was sent.");
  if (!proposal || !proposal.content || proposal.status !== "awaiting_approval") return failed("payload_changed", "The proposal is no longer the one submitted, so nothing was sent.");
  if (contentHash(audit.doc) !== p.audit_sha256 || audit.content_sha256 !== p.audit_sha256) return failed("payload_changed", "The audit changed after it was approved, so nothing was sent.");
  if (contentHash(proposal.content) !== p.proposal_sha256 || proposal.content_sha256 !== p.proposal_sha256) return failed("payload_changed", "The proposal changed after it was approved, so nothing was sent.");
  if (audit.pdf_sha256 !== p.pdf_sha256) return failed("payload_changed", "The PDF changed after it was approved, so nothing was sent.");
  // The file itself, not just its recorded hash: a missing or altered object
  // would give the client a broken or different download.
  const stored = audit.pdf_path ? await deps.readPdf(audit.pdf_path).catch(() => null) : null;
  if (!stored || sha256Hex(stored) !== p.pdf_sha256) {
    return failed("pdf_missing", "The approved PDF is missing from storage or no longer matches, so nothing was sent. Reopen the audit and submit it again to print a fresh PDF.");
  }
  const totals = proposalTotals(proposal.content);
  if (totals.total_cents !== p.total_cents || totals.due_now_cents !== p.due_now_cents || proposal.currency !== p.currency) {
    return failed("payload_changed", "The proposal's totals no longer match what was approved, so nothing was sent.");
  }
  const blockers = proposalBlockers(proposal.content, today(new Date()));
  if (blockers.length) return failed("not_ready", `The proposal is not ready: ${blockers[0]}`);
  if (blockingIssues(audit.doc).length) return failed("not_ready", "The audit breaks an evidence rule. Open it and fix the flagged items.");

  const secret = deps.linkSecret();
  if (!secret) return failed("not_configured", "AI_AUDIT_LINK_SECRET is not set on this deployment, so no private link can be made. Nothing was sent.");
  if (!(await deps.stripeConnected(t))) return failed("stripe_not_connected", "Stripe is not connected for this workspace, so the client could not pay. Nothing was sent.");

  if (ctx.deps.isDryRun("ai_audit_delivery")) {
    await ctx.db.execute(
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "delivery_dry_run", actor: { type: "user", id: approverId }, at: new Date().toISOString(), refType: "approval", refId: ctx.approval.id, meta: { to: p.to } }),
    );
    return { ok: true, result: { outcome: "dry_run", provider: EMAIL_PROVIDER, would_send: { to: p.to, subject: p.subject } } };
  }

  const now = new Date();
  const token = mintLinkToken(secret, ctx.approval.idempotency_key);
  const link = await createShareLink(ctx.db, {
    tenantId: t,
    engagementId: engagement.id,
    auditVersionId: audit.id,
    proposalVersionId: proposal.id,
    approvalId: ctx.approval.id,
    token,
    now,
  });
  const url = `${deps.baseUrl()}/your-audit/${token}`;
  const body = p.body.replace(AUDIT_LINK_PLACEHOLDER, url);
  const approverEmail = (ctx.approver?.email || "").trim().toLowerCase() || null;
  const sent = await ctx.deps.sendEmail({
    tenantId: t,
    to: p.to,
    cc: approverEmail && approverEmail !== p.to ? [approverEmail] : [],
    subject: p.subject,
    body,
    signer: ctx.deps.signerFor(approverEmail, "oasis"),
    idempotencyKey: ctx.approval.idempotency_key,
    purpose: "sales",
  });
  if (!sent.ok && sent.reason === "delivery_unknown") {
    // The mail server took the message and then stopped answering: it may have
    // arrived. The link keeps working, and nothing here offers a second send
    // until CC has checked the Sent folder (Codex review of PR #732).
    await ctx.db.execute(
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "delivery_unknown", actor: { type: "user", id: approverId }, at: new Date().toISOString(), refType: "approval", refId: ctx.approval.id, meta: { share_link_id: link.id, to: p.to } }),
    );
    await deps
      .alert({
        tenantId: t,
        alertType: "ai_audit_delivery_unknown",
        severity: "urgent",
        title: `Audit email may have been sent: ${engagement.business_name || "an AI audit"}`,
        body: "The mail server stopped answering after taking the message. Check the Sent folder, then on the engagement choose It was sent, or It was not sent: send again.",
        subjectType: "ai_audit_engagement",
        subjectId: engagement.id,
        telegramOncePerOpen: true,
      })
      .catch((alertErr: unknown) => console.error("[ai-audit.delivery] the alert failed", alertErr instanceof Error ? alertErr.message : alertErr));
    return {
      ok: false,
      result: { outcome: "failed", reason: "delivery_unknown", message: "The email may have been sent: the mail server stopped answering after taking it. Check the Sent folder before doing anything else.", provider: sent.provider },
    };
  }
  if (!sent.ok) {
    await revokeShareLink(ctx.db, t, link.id, "send_failed", new Date());
    return {
      ok: false,
      result: { outcome: "failed", reason: sent.reason, message: `The email was not sent (${sent.reason}): ${sent.error}`.slice(0, 500), provider: sent.provider },
    };
  }

  // The email is out. From here on nothing may report a failure: a "failed"
  // approval invites a retry, and a retry would send a second email with a
  // second link (review of PR #732). A recording problem is logged and
  // alerted, and the tick finishes the record (repairUnrecordedDelivery).
  try {
    await recordDelivery(ctx.db, {
      tenantId: t,
      engagementId: engagement.id,
      auditVersionId: audit.id,
      proposalVersionId: proposal.id,
      approvalId: ctx.approval.id,
      linkId: link.id,
      actor: { type: "user", id: approverId },
      messageId: sent.gmail_message_id || null,
      to: p.to,
    });
  } catch (err) {
    console.error("[ai-audit.delivery] the email was sent, but recording the delivery failed", { engagementId: engagement.id, approvalId: ctx.approval.id, error: err instanceof Error ? err.stack : String(err) });
    await deps
      .alert({
        tenantId: t,
        alertType: "ai_audit_delivery_unrecorded",
        severity: "urgent",
        title: `Audit sent, but not yet recorded: ${engagement.business_name || "an AI audit"}`,
        body: "The client has the email and its link. The engagement has not moved to Audit Delivered yet; the next tick finishes the record. Do not retry delivery: that would send a second email.",
        subjectType: "ai_audit_engagement",
        subjectId: engagement.id,
        telegramOncePerOpen: true,
      })
      .catch((alertErr: unknown) => console.error("[ai-audit.delivery] the alert failed too", alertErr instanceof Error ? alertErr.message : alertErr));
  }
  return { ok: true, result: { outcome: "sent", provider: sent.provider, message_id: sent.gmail_message_id || null, from: sent.from_address } };
}

/**
 * Mark a sent delivery delivered: the versions, the engagement's stage, link
 * and approval, and the trail, in one compare-and-swap (retried on a
 * concurrent small write such as the tick flagging health). Then the lead.
 */
async function recordDelivery(
  db: Client,
  input: { tenantId: string; engagementId: string; auditVersionId: string; proposalVersionId: string; approvalId: string; linkId: string; actor: Actor; messageId: string | null; to: string },
): Promise<boolean> {
  const t = input.tenantId;
  let recorded = false;
  for (let attempt = 0; attempt < 4 && !recorded; attempt++) {
    const current = await getEngagement(db, t, input.engagementId);
    if (!current || current.stage !== "final_review") break;
    const at = new Date().toISOString();
    recorded = await casWrite(
      db,
      engagementUpdateStatement(t, current.id, current.row_version, { share_link_id: input.linkId, delivery_approval_id: input.approvalId, health: "ok", health_reason: null }, at, "delivered"),
      [
        { sql: "UPDATE ai_audit_versions SET status = 'delivered', approved_at = COALESCE(approved_at, ?), delivered_at = ?, approval_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'awaiting_approval'", args: [at, at, input.approvalId, at, t, input.auditVersionId] },
        { sql: "UPDATE ai_audit_proposal_versions SET status = 'delivered', approved_at = COALESCE(approved_at, ?), delivered_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'awaiting_approval'", args: [at, at, at, t, input.proposalVersionId] },
        eventStatement({
          tenantId: t,
          engagementId: current.id,
          event: "delivered",
          actor: input.actor,
          at,
          fromStage: "final_review",
          toStage: "delivered",
          refType: "approval",
          refId: input.approvalId,
          meta: { share_link_id: input.linkId, message_id: input.messageId, to: input.to },
        }),
      ],
    );
  }
  if (!recorded) {
    // Sent, but the engagement moved on underneath (cancelled while sending).
    // Say so loudly; the approval still records "sent" with the message id.
    console.error("[ai-audit.delivery] sent, but the engagement is no longer in final review; delivery recorded as an event only", { engagementId: input.engagementId });
    await db.execute(
      eventStatement({ tenantId: t, engagementId: input.engagementId, event: "delivered_while_moved", actor: { type: "system", id: null }, at: new Date().toISOString(), refType: "approval", refId: input.approvalId, meta: { share_link_id: input.linkId } }),
    );
    return false;
  }
  const after = await getEngagement(db, t, input.engagementId);
  if (after) await syncLeadStage(db, after, input.actor, new Date());
  return true;
}

/**
 * The tick's repair for a delivery that was SENT but never recorded (the
 * write after the send failed): the approval says "sent" and its link exists,
 * yet the engagement still waits in final review. Finish the record; never
 * send again.
 */
export async function repairUnrecordedDelivery(db: Client, tenantId: string, engagement: Engagement): Promise<boolean> {
  const t = requireTenant(tenantId);
  if (engagement.stage !== "final_review" || !engagement.delivery_approval_id) return false;
  const approval = await getApprovalInTenant(db, t, engagement.delivery_approval_id);
  const result = approval?.execution_result as { outcome?: unknown; message_id?: unknown } | null;
  if (!approval || approval.status !== "executed" || result?.outcome !== "sent") return false;
  let payload: Record<string, unknown>;
  try {
    payload = parsePayload(approval);
  } catch {
    return false;
  }
  const v = validateDeliverAiAuditPayload(payload);
  if (!v.ok || v.value.engagement_id !== engagement.id) return false;
  const link = await linkForApproval(db, t, approval.id);
  if (!link) return false;
  return recordDelivery(db, {
    tenantId: t,
    engagementId: engagement.id,
    auditVersionId: v.value.audit_version_id,
    proposalVersionId: v.value.proposal_version_id,
    approvalId: approval.id,
    linkId: link.id,
    actor: { type: "system", id: null },
    messageId: typeof result.message_id === "string" ? result.message_id : null,
    to: v.value.to,
  });
}

/**
 * CC checked the Sent folder after an uncertain send and the email DID go:
 * record the delivery exactly as a confirmed send would have, with the link
 * that email carries. Nothing is sent.
 */
export async function confirmUncertainDelivery(db: Client, input: { tenantId: string; engagementId: string; actor: Actor }): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = requireTenant(input.tenantId);
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement || engagement.stage !== "final_review" || !engagement.delivery_approval_id) return { ok: false, error: "nothing_uncertain" };
  const approval = await getApprovalInTenant(db, t, engagement.delivery_approval_id);
  const reason = (approval?.execution_result as { reason?: unknown } | null)?.reason;
  if (!approval || approval.status !== "failed" || reason !== "delivery_unknown") return { ok: false, error: "nothing_uncertain" };
  let payload: Record<string, unknown>;
  try {
    payload = parsePayload(approval);
  } catch {
    return { ok: false, error: "payload_unreadable" };
  }
  const v = validateDeliverAiAuditPayload(payload);
  if (!v.ok) return { ok: false, error: "payload_unreadable" };
  const link = await linkForApproval(db, t, approval.id);
  if (!link || link.revoked_at) return { ok: false, error: "link_gone" };
  await db.execute(eventStatement({ tenantId: t, engagementId: engagement.id, event: "delivery_confirmed_by_owner", actor: input.actor, at: new Date().toISOString(), refType: "approval", refId: approval.id }));
  const recorded = await recordDelivery(db, {
    tenantId: t,
    engagementId: engagement.id,
    auditVersionId: v.value.audit_version_id,
    proposalVersionId: v.value.proposal_version_id,
    approvalId: approval.id,
    linkId: link.id,
    actor: input.actor,
    messageId: null,
    to: v.value.to,
  });
  return recorded ? { ok: true } : { ok: false, error: "stage_moved" };
}

export const deliverAiAuditExecutor: Executor = {
  // Shown on the card before anyone approves. The run re-checks everything.
  readiness: (tenant, deps) => {
    if (!isOasisInternalTenant(tenant.id)) return "AI audits run only in OASIS's own workspaces.";
    const secret = (deps.aiAudit ?? defaultAiAuditExecutorDeps()).linkSecret();
    if (!secret) return "AI_AUDIT_LINK_SECRET is not set on this deployment, so no private link can be made yet.";
    return null;
  },
  run: runDelivery,
};
