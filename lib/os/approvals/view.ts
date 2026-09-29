/**
 * lib/os/approvals/view.ts — approval rows, shaped the way every surface
 * renders them (ApprovalView in rules.ts), for ONE viewer.
 *
 * The same object renders on Today, in the Feed, in a department's Overview
 * panel and in the API response, so what a card says is decided here once:
 *   - can_decide comes from the viewer's scope (rules.mayDecideApproval);
 *   - executable / readiness_note come from the executor registry, so a card
 *     says BEFORE anyone approves when this workspace cannot carry the action
 *     out;
 *   - a pending row past its expiry is shown as expired, never as waiting.
 */
import "server-only";
import type { Client } from "@libsql/client";
import {
  ACTION_KIND_LABELS,
  departmentLabel,
  isExpired,
  mayDecideApproval,
  type ApprovalScope,
  type ApprovalView,
} from "@/lib/os/approvals/rules";
import { getApproval, listApprovalComments, parsePayload, type ApprovalRow } from "@/lib/os/approvals/store";
import { defaultExecutorDeps, executorReadiness, type ExecutorDeps } from "@/lib/os/approvals/executors";

export async function buildApprovalViews(
  db: Client,
  scope: ApprovalScope,
  approvals: readonly ApprovalRow[],
  opts: { tenantSlug: string | null; now: Date; deps?: ExecutorDeps },
): Promise<ApprovalView[]> {
  if (approvals.length === 0) return [];
  const deps = opts.deps ?? defaultExecutorDeps();
  const comments = await listApprovalComments(db, scope, approvals.map((a) => a.id));
  const nowIso = opts.now.toISOString();
  const tenant = { id: scope.tenantId, slug: opts.tenantSlug };
  return approvals.map((a) => {
    const expired = a.status === "pending" && isExpired(a.expires_at, nowIso);
    const status = expired ? "expired" : a.status;
    const readiness = executorReadiness(a.action_kind, tenant, deps);
    return {
      id: a.id,
      department_key: a.department_key,
      department_label: departmentLabel(a.department_key),
      action_kind: a.action_kind,
      action_label: ACTION_KIND_LABELS[a.action_kind] ?? a.action_kind,
      title: a.title,
      preview_text: a.preview_text,
      payload: parsePayload(a),
      payload_hash: a.payload_hash,
      revision: a.revision,
      supersedes_id: a.supersedes_id,
      requested_by_type: a.requested_by_type,
      requested_by_id: a.requested_by_id,
      status,
      created_at: a.created_at,
      updated_at: a.updated_at,
      expires_at: a.expires_at,
      decided_at: a.decided_at,
      decided_by_name: a.decided_by_name,
      decision_note: a.decision_note,
      executing_at: a.executing_at,
      executed_at: a.executed_at,
      execution_result: a.execution_result,
      comments: comments.get(a.id) ?? [],
      can_decide: status === "pending" && mayDecideApproval(scope, a.department_key),
      can_comment: mayDecideApproval(scope, a.department_key),
      can_resume: status === "approved" && mayDecideApproval(scope, a.department_key),
      executable: readiness.executable,
      readiness_note: readiness.note,
    };
  });
}

/** One approval as this viewer sees it now, or null when it is not theirs to see. */
export async function viewApproval(
  db: Client,
  scope: ApprovalScope,
  id: string,
  opts: { tenantSlug: string | null; now: Date; deps?: ExecutorDeps },
): Promise<ApprovalView | null> {
  const row = await getApproval(db, scope, id);
  if (!row) return null;
  const [view] = await buildApprovalViews(db, scope, [row], opts);
  return view ?? null;
}
