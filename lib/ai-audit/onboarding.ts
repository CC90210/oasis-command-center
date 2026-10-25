/**
 * lib/ai-audit/onboarding.ts — after Stripe confirms the payment (brief
 * section 10).
 *
 * Runs from the tick (and right after a verified payment), any number of
 * times. Every step has its own fixed key, so a second run finds the first
 * run's work and creates nothing new:
 *   1. the lead moves to won, then onboarding (forward-only, request ids);
 *   2. the client record (convertLeadToCustomer: one per lead; an email that
 *      belongs to another client stops here and flags CC, never duplicates);
 *   3. the delivery project (a UUID derived from the engagement);
 *   4. the checklist: the standard steps plus each proposal line's own
 *      onboarding requirements (UUIDs derived from the project and the step);
 *   5. the welcome email, as a one-tap send_email APPROVAL for CC (never sent
 *      automatically). It links the intake form and the kickoff booking page;
 *      credentials are collected only through Connections or the intake form;
 *   6. one alert to CC.
 * When every required task is done, the engagement becomes Active Client and
 * the lead moves to in_build (completeOnboardingIfDone).
 */
import "server-only";
import type { Client } from "@libsql/client";
import { convertLeadToCustomer, getCustomer } from "@/lib/os/customers/store";
import { createProject, createTask } from "@/lib/delivery/store";
import { createApproval } from "@/lib/os/approvals/store";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { CLIENT_ONBOARDING_SLUG, CLIENT_ONBOARDING_TENANT_SLUG } from "@/lib/forms/oasis-client-onboarding-seed";
import { deterministicUuid } from "@/lib/ai-audit/hash";
import { aiAuditBaseUrl } from "@/lib/ai-audit/env";
import { advanceEngagement, moveLeadForward, leadRequestId } from "@/lib/ai-audit/lifecycle";
import { getProposalVersion } from "@/lib/ai-audit/versions";
import { getEngagement, int, patchEngagement, requireTenant, type Actor, type Engagement } from "@/lib/ai-audit/store";

export const STANDARD_CHECKLIST: ReadonlyArray<{ key: string; title: string; notes: string }> = [
  { key: "kickoff", title: "Hold the kickoff call", notes: "Confirm scope, owners and timeline against the approved proposal." },
  { key: "intake", title: "Receive the onboarding intake form", notes: "The client fills it in at the link in the welcome email." },
  { key: "access", title: "Get access to the systems in scope", notes: "Through Connections (OAuth) only. Never accept a password by email, chat or a call transcript." },
  { key: "plan", title: "Share the implementation plan", notes: "The roadmap's first phase, with dates, in the client portal." },
];

export function intakeFormUrl(base: string): string {
  return `${base}/f/${CLIENT_ONBOARDING_TENANT_SLUG}/${CLIENT_ONBOARDING_SLUG}`;
}

export function welcomeEmailBody(input: { contactName: string | null; businessName: string; base: string }): string {
  const greeting = input.contactName ? `Hi ${input.contactName.split(/\s+/)[0]},` : "Hi,";
  return [
    greeting,
    "",
    `Thank you. Your payment is confirmed and the work for ${input.businessName} is starting.`,
    "",
    "Two things to begin:",
    `1. Fill in the short onboarding form: ${intakeFormUrl(input.base)}`,
    `2. Pick a time for our kickoff call: ${input.base}/book`,
    "",
    "Please never send passwords by email. When we need access to a system, we will send a secure connection request instead.",
    "",
    "Reply here with any questions.",
  ].join("\n");
}

export type OnboardingDeps = {
  alert: (input: Parameters<typeof writeAgentAlert>[0]) => Promise<unknown>;
  baseUrl: () => string;
};

export function defaultOnboardingDeps(): OnboardingDeps {
  return { alert: (i) => writeAgentAlert(i), baseUrl: aiAuditBaseUrl };
}

/** Only a UNIQUE index refusing means "it already exists"; any other constraint is a real failure. */
function isUniqueViolation(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown; extendedCode?: unknown } | null) ?? null;
  return /UNIQUE constraint failed/i.test(m) || code?.extendedCode === "SQLITE_CONSTRAINT_UNIQUE" || code?.extendedCode === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

