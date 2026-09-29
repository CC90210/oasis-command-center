/**
 * lib/os/approvals/execute.ts — carry out an approved approval, exactly once.
 *
 * THE ORDER (docs/os-revamp/02 §3.3 "How an approval executes"):
 *   1. CLAIM. Compare-and-swap approved → executing (store.claimForExecution).
 *      Only the caller whose UPDATE changed the row continues. A second click,
 *      a retried request, a concurrent worker: all get `not_claimable` and do
 *      nothing. A row left in `executing` by a crash is NEVER re-run from
 *      here; it is resolved by checking the provider (the mailbox's
 *      Message-Id is derived from the idempotency key), not by sending again.
 *   2. RE-CHECK, after the claim and before any outward effect:
 *        - the stored payload still hashes to payload_hash (what was approved
 *          is what runs);
 *        - the workspace still exists and is not retired
 *          (lib/tenant/retired.ts: an offboarded workspace's data is being
 *          exported and deleted, so nothing may act for it). Each executor's
 *          readiness check refuses the retired SunBiz workspace on its own
 *          too (brand "sunbiz" has no in-app sender; it is not a founders
 *          tenant); this check does not depend on that.
 *        - an executor exists for action_kind (else: "no executor for <kind>").
 *   3. DISPATCH to the registry (executors.ts), which uses only sanctioned
 *      send paths and honours dry-run.
 *   4. RECORD executed | failed with the executor's own account, in the same
 *      batch as its audit event. A thrown executor is a recorded failure with
 *      the error text, logged — never a silent success.
 *   5. TAPE: one agent_events row for the Feed (best-effort, after the
 *      outcome is final; a tape outage never changes the recorded outcome).
 */
import "server-only";
import type { Client } from "@libsql/client";
import { canonicalJson } from "@/lib/os/approvals/rules";
import {
  claimForExecution,
  finishExecution,
  getApprovalInTenant,
  parsePayload,
  payloadHashOf,
  readTenantForExecution,
  type ApprovalRow,
} from "@/lib/os/approvals/store";
import {
  EXECUTORS,
  defaultExecutorDeps,
  noExecutorMessage,
  type ExecutorDeps,
  type ExecutorOutcome,
} from "@/lib/os/approvals/executors";
import type { AgentEventPublish } from "@/lib/manifest/events";
import { isRetiredTenant } from "@/lib/tenant/retired";

export type ExecuteArgs = {
  /** The session's tenant (or a server context that came from it). Never a request body. */
  tenantId: string;
  approvalId: string;
  approver?: { userId: string; email: string | null } | null;
  now?: () => Date;
};

export type ExecuteResult =
  | { ok: true; approval: ApprovalRow }
  | { ok: false; error: "not_found" | "not_claimable"; approval: ApprovalRow | null };

