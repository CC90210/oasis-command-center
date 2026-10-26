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
 *   7b. advance profile drafting from transcripts;
 *   7c. build the first pre-call brief for engagements at Research in Progress
 *       or Discovery Call Scheduled (it reads the client's public website),
 *       each on its own: a try is marked before it starts, and one that fails
 *       waits before the next (lib/ai-audit/briefs.ts dueBriefs);
 *   7d. research after Gate 1: start a run for an engagement in Research &
 *       Audit Generation that has none, and move each run one phase
 *       (lib/ai-audit/research.ts); when a run finishes and nothing has been
 *       drafted yet, draft the audit and its proposal from it
 *       (lib/ai-audit/drafting.ts);
 *   8. repair a lead whose pipeline stage fell behind its engagement.
 * Nothing here contacts a client. Every step is safe to repeat.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { OASIS_INTERNAL_TENANT_IDS } from "@/lib/ai/tools/client-safe-registry";
import { isRetiredTenant } from "@/lib/tenant/retired";
import { WAITING_ON_CLIENT_STAGES, shortName, stallReason } from "@/lib/ai-audit/rules";
import { eventStatement, listEngagements, patchEngagement, aiAuditTablesInstalled, type Engagement } from "@/lib/ai-audit/store";
import { getAuditVersion } from "@/lib/ai-audit/versions";
import { PDF_MAX_FAILURES, pdfFailures, queuePdfJob } from "@/lib/ai-audit/pdf";
import { repairUnrecordedDelivery, requestDeliveryApproval } from "@/lib/ai-audit/delivery";
import {
  closedEngagementsWithOpenCheckouts,
  defaultPaymentDeps,
  dueOpenCheckouts,
  expireOpenCheckouts,
  reconcileReceipts,
  settleVerifiedReceipts,
  verifyCheckout,
  type PaymentDeps,
} from "@/lib/ai-audit/payment";
import { completeOnboardingIfDone, defaultOnboardingDeps, runOnboarding, type OnboardingDeps } from "@/lib/ai-audit/onboarding";
import { syncLeadStage } from "@/lib/ai-audit/lifecycle";
import { advanceCloudExtraction, defaultCloudModel, dueExtractions, finishMacExtractionIfComplete, sweepStaleExtractions, type CloudDeps } from "@/lib/ai-audit/extraction";
import { getShareLink } from "@/lib/ai-audit/link";
import { BRIEF_ATTEMPT_EVENT, briefTablesInstalled, buildBrief, defaultSiteDeps, dueBriefs } from "@/lib/ai-audit/briefs";
import type { SiteReadDeps } from "@/lib/ai-audit/site-fetch";
import { autoAttachMeetTranscripts } from "@/lib/ai-audit/meet-link";
import { advanceResearch, defaultPageSpeedDeps, dueResearch, noteResearchFailure, purgeUnauthorizedResearch, researchTablesInstalled, RESEARCH_PHASE_MS, startResearch, type ResearchDeps } from "@/lib/ai-audit/research";
import { purgeVoidedResearch } from "@/lib/ai-audit/research-purge";
import { draftAuditFromResearch, draftProposalFromAudit } from "@/lib/ai-audit/drafting";
import { advanceCloudWriting, callOffStaleWriting, defaultWriteModel, dueWriting, startWriting, type WriteDeps } from "@/lib/ai-audit/writing";
import { fileFollowUp, withdrawStaleFollowUps } from "@/lib/ai-audit/follow-up";

export type TickDeps = { payment: PaymentDeps; onboarding: OnboardingDeps; extraction?: CloudDeps; site?: SiteReadDeps; research?: ResearchDeps; writing?: WriteDeps };

export type TickReport = {
  tenants: number;
  pdfsQueued: number;
  approvalsFiled: number;
  checkoutsChecked: number;
  paymentsVerified: number;
  onboardingRuns: number;
  activated: number;
  receiptsChecked: number;
  paymentsSettled: number;
  checkoutsExpired: number;
  deliveriesRepaired: number;
  pdfsGivenUp: number;
  stallsFlagged: number;
  /** Follow-up emails filed for CC's approval when a stall was flagged; and cards withdrawn that no longer fit. */
  followUpsFiled: number;
  followUpsWithdrawn: number;
  leadsRepaired: number;
  extractionsAdvanced: number;
  briefsBuilt: number;
  /** Oasis Meet transcripts attached to their engagement; and those listed for CC (no AI answer, a guest who did not agree, a call held for his hand). */
  meetTranscriptsAttached: number;
  meetTranscriptsWaiting: number;
  /** Research runs started after Gate 1, and phases moved. */
  researchStarted: number;
  researchAdvanced: number;
  /** First drafts of an audit (and its proposal) made from a research run that just finished. */
  auditsDrafted: number;
  /** Passes over an audit's opening prose started, and cloud passes run. */
  writingStarted: number;
  writingRun: number;
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
  // Under the cron forwarder's 120-second wait (workers/oasis-cc-cron), so a slow tick is never retried while it runs.
  const budget = opts.budgetMs ?? 100_000;
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
    paymentsSettled: 0,
    checkoutsExpired: 0,
    deliveriesRepaired: 0,
    pdfsGivenUp: 0,
    stallsFlagged: 0,
    followUpsFiled: 0,
    followUpsWithdrawn: 0,
    leadsRepaired: 0,
    extractionsAdvanced: 0,
    briefsBuilt: 0,
    meetTranscriptsAttached: 0,
    meetTranscriptsWaiting: 0,
    researchStarted: 0,
    researchAdvanced: 0,
    auditsDrafted: 0,
    writingStarted: 0,
    writingRun: 0,
    errors: [],
    stoppedForBudget: false,
  };
  if (!(await aiAuditTablesInstalled(db))) return report;
  // The brief alone needs bravo__241: without it, step 7c reports itself and every other step runs.
  const briefsInstalled = await briefTablesInstalled(db);
  // Research alone needs bravo__243: without it, step 7d reports itself (once something waits on it) and every other step runs.
  const researchInstalled = await researchTablesInstalled(db);
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
        // Sent but never recorded (the write after the send failed): finish the record, never send again.
        if (await repairUnrecordedDelivery(db, tenantId, e)) {
          report.deliveriesRepaired += 1;
          return;
        }
        const audit = e.current_audit_version_id ? await getAuditVersion(db, tenantId, e.current_audit_version_id) : null;
        if (!audit || audit.status !== "awaiting_approval") return;
        if (!audit.pdf_sha256) {
          // A Mac that keeps failing the print gets three tries, then CC is asked, once.
          const failures = await pdfFailures(db, tenantId, audit.id);
          if (failures.count >= PDF_MAX_FAILURES) {
            if (e.health === "ok") {
              const reason = `The Mac could not print the PDF (${failures.count} tries${failures.lastError ? `; last: ${failures.lastError}` : ""}). Fix it, then press Retry PDF.`;
              const r = await patchEngagement(db, { tenantId, id: e.id, expectedRowVersion: e.row_version, patch: { health: "attention", health_reason: reason }, event: "pdf_failed", actor: { type: "system", id: null }, now: now() });
              if (r.ok) {
                report.pdfsGivenUp += 1;
                await deps.payment.alert({
                  tenantId,
                  alertType: "ai_audit_pdf_failed",
                  severity: "warn",
                  title: `PDF not printed: ${e.business_name || "an AI audit"}`,
                  body: reason,
                  subjectType: "ai_audit_engagement",
                  subjectId: e.id,
                  telegramOncePerOpen: true,
                });
              }
            }
            return;
          }
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

    // 3b. Verified payments whose engagement has not caught up, and sessions still open that the client must not pay
    // (closed, being revised, past payment, or for a replaced proposal: closedEngagementsWithOpenCheckouts).
    await guard("settle", undefined, async () => {
      report.paymentsSettled += await settleVerifiedReceipts(db, tenantId, now(), deps.payment, 10);
    });
    await guard("expire_closed", undefined, async () => {
      for (const id of await closedEngagementsWithOpenCheckouts(db, tenantId, 5, now())) {
        if (over()) break;
        report.checkoutsExpired += (await expireOpenCheckouts(db, tenantId, id, now(), deps.payment)).expired;
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
        // A follow-up email waits for CC's one tap (phase 5): never sent from here. A card that cannot be filed never
        // swallows the alert (review of phase 5).
        let filed = false;
        try {
          filed = await fileFollowUp(db, { tenantId, engagement: e, link, reason: link.first_viewed_at ? "not_paid" : "not_opened", base: deps.onboarding.baseUrl(), now: now() });
        } catch (err) {
          console.error("[ai-audit.tick] the follow-up card was not filed", { engagementId: e.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
        }
        if (filed) report.followUpsFiled += 1;
        await deps.payment.alert({
          tenantId,
          alertType: "ai_audit_stalled",
          severity: "info",
          title: `Stalled: ${shortName(e.business_name, "an AI audit")}`,
          body: filed ? `${reason} A follow-up email is waiting for your approval in Needs you.` : `${reason} A follow-up is your call.`,
          subjectType: "ai_audit_engagement",
          subjectId: e.id,
          telegramOncePerOpen: true,
        });
      });
    }

    // 7a. Follow-up cards still waiting that no longer fit (paid, declined, a new link, opened): withdrawn.
    await guard("follow_ups", undefined, async () => {
      report.followUpsWithdrawn += await withdrawStaleFollowUps(db, tenantId, now());
    });

    // 7b. Drafting profiles from transcripts: cloud runs one window per tick; Mac runs
    // whose windows are all in but were never finished are finished here.
    await guard("extraction", undefined, async () => {
      const extraction = deps.extraction ?? { model: defaultCloudModel(), alert: deps.payment.alert };
      const due = await dueExtractions(db, tenantId, now());
      for (const stepId of due.cloud) {
        if (over()) break;
        await advanceCloudExtraction(db, { tenantId, stepId, now: now(), deps: extraction });
        report.extractionsAdvanced += 1;
      }
      for (const stepId of due.macToFinish) {
        if (over()) break;
        if (await finishMacExtractionIfComplete(db, tenantId, stepId, now(), extraction)) report.extractionsAdvanced += 1;
      }
      if (!over()) await sweepStaleExtractions(db, tenantId, now(), extraction);
    });

    // 7b2. A discovery call held in Oasis Meet: its transcript, once ready, joins the engagement when every
    // guest agreed to the recording, the owner recorded the client's AI answer, and nothing holds it for his
    // hand; a Gate 1 card it makes stale is withdrawn (lib/ai-audit/meet-link.ts autoAttachMeetTranscripts).
    await guard("meet_transcripts", undefined, async () => {
      const r = await autoAttachMeetTranscripts(db, tenantId, now(), deps.payment.alert);
      report.meetTranscriptsAttached += r.attached;
      report.meetTranscriptsWaiting += r.waiting;
    });

    // 7c. The first pre-call brief, two per tick at most: each reads a website (up to 25 seconds).
    // Each engagement is tried on its own, and the try is marked before it starts, so one
    // that throws (or a run killed mid-build) waits its turn instead of blocking the rest.
    let dueForBrief: string[] = [];
    await guard("briefs", undefined, async () => {
      if (!briefsInstalled) throw new Error("the brief tables are missing: apply database/turso/bravo__241_ai_audit_briefs.sql");
      dueForBrief = await dueBriefs(db, tenantId, 2, now());
    });
    for (const id of dueForBrief) {
      if (over()) break;
      await guard("brief", id, async () => {
        const system = { type: "system" as const, id: null };
        await db.execute(eventStatement({ tenantId, engagementId: id, event: BRIEF_ATTEMPT_EVENT, actor: system, at: now().toISOString() }));
        try {
          const r = await buildBrief(db, { tenantId, engagementId: id, actor: system, now: now(), deps: deps.site ?? defaultSiteDeps() });
          if (r.ok && r.created) report.briefsBuilt += 1;
        } catch (err) {
          // Kept on the engagement too, for whoever looks into why it has no brief.
          const error = err instanceof Error ? err.message : String(err);
          await db
            .execute(eventStatement({ tenantId, engagementId: id, event: "brief_failed", actor: system, at: now().toISOString(), meta: { error: error.slice(0, 300) } }))
            .catch((e) => console.error("[ai-audit.tick] could not record brief_failed", { tenantId, engagementId: id, error: e instanceof Error ? e.message : String(e) }));
          throw err;
        }
      });
    }

    // 7d. Research after Gate 1: two starts and three phases a tick at most (a phase reads a website or
    // the pages the search found, up to 25 seconds each, or runs PageSpeed, up to a minute).
    let research: { start: string[]; advance: string[] } = { start: [], advance: [] };
    await guard("research", undefined, async () => {
      if (!researchInstalled) {
        if (open.some((x) => x.stage === "generating")) throw new Error("the research tables are missing: apply database/turso/bravo__243_ai_audit_research.sql");
        return;
      }
      // Runs whose authorization ended (moved back, declined, cancelled) go first (review of phase 3, F4).
      await purgeVoidedResearch(db, tenantId);
      await purgeUnauthorizedResearch(db, tenantId);
      research = await dueResearch(db, tenantId, now());
    });
    const researchDeps: ResearchDeps = deps.research ?? { site: deps.site ?? defaultSiteDeps(), pagespeed: defaultPageSpeedDeps(), alert: deps.payment.alert };
    for (const id of research.start) {
      if (over()) break;
      await guard("research_start", id, async () => {
        const r = await startResearch(db, { tenantId, engagementId: id, actor: { type: "system", id: null }, now: now() });
        if (r.ok && r.created) report.researchStarted += 1;
      });
    }
    for (const stepId of research.advance) {
      // A phase may take a minute (PageSpeed): it starts only with that much of the budget left (review of phase 3, F8).
      if (over() || budget - (Date.now() - started) < RESEARCH_PHASE_MS) break;
      await guard("research", undefined, async () => {
        let r: Awaited<ReturnType<typeof advanceResearch>>;
        try {
          r = await advanceResearch(db, { tenantId, stepId, now: now(), deps: researchDeps });
        } catch (err) {
          // Counted and backed off, so one failing run never holds the queue (review of phase 3, F6).
          await noteResearchFailure(db, { tenantId, stepId, now: now(), alert: researchDeps.alert });
          throw err;
        }
        if (r === "advanced" || r === "finished") report.researchAdvanced += 1;
        if (r !== "finished") return;
        // The first drafts, once, where nothing is drafted yet: CC's own drafts are never replaced from here.
        const row = (await db.execute({ sql: "SELECT engagement_id FROM ai_audit_steps WHERE tenant_id = ? AND id = ? LIMIT 1", args: [tenantId, stepId] })).rows[0];
        if (!row) return;
        const system = { type: "system" as const, id: null };
        const engagementId = String(row.engagement_id);
        const audit = await draftAuditFromResearch(db, { tenantId, engagementId, actor: system, now: now() });
        if (!audit.ok && audit.error === "invalid") throw new Error(`the drafted audit did not validate: ${audit.detail ?? ""}`);
        if (!audit.ok) return;
        report.auditsDrafted += 1;
        const proposal = await draftProposalFromAudit(db, { tenantId, engagementId, actor: system, now: now() });
        if (!proposal.ok && proposal.error !== "draft_exists") throw new Error(`the proposal could not be drafted: ${proposal.error}`);
        // Then the model's pass over the opening, on the engine CC authorized (none when the client said no to AI).
        const write = await startWriting(db, { tenantId, engagementId, actor: system, now: now() });
        if (write.ok && write.created) report.writingStarted += 1;
      });
    }

    // 7e. The model's passes over audits' opening prose: cloud passes run here; Mac passes nobody ran for a day are called off.
    const writeDeps: WriteDeps = deps.writing ?? { model: defaultWriteModel(), alert: deps.payment.alert };
    let dueWrites: { cloud: string[]; stale: string[] } = { cloud: [], stale: [] };
    await guard("writing", undefined, async () => {
      dueWrites = await dueWriting(db, tenantId, now());
    });
    for (const stepId of dueWrites.cloud) {
      if (over()) break;
      await guard("writing", undefined, async () => {
        const r = await advanceCloudWriting(db, { tenantId, stepId, now: now(), deps: writeDeps });
        if (r === "finished") report.writingRun += 1;
      });
    }
    for (const stepId of dueWrites.stale) {
      if (over()) break;
      await guard("writing", undefined, async () => {
        await callOffStaleWriting(db, tenantId, stepId, now(), writeDeps.alert);
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
