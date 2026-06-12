/**
 * OperationsTrackerPanel — Settings-bottom surface for system + team activity.
 *
 * CC ask (2026-06-11): "an overall tracker [in Settings], which should
 * include more about automations, sequences, daemons, PM2 processes,
 * and team practices. It should track every time an employee sends an
 * email, does a deal, or does anything." Single panel that surfaces:
 *
 *   1. Per-employee 7-day activity rollup (sends, threads, deals
 *      touched) — answers "what is Jordan/Alex/Ezra actually doing"
 *   2. Last 15 audit events with deep-link to the full /settings/
 *      audit-log page for everything older
 *   3. Quick links to /automations (daemons + crons) and
 *      /sequences (drips)
 *
 * Read-only by design — every mutation lives on the surfaces it
 * tracks (Automations, Sequences, the drawer's send buttons, etc.).
 * This is the "what happened" view, not the "do something" view.
 */

import Link from "next/link";
import { Card } from "@/components/Card";
import { getServiceSupabase } from "@/lib/supabase-server";
import { timeAgo } from "@/lib/fmt";
import { ArrowRight, Workflow, Bot, Mail, MessageSquare, Send, FileText } from "lucide-react";

type AuditRow = {
  id: string;
  actor_email: string | null;
  actor_user_id: string | null;
  action_type: string | null;
  target_table: string | null;
  target_id: string | null;
  created_at: string;
};

type InteractionRow = {
  channel: string | null;
  metadata: { requested_by_email?: string } | null;
};

type EmployeeRollup = {
  email: string;
  email_sends: number;
  sms_sends: number;
  recent_actions: number;
};

function iconForAction(actionType: string | null) {
  const t = (actionType || "").toLowerCase();
  if (t.includes("email") || t.includes("send")) return <Mail className="w-3 h-3" />;
  if (t.includes("sms") || t.includes("message")) return <MessageSquare className="w-3 h-3" />;
  if (t.includes("shop") || t.includes("lender")) return <Send className="w-3 h-3" />;
  if (t.includes("application") || t.includes("underwrite")) return <FileText className="w-3 h-3" />;
  return <Workflow className="w-3 h-3" />;
}

async function loadAuditEvents(tenantId: string): Promise<AuditRow[]> {
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("tenant_audit_log")
      .select("id, actor_email, actor_user_id, action_type, target_table, target_id, created_at")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(15);
    if (r.error) return [];
    return (r.data || []) as AuditRow[];
  } catch {
    return [];
  }
}

async function loadEmployeeRollup(tenantId: string): Promise<EmployeeRollup[]> {
  try {
    const db = getServiceSupabase();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // lead_interactions is the per-send audit trail. agent_source =
    // 'manual_cc' / 'dashboard_drawer' indicates operator-initiated
    // (vs daemon-driven cold outreach which we don't want to attribute
    // to a specific employee). metadata.acted_by_user_id + the
    // user_profiles email join gives us the actor.
    const r = await db
      .from("lead_interactions")
      .select("channel, metadata")
      .eq("tenant_id", tenantId)
      .gte("created_at", since)
      .in("agent_source", ["manual_cc", "dashboard_drawer", "shop_out_send_batch"])
      .limit(500);
    if (r.error) return [];

    const byEmail = new Map<string, EmployeeRollup>();
    for (const row of (r.data || []) as InteractionRow[]) {
      const email = row.metadata?.requested_by_email || "(unknown)";
      const existing = byEmail.get(email) || {
        email,
        email_sends: 0,
        sms_sends: 0,
        recent_actions: 0,
      };
      existing.recent_actions += 1;
      if (row.channel === "email") existing.email_sends += 1;
      if (row.channel === "sms") existing.sms_sends += 1;
      byEmail.set(email, existing);
    }
    return Array.from(byEmail.values()).sort((a, b) => b.recent_actions - a.recent_actions);
  } catch {
    return [];
  }
}

