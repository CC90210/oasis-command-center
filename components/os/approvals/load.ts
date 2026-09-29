/**
 * components/os/approvals/load.ts — the Needs-you reads the pages make.
 *
 * Today, the Feed and each department's Overview panel render the same
 * approval cards. Each page resolves its viewer first (its own gate), builds
 * the scope with lib/os/approvals/scope.ts from the rail's inputs, and calls
 * ONE of these. Every loader returns a Read<T>: the value, or `{ ok: false }`
 * with the cause logged — a failed read is "Couldn't load approvals", never an
 * empty "nothing needs you".
 */
import "server-only";

import { getTursoClient, tursoConfigured } from "@/lib/turso";
import type { DepartmentKey } from "@/lib/os/types";
import { scopeSeesNothing, type ApprovalScope, type ApprovalsBlock, type ApprovalView } from "@/lib/os/approvals/rules";
import { countPendingApprovals, listApprovals } from "@/lib/os/approvals/store";
import { buildApprovalViews } from "@/lib/os/approvals/view";

export type ApprovalsRead<T> = { ok: true; value: T } | { ok: false };

/** Waiting approvals (up to `limit`) and how many wait in total, for one viewer. */
export async function loadPendingApprovals(args: {
  scope: ApprovalScope;
  tenantSlug: string | null;
  department?: DepartmentKey | null;
  limit: number;
}): Promise<ApprovalsRead<ApprovalsBlock>> {
  // A viewer with no department seats has nothing to fetch: an empty block is
  // the true answer, and no query runs.
  if (scopeSeesNothing(args.scope)) return { ok: true, value: { items: [], total: 0 } };
  if (!tursoConfigured()) {
    console.error("[approvals.load] Turso is not configured; approvals cannot be read");
    return { ok: false };
  }
  try {
    const db = getTursoClient();
    const now = new Date();
    const [listed, counts] = await Promise.all([
      listApprovals(db, args.scope, { view: "pending", department: args.department ?? null, limit: args.limit }, now),
      countPendingApprovals(db, args.scope, now),
    ]);
    const items = await buildApprovalViews(db, args.scope, listed.rows, { tenantSlug: args.tenantSlug, now });
    const total = args.department ? counts.byDepartment[args.department] ?? 0 : counts.total;
    return { ok: true, value: { items, total: Math.max(total, items.length) } };
  } catch (err) {
    console.error("[approvals.load.pending]", err);
    return { ok: false };
  }
}

/** The last week of decisions and their real outcomes (the Feed's "Recently decided"). */
export async function loadRecentDecisions(args: {
  scope: ApprovalScope;
  tenantSlug: string | null;
  department?: DepartmentKey | null;
  limit: number;
}): Promise<ApprovalsRead<{ items: ApprovalView[]; truncated: boolean }>> {
  if (scopeSeesNothing(args.scope)) return { ok: true, value: { items: [], truncated: false } };
  if (!tursoConfigured()) {
    console.error("[approvals.load] Turso is not configured; approvals cannot be read");
    return { ok: false };
  }
  try {
    const db = getTursoClient();
    const now = new Date();
    const listed = await listApprovals(db, args.scope, { view: "decided", department: args.department ?? null, limit: args.limit }, now);
    const items = await buildApprovalViews(db, args.scope, listed.rows, { tenantSlug: args.tenantSlug, now });
    return { ok: true, value: { items, truncated: listed.truncated } };
  } catch (err) {
    console.error("[approvals.load.decided]", err);
    return { ok: false };
  }
}
