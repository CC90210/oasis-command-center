import { Card, EmptyState, Tag } from "@/components/Card";
import { timeAgo, truncate, statusColor } from "@/lib/fmt";
import type { AgentDecision } from "@/lib/supabase";

/**
 * "Agent decisions" tape — the autonomous loop's own choices, distinct from
 * the event stream (that's the Activity Tape).
 *
 * Extracted 2026-08-04. This block used to live only on /reasoning. When that
 * page left CC's operator nav the tape moved to /operations, but /reasoning
 * still serves SunBiz + Suga client tenants via SUN_NAV / SUGA_NAV — so both
 * surfaces need it and a copy-paste duplicate would have been two places to
 * fix the next time the shape changes.
 *
 * Presentational only. Every caller does its own tenant-scoped fetch through
 * recentDecisions(), which filters .eq(tenant_id).in(agent_name) and returns
 * [] rather than leaking when either is missing. Keep it that way: this
 * component must never query on its own behalf, or the scoping decision moves
 * out of the page that knows which tenant it is rendering for.
 */
export function AgentDecisionsCard({ decisions }: { decisions: AgentDecision[] }) {
  return (
    <Card
      title="Agent decisions"
      subtitle={
        decisions.length > 0
          ? `Each row is a choice your agent made on its own — last ${decisions.length} cycles. Confidence + outcome shown so you can see whether the autonomous loop is making good calls.`
          : "Once your agents start cycling autonomously, every decision they make (lead scoring, send vs. skip, prioritize vs. defer) shows up here with confidence + outcome."
      }
    >
      {decisions.length === 0 ? (
        // Brand-neutral on purpose — this renders for client tenants too, so
        // it must not name CC's empire agent.
        <EmptyState message="No decisions yet. The reasoning loop hasn't run today — start your local agent runner from your bridge terminal." />
      ) : (
        <ul className="space-y-3">
          {decisions.map((d) => (
            <li key={d.id} className="rounded-lg border border-bg-border bg-bg-elev p-4">
              <div className="flex justify-between items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Tag tone="accent">{d.decision_type}</Tag>
                    <span className="text-xs text-fg-dim font-mono">cycle {truncate(d.tick_id, 12)}</span>
                  </div>
                  <div className="text-fg font-medium text-sm">
                    {d.target_description || "(no target description)"}
                  </div>
                  {d.reasoning && (
                    <p className="text-sm text-fg-muted mt-2 leading-relaxed">{truncate(d.reasoning, 280)}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className={`text-sm font-bold ${statusColor(d.outcome_status)}`}>
                    {d.outcome_status || d.chosen_action || "—"}
                  </div>
                  {d.confidence != null && (
                    <div className="text-xs text-fg-dim mt-1 font-mono">
                      conf {Number(d.confidence).toFixed(2)}
                    </div>
                  )}
                  <div className="text-xs text-fg-dim mt-1">{timeAgo(d.created_at)}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