export async function OperationsTrackerPanel({ tenantId }: { tenantId: string | null }) {
  if (!tenantId) {
    return (
      <Card title="Operations tracker" subtitle="Sign in as the tenant operator to load activity.">
        <div className="text-xs text-fg-dim italic">No tenant context.</div>
      </Card>
    );
  }

  const [auditEvents, rollup] = await Promise.all([
    loadAuditEvents(tenantId),
    loadEmployeeRollup(tenantId),
  ]);

  return (
    <Card
      title="Operations tracker"
      subtitle="Live system + team activity — what your daemons fired and what your team did. Read-only."
    >
      <div className="space-y-5">
        {/* Quick nav to deeper surfaces */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Link
            href="/automations"
            className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-deep/40 hover:bg-bg-elev/60 transition-colors px-3 py-2.5"
          >
            <Bot className="w-4 h-4 text-accent" />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-fg">Automations</div>
              <div className="text-[10px] text-fg-dim">PM2 daemons, crons</div>
            </div>
          </Link>
          <Link
            href="/sequences"
            className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-deep/40 hover:bg-bg-elev/60 transition-colors px-3 py-2.5"
          >
            <Workflow className="w-4 h-4 text-accent" />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-fg">Sequences</div>
              <div className="text-[10px] text-fg-dim">Drip cadences</div>
            </div>
          </Link>
          <Link
            href="/settings/audit-log"
            className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-deep/40 hover:bg-bg-elev/60 transition-colors px-3 py-2.5"
          >
            <FileText className="w-4 h-4 text-accent" />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold text-fg">Full audit log</div>
              <div className="text-[10px] text-fg-dim">Every change</div>
            </div>
          </Link>
        </div>

        {/* Team rollup */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold mb-1.5">
            Team activity — last 7 days
          </div>
          {rollup.length === 0 ? (
            <div className="rounded-md border border-bg-border bg-bg-deep/30 px-3 py-2.5 text-[11.5px] text-fg-dim italic">
              No operator-initiated sends in the last 7 days. Either no one's been
              active or all sends came from daemons (cold outreach, drip runner).
            </div>
          ) : (
            <div className="rounded-md border border-bg-border divide-y divide-bg-border">
              {rollup.slice(0, 8).map((row) => (
                <div
                  key={row.email}
                  className="px-3 py-2 flex items-center gap-3 text-[12px]"
                >
                  <div className="flex-1 font-semibold text-fg truncate">{row.email}</div>
                  <div className="flex items-center gap-3 text-[11px] text-fg-muted shrink-0">
                    <span className="inline-flex items-center gap-1">
                      <Mail className="w-3 h-3" />
                      {row.email_sends}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" />
                      {row.sms_sends}
                    </span>
                    <span className="font-mono text-[10.5px] text-fg-dim">
                      {row.recent_actions} total
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Audit event stream */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
              Recent system events
            </div>
            <Link
              href="/settings/audit-log"
              className="text-[10px] text-fg-dim hover:text-fg inline-flex items-center gap-1"
            >
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {auditEvents.length === 0 ? (
            <div className="rounded-md border border-bg-border bg-bg-deep/30 px-3 py-2.5 text-[11.5px] text-fg-dim italic">
              No audit events yet. They'll appear here as your team and your
              agents take actions.
            </div>
          ) : (
            <ul className="space-y-1">
              {auditEvents.map((row) => (
                <li
                  key={row.id}
                  className="rounded-md border border-bg-border bg-bg-deep/30 px-3 py-1.5 flex items-center gap-2 text-[11.5px]"
                >
                  <div className="text-fg-dim">{iconForAction(row.action_type)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-fg truncate">
                      <span className="font-semibold">{row.actor_email || "system"}</span>
                      <span className="text-fg-muted"> · {row.action_type || "(unknown)"}</span>
                      {row.target_table && (
                        <span className="text-fg-dim"> on {row.target_table}</span>
                      )}
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-fg-dim shrink-0">
                    {timeAgo(row.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}