export type OnboardingResult = { ok: true; engagement: Engagement; done: string[] } | { ok: false; error: string; done: string[] };

const SYSTEM: Actor = { type: "system", id: null };

export async function runOnboarding(
  db: Client,
  input: { tenantId: string; engagementId: string; now: Date; deps?: OnboardingDeps },
): Promise<OnboardingResult> {
  const deps = input.deps ?? defaultOnboardingDeps();
  const t = requireTenant(input.tenantId);
  const done: string[] = [];
  let engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement) return { ok: false, error: "not_found", done };
  if (engagement.stage !== "payment_confirmed" && engagement.stage !== "onboarding") return { ok: false, error: "not_paid", done };
  if (engagement.payment_status !== "paid") return { ok: false, error: "payment_not_clear", done };

  // 1. The lead: won, then onboarding.
  for (const target of ["won", "onboarding"] as const) {
    await moveLeadForward(db, {
      tenantId: t,
      leadId: engagement.lead_id,
      target,
      requestId: `${leadRequestId(engagement, "payment_confirmed")}:${target}`,
      actorUserId: "system:ai-audit",
      note: target === "won" ? "AI audit: payment confirmed by Stripe." : "AI audit: onboarding started.",
      now: input.now,
    });
  }
  done.push("lead");

  // 2. The client record.
  let customerId = engagement.customer_id;
  if (!customerId) {
    const converted = await convertLeadToCustomer(db, t, engagement.lead_id, engagement.created_by, input.now);
    if (!converted.ok) {
      const reason =
        converted.error === "email_belongs_to_another_client"
          ? "The client's email already belongs to another client record. Link or merge them, then retry onboarding."
          : `Could not create the client record (${converted.error}).`;
      await patchEngagement(db, { tenantId: t, id: engagement.id, expectedRowVersion: engagement.row_version, patch: { health: "attention", health_reason: reason, onboarding_status: "blocked" }, event: "onboarding_blocked", actor: SYSTEM, now: input.now, meta: { step: "customer", error: converted.error } });
      return { ok: false, error: converted.error, done };
    }
    customerId = converted.customer.id;
    const r = await patchEngagement(db, { tenantId: t, id: engagement.id, expectedRowVersion: engagement.row_version, patch: { customer_id: customerId, onboarding_status: "in_progress" }, event: "onboarding_customer_linked", actor: SYSTEM, now: input.now, refType: "customer", refId: customerId });
    if (!r.ok) return { ok: false, error: "conflict", done };
    engagement = r.engagement;
  }
  done.push("customer");

  // 3. The delivery project.
  const projectId = deterministicUuid(`project:${engagement.id}`);
  const proposal = engagement.current_proposal_version_id ? await getProposalVersion(db, t, engagement.current_proposal_version_id) : null;
  const lines = proposal?.content?.lines.filter((l) => !l.optional) ?? [];
  if (!engagement.delivery_project_id) {
    // An existing customer may already have its own client workspace; the
    // project must name the same one, or createProject refuses it (Codex review of PR #732).
    const customer = await getCustomer(db, t, customerId);
    const description = [
      "From the approved Free AI Audit proposal.",
      ...lines.map((l) => `- ${l.name}${l.quantity > 1 ? ` x${l.quantity}` : ""}`),
    ].join("\n").slice(0, 4_000);
    try {
      await createProject(
        db,
        t,
        {
          id: projectId,
          title: `${engagement.business_name || "Client"}: AI implementation`.slice(0, 200),
          description,
          client_tenant_id: customer?.client_tenant_id ?? null,
          client_name: engagement.business_name,
          client_email: engagement.contact_email,
          lead_id: engagement.lead_id,
          stage: "discovery",
          priority: "medium",
          assigned_to: engagement.created_by,
          due_date: null,
          customer_id: customerId,
        },
        { userId: null, name: "AI audit onboarding" },
        input.now,
      );
    } catch (err) {
      if (!isUniqueViolation(err)) {
        await patchEngagement(db, { tenantId: t, id: engagement.id, expectedRowVersion: engagement.row_version, patch: { health: "attention", health_reason: "Could not create the delivery project. Onboarding will retry.", onboarding_status: "blocked" }, event: "onboarding_blocked", actor: SYSTEM, now: input.now, meta: { step: "project", error: err instanceof Error ? err.message.slice(0, 200) : "error" } });
        return { ok: false, error: "project_failed", done };
      }
    }
    const r = await patchEngagement(db, { tenantId: t, id: engagement.id, expectedRowVersion: engagement.row_version, patch: { delivery_project_id: projectId, onboarding_status: "in_progress", health: "ok", health_reason: null }, event: "onboarding_project_created", actor: SYSTEM, now: input.now, refType: "delivery_project", refId: projectId });
    if (!r.ok) return { ok: false, error: "conflict", done };
    engagement = r.engagement;
  }
  done.push("project");

  // 4. The checklist.
  const steps = [
    ...STANDARD_CHECKLIST.map((s) => ({ key: `std:${s.key}`, title: s.title, notes: s.notes })),
    ...lines.flatMap((l) => l.onboarding_requirements.map((req, i) => ({ key: `line:${l.line_id}:${i}`, title: req.slice(0, 200), notes: `Needed for ${l.name}.` }))),
  ];
  for (const s of steps) {
    try {
      await createTask(db, t, engagement.delivery_project_id ?? projectId, { id: deterministicUuid(`task:${engagement.id}:${s.key}`), title: s.title, notes: s.notes, due_date: null, assigned_to: engagement.created_by }, input.now);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  done.push("checklist");

  // 5. The welcome email, for CC to approve with one tap.
  if (engagement.contact_email) {
    const base = deps.baseUrl();
    const welcome = await createApproval(
      db,
      {
        tenantId: t,
        departmentKey: null,
        requestedBy: { type: "routine", id: "ai-audit" },
        actionKind: "send_email",
        title: `Welcome email for ${engagement.business_name || "the new client"}`,
        targetRef: `customer:${customerId}`,
        payload: {
          to: engagement.contact_email,
          subject: `Welcome to OASIS AI: next steps for ${engagement.business_name || "your project"}`,
          body: welcomeEmailBody({ contactName: engagement.contact_name, businessName: engagement.business_name || "your business", base }),
          lead_id: engagement.lead_id,
        },
        idempotencyKey: `ai-audit-welcome:${engagement.id}`,
      },
      input.now,
    );
    if (!welcome.ok && welcome.error !== "idempotency_key_reused") {
      console.error("[ai-audit.onboarding] the welcome email approval was not created", { engagementId: engagement.id, error: welcome.error });
    }
  }
  done.push("welcome_email");

  // 6. Stage and alert, once.
  if (engagement.stage === "payment_confirmed") {
    const moved = await advanceEngagement(db, { tenantId: t, engagementId: engagement.id, to: "onboarding", actor: SYSTEM, now: input.now, event: "onboarding_started", meta: { project_id: projectId, tasks: steps.length } });
    if (moved.ok) {
      engagement = moved.engagement;
      await deps.alert({
        tenantId: t,
        alertType: "ai_audit_paid",
        severity: "info",
        title: `Paid: ${engagement.business_name || "an AI audit client"}`,
        body: "Stripe confirmed the payment. The client record, project and checklist are ready, and the welcome email is waiting for your approval.",
        subjectType: "ai_audit_engagement",
        subjectId: engagement.id,
        telegram: true,
        telegramOncePerOpen: true,
      });
    }
  }
  done.push("stage");
  return { ok: true, engagement, done };
}

/** Onboarding → Active Client when every checklist task is done or cancelled. */
export async function completeOnboardingIfDone(db: Client, input: { tenantId: string; engagementId: string; now: Date }): Promise<boolean> {
  const t = requireTenant(input.tenantId);
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement || engagement.stage !== "onboarding" || !engagement.delivery_project_id) return false;
  const rs = await db.execute({
    sql: "SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('done', 'cancelled') THEN 1 ELSE 0 END) AS closed FROM delivery_tasks WHERE tenant_id = ? AND project_id = ?",
    args: [t, engagement.delivery_project_id],
  });
  const total = int(rs.rows[0]?.total);
  const closed = int(rs.rows[0]?.closed);
  if (total === 0 || closed < total) return false;
  const moved = await advanceEngagement(db, { tenantId: t, engagementId: engagement.id, to: "active_client", actor: SYSTEM, now: input.now, patch: { onboarding_status: "done" }, event: "onboarding_complete" });
  return moved.ok;
}
