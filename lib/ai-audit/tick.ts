/**
 * lib/ai-audit/tick.ts — the Free AI Audit's scheduled upkeep
 * (/api/cron/ai-audit-tick, every five minutes in phase 1).
 *
 * Each run, for each of OASIS's own workspaces, within a time budget:
 *   1. queue a PDF print for any submitted audit that has none and no job;
 *   2. file Gate 2 (the delivery approval) once its PDF exists;
 *   3. check open Stripe checkouts with Stripe (the fallback to the webhook);
 *   4. run or resume onboarding for verified payments;
 *   5. finish onboarding when the checklist is done;
 *   6. re-check recent receipts for refunds and disputes (each at most hourly);
 *   7. flag stalls (not opened in 3 days, opened but unpaid for 7 days), once;
 *   8. repair a lead whose pipeline stage fell behind its engagement.
 * Nothing here contacts a client. Every step is safe to repeat.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { OASIS_INTERNAL_TENANT_IDS } from "@/lib/ai/tools/client-safe-registry";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { WAITING_ON_CLIENT_STAGES, stallReason } from "@/lib/ai-audit/rules";
import { listEngagements, patchEngagement, aiAuditTablesInstalled, type Engagement } from "@/lib/ai-audit/store";
import { getAuditVersion } from "@/lib/ai-audit/versions";
import { queuePdfJob } from "@/lib/ai-audit/pdf";
import { requestDeliveryApproval } from "@/lib/ai-audit/delivery";
import { defaultPaymentDeps, dueOpenCheckouts, reconcileReceipts, verifyCheckout, type PaymentDeps } from "@/lib/ai-audit/payment";
import { completeOnboardingIfDone, defaultOnboardingDeps, runOnboarding, type OnboardingDeps } from "@/lib/ai-audit/onboarding";
import { syncLeadStage } from "@/lib/ai-audit/lifecycle";
import { getShareLink } from "@/lib/ai-audit/link";

export type TickDeps = { payment: PaymentDeps; onboarding: OnboardingDeps };

export type TickReport = {
  tenants: number;
  pdfsQueued: number;
  approvalsFiled: number;
  checkoutsChecked: number;
  paymentsVerified: number;
  onboardingRuns: number;
  activated: number;
  receiptsChecked: number;
  stallsFlagged: number;
  leadsRepaired: number;
  errors: Array<{ tenantId: string; step: string; engagementId?: string; error: string }>;
  stoppedForBudget: boolean;
};

const DAY = 86_400_000;

export async function runAiAuditTick(
  db: Client,
  opts: { now?: () => Date; budgetMs?: number; tenantIds?: readonly string[]; deps?: TickDeps } = {},
): Promise<TickReport> {
  const now = opts.now ?? (() => new Date());
  const started = Date.now();
  const budget = opts.budgetMs ?? 200_000;
  const deps: TickDeps = opts.deps ?? { payment: defaultPaymentDeps(), onboarding: defaultOnboardingDeps() };
  const report: TickReport = {
    tenants: 0,
    pdfsQueued: 0,
    approvalsFiled: 0,
    checkoutsChecked: 0,
    paymentsVerified: 0,
    onboardingRuns: 0,
    activated: 0,
    receiptsChecked: 0,
    stallsFlagged: 0,
    leadsRepaired: 0,
    errors: [],
    stoppedForBudget: false,
  };
  if (!(await aiAuditTablesInstalled(db))) return report;
  const over = () => Date.now() - started > budget;
  const tenants = (opts.tenantIds ?? [...OASIS_INTERNAL_TENANT_IDS]).filter((t) => !isRetiredTenant(t));

  for (const tenantId of tenants) {
    if (over()) {
      report.stoppedForBudget = true;
      break;
    }
    report.tenants += 1;
    const guard = async (step: string, engagementId: string | undefined, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error("[ai-audit.tick]", { tenantId, step, engagementId, error });
        report.errors.push({ tenantId, step, ...(engagementId ? { engagementId } : {}), error: error.slice(0, 300) });
      }
    };

    let open: Engagement[] = [];
    await guard("list", undefined, async () => {
      open = await listEngagements(db, tenantId, { limit: 300 });
    });

    // 1-2. The PDF, then Gate 2.
    for (const e of open.filter((x) => x.stage === "final_review")) {
      if (over()) break;
      await guard("final_review", e.id, async () => {
        const audit = e.current_audit_version_id ? await getAuditVersion(db, tenantId, e.current_audit_version_id) : null;
        if (!audit || audit.status !== "awaiting_approval") return;
        if (!audit.pdf_sha256) {
          if (await queuePdfJob(db, { tenantId, engagementId: e.id, auditVersionId: audit.id, contentSha256: audit.content_sha256, now: now() })) report.pdfsQueued += 1;
          return;
        }
        const filed = await requestDeliveryApproval(db, { tenantId, engagementId: e.id, now: now() });
        if (filed.ok && filed.created) report.approvalsFiled += 1;
      });
    }

    // 3. Open checkouts, checked with Stripe.
    await guard("checkouts", undefined, async () => {
      for (const c of await dueOpenCheckouts(db, tenantId, now(), 10)) {
        if (over()) break;
        report.checkoutsChecked += 1;
        const v = await verifyCheckout(db, { tenantId, checkoutId: c.id, now: now(), trigger: "tick", deps: deps.payment });
        if (v.status === "paid" && !v.duplicate) report.paymentsVerified += 1;
      }
    });

    // 4-5. Onboarding.
    for (const e of open.filter((x) => x.stage === "payment_confirmed" || (x.stage === "onboarding" && x.onboarding_status !== "done"))) {
      if (over()) break;
      await guard("onboarding", e.id, async () => {
        if (e.stage === "payment_confirmed" || !e.delivery_project_id || !e.customer_id) {
          report.onboardingRuns += 1;
          await runOnboarding(db, { tenantId, engagementId: e.id, now: now(), deps: deps.onboarding });
        } else if (await completeOnboardingIfDone(db, { tenantId, engagementId: e.id, now: now() })) {
          report.activated += 1;
        }
      });
    }

    // 6. Refunds and disputes.
    await guard("receipts", undefined, async () => {
      const r = await reconcileReceipts(db, tenantId, now(), deps.payment, 10);
      report.receiptsChecked += r.checked;
    });

    // 7. Stalls: flagged once (health ok → stalled), with one alert.
    for (const e of open.filter((x) => WAITING_ON_CLIENT_STAGES.includes(x.stage) && x.health === "ok" && x.share_link_id)) {
      if (over()) break;
      await guard("stall", e.id, async () => {
        const link = await getShareLink(db, tenantId, e.share_link_id as string);
        if (!link) return;
        const reason = stallReason(e, link, now());
        if (!reason) return;
        const r = await patchEngagement(db, { tenantId, id: e.id, expectedRowVersion: e.row_version, patch: { health: "stalled", health_reason: reason }, event: "stalled", actor: { type: "system", id: null }, now: now() });
        if (!r.ok) return;
        report.stallsFlagged += 1;
        await deps.payment.alert({
          tenantId,
          alertType: "ai_audit_stalled",
          severity: "info",
          title: `Stalled: ${e.business_name || "an AI audit"}`,
          body: `${reason} A follow-up is your call.`,
          subjectType: "ai_audit_engagement",
          subjectId: e.id,
          telegramOncePerOpen: true,
        });
      });
    }

    // 8. Leads that fell behind (recently active engagements only).
    for (const e of open.filter((x) => now().getTime() - Date.parse(x.updated_at) < 14 * DAY)) {
      if (over()) break;
      await guard("lead_sync", e.id, async () => {
        const moved = await syncLeadStage(db, e, { type: "system", id: null }, now());
        if (moved?.moved) report.leadsRepaired += 1;
      });
    }
  }
  if (over()) report.stoppedForBudget = true;
  return report;
}
