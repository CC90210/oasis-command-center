/**
 * lib/os/customers/usage.ts — what a client does in their own OASIS workspace,
 * for OASIS's client record. This is how OASIS collects its clients' data.
 *
 * Read only when the record is LINKED to the client's workspace
 * (customers.client_tenant_id, set by the operator-only "Link workspace";
 * migration bravo__195). Every statement is pinned to that one tenant id, and
 * only OASIS's owners and admins reach it (the page gates it).
 *
 *   client_roi_snapshots  the nightly roll-up (app/api/cron/roi-snapshot):
 *                         messages handled, leads processed, AI actions, hours
 *                         saved. Summed over the window; "no snapshots" is
 *                         said as such, never as zeros.
 *   agent_turn_outcomes   one row per agent channel with its LAST turn
 *                         (bravo__191): channels used in the window, and how
 *                         many of those last turns failed.
 *   approvals             proposals raised in the window, and their state.
 *   support_tickets       tickets on the client's OWN desk opened in the window.
 */
import type { Client, ResultSet } from "@libsql/client";

type Row = Record<string, unknown>;

function rows(rs: ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, i) => {
      const v = (r as unknown as unknown[])[i];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o;
  });
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export const USAGE_WINDOW_DAYS = 30;

export type ClientUsage = {
  workspace: { id: string; name: string; slug: string | null } | null;
  windowDays: number;
  since: string;
  roi: {
    /** Days with a snapshot in the window; 0 = the nightly roll-up has not run for them. */
    snapshotDays: number;
    messagesHandled: number;
    leadsProcessed: number;
    aiActionsTaken: number;
    hoursSaved: number;
    lastSnapshot: string | null;
  };
  agents: { channelsUsed: number; lastTurnFailed: number; lastTurnAt: string | null };
  approvals: { raised: number; pending: number; executed: number; failed: number };
  tickets: { opened: number; stillOpen: number };
};

/** ISO date `days` before `now` (UTC), and the same as a full timestamp. */
function windowStart(now: Date, days: number): { date: string; iso: string } {
  const d = new Date(now.getTime() - days * 86_400_000);
  return { date: d.toISOString().slice(0, 10), iso: d.toISOString() };
}

export async function loadClientUsage(db: Client, clientTenantId: string, now: Date, days = USAGE_WINDOW_DAYS): Promise<ClientUsage> {
  if (typeof clientTenantId !== "string" || !clientTenantId.trim()) throw new Error("customers.usage: a client workspace id is required");
  const since = windowStart(now, days);
  const [tenant, roi, agents, approvals, tickets] = await Promise.all([
    db.execute({ sql: "SELECT id, name, slug FROM tenants WHERE id = ? LIMIT 1", args: [clientTenantId] }),
    db.execute({
      sql: `SELECT COUNT(*) AS days, COALESCE(SUM(messages_handled), 0) AS messages, COALESCE(SUM(leads_processed), 0) AS leads,
                   COALESCE(SUM(ai_actions_taken), 0) AS actions, COALESCE(SUM(hours_saved_est), 0) AS hours,
                   MAX(snapshot_date) AS last_day
            FROM client_roi_snapshots WHERE tenant_id = ? AND snapshot_date >= ?`,
      args: [clientTenantId, since.date],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS used, COALESCE(SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END), 0) AS failed, MAX(at) AS last_at
            FROM agent_turn_outcomes WHERE tenant_id = ? AND at >= ?`,
      args: [clientTenantId, since.iso],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS raised,
                   COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                   COALESCE(SUM(CASE WHEN status = 'executed' THEN 1 ELSE 0 END), 0) AS executed,
                   COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
            FROM approvals WHERE tenant_id = ? AND created_at >= ?`,
      args: [clientTenantId, since.iso],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS opened,
                   COALESCE(SUM(CASE WHEN status IN ('open', 'in_progress', 'waiting_on_client') THEN 1 ELSE 0 END), 0) AS still_open
            FROM support_tickets WHERE tenant_id = ? AND created_at >= ?`,
      args: [clientTenantId, since.iso],
    }),
  ]);
  const t = rows(tenant)[0];
  const r = rows(roi)[0] ?? {};
  const a = rows(agents)[0] ?? {};
  const p = rows(approvals)[0] ?? {};
  const k = rows(tickets)[0] ?? {};
  return {
    workspace: t ? { id: String(t.id), name: String(t.name ?? ""), slug: t.slug ? String(t.slug) : null } : null,
    windowDays: days,
    since: since.date,
    roi: {
      snapshotDays: n(r.days),
      messagesHandled: n(r.messages),
      leadsProcessed: n(r.leads),
      aiActionsTaken: n(r.actions),
      hoursSaved: Math.round(n(r.hours) * 10) / 10,
      lastSnapshot: r.last_day ? String(r.last_day) : null,
    },
    agents: { channelsUsed: n(a.used), lastTurnFailed: n(a.failed), lastTurnAt: a.last_at ? String(a.last_at) : null },
    approvals: { raised: n(p.raised), pending: n(p.pending), executed: n(p.executed), failed: n(p.failed) },
    tickets: { opened: n(k.opened), stillOpen: n(k.still_open) },
  };
}
