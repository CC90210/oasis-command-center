/**
 * /pipeline — OASIS lead pipeline.
 *
 * 2026-05-21 rewrite: this page now uses LeadsTableClient — the SAME
 * component Sun Biz's /leads page uses. Same horizontal pill-tab strip,
 * same search input, same sortable table, same row click → detail
 * drawer behaviour. The only OASIS-specific bits are:
 *
 *   - 11-stage list passed via the `stages` prop (lib/oasis-stage-meta)
 *     instead of SunBiz's 12-stage funding funnel.
 *   - detailBase="/pipeline" so row clicks land on /pipeline/[id]
 *     (OASIS lead detail) instead of /leads/[id] (SunBiz catch-all).
 *
 * Funnel chart at the top and the Recent Inbound / Recent Outbound
 * cards at the bottom stay — they're OASIS-only daily-ops surfaces.
 * Everything in the middle (stage tabs + table) is the literal Sun Biz
 * UI, so there's no second-implementation drift to maintain.
 */

import Link from "next/link";
import { Card, PageHeader, Tag, EmptyState } from "@/components/Card";
import { PipelineFunnel } from "@/components/charts/PipelineFunnel";
import { timeAgo, truncate } from "@/lib/fmt";
import {
  pipelineBreakdown,
  recentOutbound,
  recentInbound,
  getActiveProfile,
  getLeadsForTenant,
} from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { LeadsTableClient } from "@/components/leads/LeadsTableClient";
import { OASIS_LEAD_STAGE_TABS } from "@/lib/oasis-stage-meta";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const profile = await safe("pipeline.profile", getActiveProfile(), null);
  const tenantId = profile?.tenant_id || "";

  const [pipeline, outbound, inbound, leads] = await Promise.all([
    safe(
      "pipeline.breakdown",
      pipelineBreakdown(tenantId, true),
      { stages: {} as Record<string, number>, total: 0, sources: {} as Record<string, number> },
    ),
    safe("pipeline.recent_outbound", recentOutbound(tenantId, 20), []),
    safe("pipeline.recent_inbound", recentInbound(tenantId, 20), []),
    safe("pipeline.leads", tenantId ? getLeadsForTenant(tenantId, 500) : Promise.resolve([]), []),
  ]);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Pipeline"
        subtitle={`${pipeline.total} lead${pipeline.total === 1 ? "" : "s"} across the funnel`}
      />

      <section>
        <Card title="Funnel" subtitle="By stage">
          <PipelineFunnel stages={pipeline.stages} />
        </Card>
      </section>

      {tenantId ? (
        <LeadsTableClient
          initialLeads={leads}
          stages={OASIS_LEAD_STAGE_TABS}
          detailBase="/pipeline"
        />
      ) : (
        <Card>
          <EmptyState message="Sign in to see your pipeline." />
        </Card>
      )}

      <section className="grid lg:grid-cols-2 gap-6">
        <Card title="Recent outbound" subtitle={`${outbound.length} most recent`}>
          {outbound.length === 0 ? (
            <EmptyState message="No sends through gateway today." />
          ) : (
            <ul className="divide-y divide-bg-border">
              {outbound.map((o) => {
                const meta = (o.metadata || {}) as Record<string, unknown>;
                return (
                  <li key={o.id} className="py-1">
                    <Link
                      href={`/interactions/${o.id}`}
                      className="flex items-start gap-3 py-2 px-2 -mx-2 rounded-md hover:bg-bg-elev transition-colors"
                    >
                      <Tag tone="info">{o.channel}</Tag>
                      <div className="flex-1 min-w-0">
                        <div className="text-fg text-sm truncate">
                          {truncate(o.subject || "(no subject)", 70)}
                        </div>
                        <div className="text-xs text-fg-dim mt-0.5">
                          {(meta.brand as string) || "—"} · {o.agent_source || "—"} · {timeAgo(o.created_at)}
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Recent inbound" subtitle={`${inbound.length} most recent`}>
          {inbound.length === 0 ? (
            <EmptyState message="No inbound today. Wire n8n via Settings → Integrations." />
          ) : (
            <ul className="divide-y divide-bg-border">
              {inbound.map((i) => {
                const meta = (i.metadata || {}) as Record<string, unknown>;
                const cls = (meta.classification || {}) as Record<string, unknown>;
                const intent = (cls.intent as string) || "—";
                const summary = (cls.summary as string) || "";
                const tone =
                  intent === "hot_lead" || intent === "frustrated"
                    ? "hot"
                    : intent === "sales" || intent === "business_opportunity" || intent === "partnership" || intent === "booking"
                      ? "engaged"
                      : intent === "strategic" || intent === "pricing_question"
                        ? "accent"
                        : intent === "ambiguous" || intent === "security"
                          ? "warm"
                          : "neutral";
                return (
                  <li key={i.id} className="py-1">
                    <Link
                      href={`/interactions/${i.id}`}
                      className="flex items-start gap-3 py-2 px-2 -mx-2 rounded-md hover:bg-bg-elev transition-colors"
                    >
                      <Tag tone={tone}>{intent}</Tag>
                      <div className="flex-1 min-w-0">
                        <div className="text-fg text-sm truncate">{truncate(i.subject, 70)}</div>
                        <div className="text-xs text-fg-dim mt-0.5 truncate">
                          {summary
                            ? truncate(summary, 100)
                            : `${(meta.from_identity as string) || "—"} · ${timeAgo(i.created_at)}`}
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
