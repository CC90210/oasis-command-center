/**
 * lib/os/desk/proposals.ts - a department teammate's email drafts, owned by the
 * PERSON whose chat proposed them.
 *
 * WHY (Codex adversarial review of PR #564). The generic propose_email
 * (lib/cloud-tool-runner.ts toolProposeEmail) files a card under the agent
 * (`requested_by_id` = the agent's slug) and lets that agent revise "its own"
 * card. Every Sales seat shares one agent, so one rep's chat could revise, and
 * so withdraw, another rep's pending draft; and a read-only member could file
 * one at all. Department drafts therefore:
 *   - need a member who may act (capabilities.canAct), checked here at
 *     execution, not only by the palette that offers the tool;
 *   - carry the proposing person's id in their idempotency key
 *     (`desk:<user>:...`, the column every approval already stores; the same
 *     move lib/os/approvals/executors.ts makes for support drafts), so no
 *     migration is needed and the owner is known for every revision;
 *   - may be revised only by that person, or by an owner or admin of the
 *     workspace (persona "founder"), and only while they are an agent's card.
 * A member's approvals_list and summary list only their own drafts; owners and
 * admins see what the Needs-you page shows them.
 */

import "server-only";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { loadPendingApprovals } from "@/components/os/approvals/load";
import { approvalScopeFromViewer } from "@/lib/os/approvals/scope";
import { canonicalJson, departmentLabel, validateSendEmailPayload } from "@/lib/os/approvals/rules";
import { createApproval, getApprovalInTenant, payloadHashOf } from "@/lib/os/approvals/store";
import type { OsDepartment } from "@/lib/os/departments";
import type { DepartmentKey } from "@/lib/os/types";
import type { OsViewer } from "@/components/os/department/viewer";

export const DESK_KEY_PREFIX = "desk";

/** The person a chat acts for: the session's auth user, lowercased. */
export function deskActor(viewer: OsViewer): string {
  return String(viewer.authUserId ?? viewer.surface.userId ?? "").trim().toLowerCase();
}

export function mayProposeFrom(viewer: OsViewer): boolean {
  return viewer.surface.capabilities.canAct === true && deskActor(viewer) !== "";
}

/** Owners and admins may revise any agent draft in their workspace. */
export function mayReviseAnyDraft(viewer: OsViewer): boolean {
  return viewer.surface.persona === "founder";
}

/** desk:<user>:<agent>:<day>:<revises|new>:<hash32>, under the 200-char cap (rules.ts). */
export function deskProposalKey(user: string, agentSlug: string, day: string, revises: string | null, hash: string): string {
  return [DESK_KEY_PREFIX, user, agentSlug.slice(0, 32), day, (revises ?? "new").slice(0, 48), hash.slice(0, 32)].join(":");
}

/** The person who proposed a desk draft, or null for any other card. */
export function deskProposalOwner(idempotencyKey: string | null | undefined): string | null {
  const parts = String(idempotencyKey ?? "").split(":");
  return parts[0] === DESK_KEY_PREFIX && parts[1] ? parts[1] : null;
}

export class ProposalRefused extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ProposalRefused";
  }
}

export async function proposeDeskEmail(
  viewer: OsViewer,
  dept: OsDepartment,
  agentSlug: string,
  input: Record<string, unknown>,
  now: Date,
): Promise<Record<string, unknown>> {
  // The second lock (./tools.ts refuses first): any caller of this function.
  if (!mayProposeFrom(viewer)) throw new ProposalRefused("proposer_may_not_act");
  if (!tursoConfigured()) throw new Error("approvals_unavailable");
  const payload = validateSendEmailPayload({ to: input.to, cc: input.cc, subject: input.subject, body: input.body, lead_id: input.lead_id });
  if (!payload.ok) throw new ProposalRefused(payload.error);
  const tenantId = viewer.surface.tenantId;
  const me = deskActor(viewer);
  const db = getTursoClient();
  const revises = typeof input.revises_approval_id === "string" && input.revises_approval_id.trim() ? input.revises_approval_id.trim() : null;
  if (revises) {
    const old = await getApprovalInTenant(db, tenantId, revises);
    if (!old || old.requested_by_type !== "agent") throw new ProposalRefused("supersedes_not_found");
    if (deskProposalOwner(old.idempotency_key) !== me && !mayReviseAnyDraft(viewer)) {
      throw new ProposalRefused("supersedes_not_yours: only the person who proposed a draft can revise it");
    }
  }
  const hash = payloadHashOf(canonicalJson(payload.value));
  const r = await createApproval(
    db,
    {
      tenantId,
      departmentKey: dept.key,
      requestedBy: { type: "agent", id: agentSlug || null },
      actionKind: "send_email",
      title: `Email to ${payload.value.to}: ${payload.value.subject}`.slice(0, 200),
      targetRef: payload.value.lead_id ? `lead:${payload.value.lead_id}` : null,
      payload: payload.value,
      idempotencyKey: deskProposalKey(me, agentSlug, now.toISOString().slice(0, 10), revises, hash),
      supersedesId: revises,
    },
    now,
  );
  if (!r.ok) throw new ProposalRefused(r.error + (r.status ? `: approval is ${r.status}` : ""));
  const a = r.approval;
  return {
    ok: true,
    sent: false,
    status: a.status,
    approval_id: a.id,
    revision: a.revision,
    department: a.department_key,
    note: a.status === "pending" ? "Waiting for a person's approval in Needs you. Nothing has been sent." : `This exact email was already proposed today and is now ${a.status.replace("_", " ")}.`,
  };
}

export type DeskApprovalLine = { id: string; title: string; department: string | null; status: string; created_at: string };

/**
 * The approval cards a department chat may tell this person about: an owner or
 * admin, what Needs you shows them (lib/os/approvals/scope.ts); anyone else,
 * only the drafts they proposed themselves, waiting or sent back.
 */
export async function deskApprovals(
  viewer: OsViewer,
  department: DepartmentKey | null,
  limit: number,
): Promise<{ total: number; own: boolean; items: DeskApprovalLine[] }> {
  if (mayReviseAnyDraft(viewer)) {
    const r = await loadPendingApprovals({
      scope: approvalScopeFromViewer({ surface: viewer.surface, navInput: viewer.navInput }),
      tenantSlug: viewer.surface.tenantSlug,
      department,
      limit,
    });
    if (!r.ok) throw new Error("approvals_could_not_be_read");
    return {
      total: r.value.total,
      own: false,
      items: r.value.items.map((a) => ({ id: a.id, title: a.title, department: a.department_label, status: a.status, created_at: a.created_at })),
    };
  }
  const me = deskActor(viewer);
  if (!me || !tursoConfigured()) {
    if (!me) return { total: 0, own: true, items: [] };
    throw new Error("approvals_could_not_be_read");
  }
  const like = `${DESK_KEY_PREFIX}:${me.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`;
  const rs = await getTursoClient().execute({
    sql: `SELECT id, title, department_key, status, created_at FROM approvals
          WHERE tenant_id = ? AND idempotency_key LIKE ? ESCAPE '\\' AND status IN ('pending', 'sent_back')
          ${department ? "AND department_key = ?" : ""}
          ORDER BY created_at DESC LIMIT ?`,
    args: [viewer.surface.tenantId, like, ...(department ? [department] : []), limit],
  });
  const items = rs.rows.map((r) => ({
    id: String(r.id),
    title: String(r.title ?? ""),
    department: departmentLabel(r.department_key as DepartmentKey | null),
    status: String(r.status ?? ""),
    created_at: String(r.created_at ?? ""),
  }));
  return { total: items.length, own: true, items };
}