export async function executeApproval(
  db: Client,
  args: ExecuteArgs,
  deps: ExecutorDeps = defaultExecutorDeps(),
): Promise<ExecuteResult> {
  const now = args.now ?? (() => new Date());
  const tenantId = (args.tenantId || "").trim();
  if (!tenantId || !args.approvalId) return { ok: false, error: "not_found", approval: null };

  if (!(await claimForExecution(db, tenantId, args.approvalId, now()))) {
    const current = await getApprovalInTenant(db, tenantId, args.approvalId);
    return { ok: false, error: current ? "not_claimable" : "not_found", approval: current };
  }

  const approval = await getApprovalInTenant(db, tenantId, args.approvalId);
  if (!approval) throw new Error(`approvals: claimed ${args.approvalId} but cannot read it back`);

  let outcome: ExecutorOutcome;
  try {
    outcome = await runChecked(db, approval, args, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[approvals.execute] executor threw", { id: approval.id, kind: approval.action_kind }, err instanceof Error ? err.stack : err);
    outcome = { ok: false, result: { outcome: "failed", reason: "executor_error", message: message.slice(0, 500), provider: null } };
  }
  if (!outcome.ok) {
    console.error("[approvals.execute] failed", { id: approval.id, kind: approval.action_kind, reason: outcome.result.reason });
  }

  await finishExecution(db, tenantId, approval.id, { status: outcome.ok ? "executed" : "failed", result: outcome.result }, now());
  const done = await getApprovalInTenant(db, tenantId, approval.id);
  if (!done) throw new Error(`approvals: finished ${approval.id} but cannot read it back`);

  // The Feed's tape (agent_events, correlation_id = tenant) gets the outcome,
  // so an approved send shows under Shipped with everything else that left
  // the business. AFTER the row is final and best-effort: the outcome is
  // already recorded on the approval, and a tape outage must never turn a
  // sent email into a failed approval.
  try {
    await deps.publishEvent(tapeEventFor(done));
  } catch (err) {
    console.error("[approvals.execute] tape event failed", { id: done.id }, err);
  }
  return { ok: true, approval: done };
}

/**
 * The agent_events row for a finished approval. Only a real send is named
 * *_SENT (the Feed's "shipped" rule, components/os/landings/feed-model.ts): a
 * dry run, a queued post and a failure each say what they are.
 */
export function tapeEventFor(a: ApprovalRow): AgentEventPublish {
  const r = a.execution_result;
  const outcome = a.status === "failed" ? "failed" : r?.outcome ?? "unknown";
  const eventType =
    outcome === "failed"
      ? "APPROVAL_FAILED"
      : outcome === "sent"
        ? "APPROVAL_SENT"
        : outcome === "queued"
          ? "APPROVAL_QUEUED"
          : outcome === "dry_run"
            ? "APPROVAL_DRY_RUN"
            : "APPROVAL_EXECUTED";
  let target: Record<string, unknown> = {};
  if (a.action_kind === "send_email") {
    const p = parsePayload(a);
    target = { channel: "email", to: p.to, subject: p.subject };
  } else if (a.action_kind === "publish_post") {
    const p = parsePayload(a);
    target = { channel: "social", platforms: p.platforms };
  }
  return {
    eventType,
    tenantId: a.tenant_id,
    // dept:<key> is the Feed's explicit department attribution.
    publisher: a.department_key ? `dept:${a.department_key}` : "approvals",
    severity: outcome === "failed" ? "error" : "info",
    payload: {
      approval_id: a.id,
      action_kind: a.action_kind,
      title: a.title,
      revision: a.revision,
      outcome,
      ...(r?.outcome === "failed" ? { reason: r.reason, message: r.message } : {}),
      ...target,
    },
  };
}

async function runChecked(
  db: Client,
  approval: ApprovalRow,
  args: ExecuteArgs,
  deps: ExecutorDeps,
): Promise<ExecutorOutcome> {
  // What was approved is what runs. The payload column is never updated by the
  // store, so a mismatch means someone wrote around it.
  if (payloadHashOf(approval.payload_json) !== approval.payload_hash) {
    return fail("payload_changed", "The draft changed after it was approved, so it was not carried out. Ask for a new approval.");
  }
  const payload = parsePayload(approval);
  // The stored text must also be the canonical form the hash was taken of.
  if (canonicalJson(payload) !== approval.payload_json) {
    return fail("payload_changed", "The stored draft is not in the form that was approved, so it was not carried out.");
  }

  if (isRetiredTenant(approval.tenant_id)) {
    return fail("workspace_retired", "This workspace has been retired, so nothing was carried out.");
  }
  const tenant = await readTenantForExecution(db, approval.tenant_id);
  if (!tenant) return fail("workspace_missing", "This workspace no longer exists, so nothing was carried out.");

  const executor = EXECUTORS[approval.action_kind];
  if (!executor) return fail("no_executor", noExecutorMessage(approval.action_kind));

  return executor.run({ db, approval, payload, tenant, approver: args.approver ?? null, deps });
}

function fail(reason: string, message: string): ExecutorOutcome {
  return { ok: false, result: { outcome: "failed", reason, message, provider: null } };
}
