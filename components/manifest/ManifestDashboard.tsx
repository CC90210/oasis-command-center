import Link from "next/link";
import { Bot, Flame, AlertTriangle, BadgeCheck, RefreshCw, ArrowRight, Sparkles, MessageSquare } from "lucide-react";
import { Card } from "@/components/Card";
import { listRecords, listByAssignedScope, type TenantRecord } from "@/lib/manifest/data";
import { SCOPED_ENTITIES } from "@/lib/lead-scope";
import type { TenantManifest } from "@/lib/manifest/schema";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getRenewalsSummary } from "@/lib/queries";
import { LEAD_PIPELINE_STAGES, OPPORTUNITY_PIPELINE_STAGES, type StageMeta } from "@/lib/sunbiz-stage-meta";
import { pipelineRowHref } from "@/lib/pipeline-display";
import { formatMoney, timeAgo } from "@/lib/fmt";

type AgentAlertRow = {
  id: string;
  alert_type: string;
  severity: "info" | "warn" | "urgent";
  subject_type: string | null;
  subject_id: string | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

type Props = {
  manifest: TenantManifest;
  tenantId: string | null;
  demoRowsByEntity?: Record<string, TenantRecord[]>;
  /** Per-agent lead scope (Adon Batch 2): undefined=all, string=assigned_to,
   *  null=unassigned. Applied to lead + application reads so the dashboard
   *  KPIs / "Today's focus" reflect only the viewer's own leads. */
  assignedScope?: string | null | undefined;
};

/**
 * ManifestDashboard — the operator's "what needs my attention" landing.
 *
 * Redesigned 2026-05-17 from a bland count-tile grid into a real
 * work-oriented surface. Five sections, top to bottom:
 *
 *   1. Open alerts row (red/amber chips) — missing-info, urgent items
 *      raised by AI classifiers.
 *   2. KPI hero row (4 colored cards) — Hot Leads, Missing Info,
 *      Funded This Month, Renewals Due. Each clickable straight to
 *      the filtered pipeline view.
 *   3. Pipeline-at-a-glance — Lead Pipeline + Opportunity Pipeline
 *      shown as stacked bars with verbatim Salesforce stage colors.
 *      Hover/tap a segment to jump to that stage filter.
 *   4. Today's focus — top 5 urgent leads + top 3 renewals due,
 *      side-by-side, each row clickable to the lead/deal detail.
 *   5. Agents — Solara / Helios cards with "Chat" CTAs.
 *
 * Tenants without the SunBiz entity model fall back to a generic
 * entity-count grid so OASIS HQ + SUGA still render sensibly.
 */
export async function ManifestDashboard({ manifest, tenantId, demoRowsByEntity, assignedScope }: Props) {
  const entities = manifest.data_model || [];
  const enabledAgents = manifest.agents.filter((a) => a.enabled);
  const isSunBizShape =
    entities.some((e) => e.name === "lead") &&
    entities.some((e) => e.name === "application");

  if (entities.length === 0) {
    return (
      <Card title="Dashboard">
        <div className="text-sm text-fg-muted leading-relaxed">
          This workspace has no data model yet. Open the AI editor and ask:{" "}
          <em>&quot;Add a lead entity with name, phone, and stage fields.&quot;</em>
        </div>
      </Card>
    );
  }

  // Fetch every entity's rows once. listRecords is async + parallel.
  const allRows = await Promise.all(
    entities.map(async (entity) => {
      if (!tenantId) {
        const demo = demoRowsByEntity?.[entity.name] || [];
        return { entity, rows: demo, total: demo.length };
      }
      // lead / application / funded_deal are per-agent scoped (owner OR
      // collaborator via listByAssignedScope); other entities are tenant-shared.
      const r = await (SCOPED_ENTITIES.has(entity.name)
        ? listByAssignedScope({ tenant_id: tenantId, entity: entity.name, scope: assignedScope, limit: 500 })
        : listRecords({ tenant_id: tenantId, entity: entity.name, limit: 500 })
      ).catch(() => ({ rows: [], total: 0 }));
      return { entity, rows: r.rows, total: r.total };
    }),
  );
  const rowsByEntity: Record<string, TenantRecord[]> = {};
  for (const { entity, rows } of allRows) rowsByEntity[entity.name] = rows;

  const openAlerts: AgentAlertRow[] = await (async () => {
    if (!tenantId) return [];
    try {
      const sb = getServiceSupabase();
      const { data, error } = await sb
        .from("agent_alerts")
        .select("id, alert_type, severity, subject_type, subject_id, title, body, payload, created_at")
        .eq("tenant_id", tenantId)
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return [];
      // Dedupe by alert_type — health_check runs hourly and creates a
      // new row every 6h even when the underlying issue is unchanged.
      // Showing 10 stale "Health check: N HIGH" rows is noise; keep
      // only the most-recent of each type. Operator clears via the
      // dismiss button which sets resolved_at.
      const seen = new Set<string>();
      const deduped: AgentAlertRow[] = [];
      for (const row of (data || []) as AgentAlertRow[]) {
        const dedupeKey = `${row.alert_type}:${row.subject_type || ""}:${row.subject_id || ""}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        deduped.push(row);
        if (deduped.length >= 10) break;
      }
      return deduped;
    } catch {
      return [];
    }
  })();

  const slug = manifest.tenant_slug;

  return (
    <div className="space-y-6">
      {isSunBizShape ? (
        <>
          <SunBizHeroKpis
            slug={slug}
            leads={rowsByEntity.lead || []}
            applications={rowsByEntity.application || []}
            fundedDeals={rowsByEntity.funded_deal || []}
          />
          {/* Phase 10 — second action band: renewal alerts, offers needing
              review, shopping-out activity. Server-rendered separately so
              its three table queries don't block the hero kpis above it. */}
          <SunBizActionBand slug={slug} tenantId={tenantId} />
        </>
      ) : (
        <GenericKpis allRows={allRows} />
      )}

      {isSunBizShape && (
        <div className="grid gap-4 lg:grid-cols-2">
          <PipelineGlanceCard
            title="Lead Pipeline"
            href={`/t/${slug}/leads`}
            stages={LEAD_PIPELINE_STAGES}
            rows={rowsByEntity.lead || []}
            stageField="stage"
          />
          <PipelineGlanceCard
            title="Opportunity Pipeline"
            href={`/t/${slug}/applications`}
            stages={OPPORTUNITY_PIPELINE_STAGES}
            rows={rowsByEntity.application || []}
            stageField="status"
          />
        </div>
      )}

      {isSunBizShape && (
        <ActiveDeals slug={slug} applications={rowsByEntity.application || []} />
      )}

      {isSunBizShape && (
        <div className="grid gap-4 lg:grid-cols-2">
          <TopUrgentLeads slug={slug} leads={rowsByEntity.lead || []} />
          <RenewalsDueSoon slug={slug} fundedDeals={rowsByEntity.funded_deal || []} />
        </div>
      )}

      {openAlerts.length > 0 && <OpenAlertsRow alerts={openAlerts} slug={slug} />}

      {enabledAgents.length > 0 && (
        <Card
          title="Your agents"
          subtitle={
            enabledAgents.length === 1
              ? "One agent on this workspace."
              : `${enabledAgents.length} agents on this workspace — switch between them in chat.`
          }
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {enabledAgents.map((agent) => (
              <li
                key={agent.slug}
                className="group flex items-center justify-between rounded-lg border border-bg-border bg-bg-elev/40 hover:bg-bg-elev/70 transition-colors px-3 py-2.5"
              >
                <div className="flex items-center gap-2.5">
                  <div className="rounded-md bg-accent/15 border border-accent/30 p-1.5">
                    <Bot className="h-4 w-4 text-accent" aria-hidden />
                  </div>
                  <div>
                    <div className="font-semibold text-sm text-fg">{agent.display_name}</div>
                    <div className="text-[10px] uppercase tracking-wider text-fg-dim">
                      {agent.primary ? "primary agent" : "sub-agent"}
                    </div>
                  </div>
                </div>
                <Link
                  href={`/agent?agent=${encodeURIComponent(agent.slug)}`}
                  className="inline-flex items-center gap-1 text-xs font-bold text-accent hover:text-accent/80 opacity-80 group-hover:opacity-100 transition-opacity"
                >
                  <MessageSquare className="w-3 h-3" />
                  Chat
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- *
 * Open alerts row
 * ----------------------------------------------------------------- */

function OpenAlertsRow({ alerts, slug }: { alerts: AgentAlertRow[]; slug: string }) {
  const subtitleText =
    alerts.length === 1
      ? "What needs your attention today."
      : `${alerts.length} distinct issues across your tenant. Dismiss the ones you've handled.`;
  return (
    <Card title="System health" subtitle={subtitleText}>
      <ul className="space-y-2">
        {alerts.map((alert) => (
          <AlertRow key={alert.id} alert={alert} slug={slug} />
        ))}
      </ul>
    </Card>
  );
}

function AlertRow({ alert, slug }: { alert: AgentAlertRow; slug: string }) {
  const palette =
    alert.severity === "urgent"
      ? "border-red-500/50 bg-red-500/10 text-red-100"
      : alert.severity === "warn"
        ? "border-amber-400/50 bg-amber-400/10 text-amber-100"
        : "border-bg-border bg-bg-elev/40 text-fg-muted";

  // Three subject types we route deep into. Tenant-scoped (system
  // health check, cross-tenant audit) has no per-record drill-in,
  // so the row stays inline — no misleading "Click in to resolve".
  const href =
    alert.subject_type === "lead" && alert.subject_id
      ? `/t/${slug}/leads/${alert.subject_id}`
      : alert.subject_type === "application" && alert.subject_id
        ? `/t/${slug}/applications/${alert.subject_id}`
        : null;

  // Surface the actual issues from the payload jsonb so the operator
  // sees WHAT is wrong, not just "Health check: N HIGH issue(s)".
  // sunbiz_health_check.py writes payload.summary + payload.issues[].
  const summary = alert.payload && typeof alert.payload.summary === "string" ? alert.payload.summary : null;
  const issues = alert.payload && Array.isArray(alert.payload.issues) ? alert.payload.issues : [];
  const highIssues = issues
    .filter((i): i is { message: string; severity: string } =>
      typeof i === "object" && i !== null && "severity" in i && (i as { severity: unknown }).severity === "HIGH",
    )
    .slice(0, 5);

  return (
    <li>
      <div className={`rounded-lg border px-3 py-2.5 text-[12.5px] ${palette}`}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-semibold inline-flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            {alert.title}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10.5px] font-mono opacity-70">{timeAgo(alert.created_at)}</span>
            <DismissAlertButton alertId={alert.id} />
          </div>
        </div>
        {alert.body && (
          <div className="mt-1 text-[11.5px] opacity-90 break-words leading-relaxed">{alert.body}</div>
        )}
        {summary && (
          <div className="mt-1 text-[11.5px] opacity-80 break-words leading-relaxed">{summary}</div>
        )}
        {highIssues.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-[11px] opacity-90 list-disc list-inside">
            {highIssues.map((i, idx) => (
              <li key={idx}>{i.message}</li>
            ))}
          </ul>
        )}
        {href && (
          <Link
            href={href}
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] underline-offset-2 hover:underline opacity-90"
          >
            Open <ArrowRight className="w-3 h-3" />
          </Link>
        )}
      </div>
    </li>
  );
}

function DismissAlertButton({ alertId }: { alertId: string }) {
  // Client-side dismiss. Hides the row immediately, fires POST to
  // /api/agent-alerts/[id]/resolve which sets resolved_at. Page
  // reload picks up the persisted state.
  return (
    <form action={`/api/agent-alerts/${alertId}/resolve`} method="POST" className="inline">
      <button
        type="submit"
        className="text-[10px] uppercase tracking-wider font-semibold opacity-60 hover:opacity-100 px-1.5 py-0.5 rounded border border-current/40 hover:border-current"
        title="Mark this alert as resolved"
      >
        Dismiss
      </button>
    </form>
  );
}

/* ----------------------------------------------------------------- *
 * SunBiz hero KPI cards — 4 colored panels with click-through
 * ----------------------------------------------------------------- */

function SunBizHeroKpis({
  slug,
  leads,
  applications,
  fundedDeals,
}: {
  slug: string;
  leads: TenantRecord[];
  applications: TenantRecord[];
  fundedDeals: TenantRecord[];
}) {
  const hotLeads = leads.filter((l) => l.data.stage === "hot_lead").length;
  const missingInfo = leads.filter((l) => {
    const m = l.data.missing_info;
    return Array.isArray(m) && m.length > 0;
  }).length;

  // "Funded this month": funded_deals with funded_at in the current month.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const fundedThisMonth = fundedDeals.filter((d) => {
    const t = typeof d.data.funded_at === "string" ? Date.parse(d.data.funded_at) : NaN;
    return !Number.isNaN(t) && t >= monthStart;
  });
  const fundedAmountThisMonth = fundedThisMonth.reduce((sum, d) => {
    const amt = d.data.amount_funded;
    return sum + (typeof amt === "number" ? amt : 0);
  }, 0);

  // Renewals due: funded_deals at 40-50%+ through their term.
  const renewalsDue = fundedDeals.filter((d) => {
    const fundedAt = typeof d.data.funded_at === "string" ? Date.parse(d.data.funded_at) : NaN;
    const term = typeof d.data.term_months === "number" ? d.data.term_months : 0;
    if (!Number.isNaN(fundedAt) && term > 0) {
      const termMs = term * 30 * 24 * 60 * 60 * 1000;
      const elapsed = Date.now() - fundedAt;
      const pct = elapsed / termMs;
      return pct >= 0.4;
    }
    return false;
  }).length;

  // "In motion" — applications that are mid-funnel (not terminal, not
  // funded). Post-migration-064 the operative set is application_in /
  // shopping / requested_docs / docs_out / login. follow_ups is a
  // long-tail status and intentionally excluded from "in motion" so
  // the count reflects deals the operator can move TODAY.
  const IN_MOTION = new Set([
    "application_in",
    "shopping",
    "requested_docs",
    "docs_out",
    "login",
  ]);
  const oppPositive = applications.filter((a) =>
    IN_MOTION.has(String(a.data.status || "")),
  ).length;

  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        href={`/t/${slug}/leads?stage=hot_lead`}
        title="Hot leads"
        value={hotLeads}
        accent="#FFB81C"
        icon={<Flame className="w-5 h-5" />}
        sub="actively engaging"
      />
      <KpiCard
        href={`/t/${slug}/leads?stage=missing_info`}
        title="Missing info"
        value={missingInfo}
        accent="#C23934"
        icon={<AlertTriangle className="w-5 h-5" />}
        sub={missingInfo > 0 ? "needs docs from the lead" : "everyone's caught up"}
      />
      <KpiCard
        href={`/t/${slug}/applications`}
        title="In motion"
        value={oppPositive}
        accent="#0070D2"
        icon={<Sparkles className="w-5 h-5" />}
        sub="open opportunities"
      />
      <KpiCard
        // Migration 064: funded-deals nav was removed; link to the
        // Applications page filtered by funded status surfaces the
        // same rows the funded-deals kanban used to.
        href={`/t/${slug}/applications?stage=funded`}
        title="Funded this month"
        value={fundedThisMonth.length}
        accent="#3BA755"
        icon={<BadgeCheck className="w-5 h-5" />}
        sub={fundedAmountThisMonth > 0 ? formatMoney(fundedAmountThisMonth) + " total" : "no fundings yet"}
      />
      {renewalsDue > 0 && (
        <KpiCard
          href={`/t/${slug}/renewals`}
          title="Renewals due"
          value={renewalsDue}
          accent="#E96F2D"
          icon={<RefreshCw className="w-5 h-5" />}
          sub="40%+ through term"
        />
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- *
 * SunBiz action band — second row of cards surfacing renewal alerts,
 * offers needing review, and shopping-out activity. Phase 10 of the
 * Jordan/Oasis 2026-05-23 restructure (new operator-facing surfaces).
 * Server-rendered; query failures degrade to zero counts rather than
 * breaking the whole dashboard.
 * ----------------------------------------------------------------- */

async function SunBizActionBand({
  slug,
  tenantId,
}: {
  slug: string;
  tenantId: string | null;
}) {
  // Preview mode (operator viewing a tenant they don't own) renders
  // the 3-card band with zero counts instead of hiding it. Matches the
  // same "render scaffold with empty data" pattern the v2 surfaces use
  // (Offers / Renewals / Lenders / Shopping Out) — consistency fix
  // 2026-05-25. No queries fire when tenantId is null.
  const previewMode = !tenantId;

  const sb = getServiceSupabase();
  const SEVEN_DAYS_AGO_ISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Three queries in parallel. Each falls back to zero on error so a
  // missing-table or RLS-deny doesn't break the dashboard.
  // Renewal summary reuses the same query the /renewals page uses so
  // the card's count matches what the user sees when they click through
  // (Codex review 2026-05-24 — was hardcoded to 0).
  const [reviewRes, shoppingRes, renewals] = previewMode
    ? [
        { error: null, count: 0 } as const,
        { error: null, count: 0 } as const,
        {
          past_due_count: 0,
          this_week_count: 0,
          this_month_count: 0,
          est_commission_total_usd: 0,
          total_with_dates: 0,
          total_no_date: 0,
        },
      ]
    : await Promise.all([
    sb
      .from("application_lender_threads")
      .select("id, status, last_error", { count: "exact", head: false })
      .eq("tenant_id", tenantId)
      .or("status.eq.info_requested,last_error.not.is.null")
      .limit(1),
    sb
      .from("application_lender_threads")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "sent")
      .gte("sent_at", SEVEN_DAYS_AGO_ISO),
    getRenewalsSummary(tenantId).catch(() => ({
      past_due_count: 0,
      this_week_count: 0,
      this_month_count: 0,
      est_commission_total_usd: 0,
      total_with_dates: 0,
      total_no_date: 0,
    })),
  ]);

  const needsReview = reviewRes.error ? 0 : reviewRes.count ?? 0;
  const shoppingActive = shoppingRes.error ? 0 : shoppingRes.count ?? 0;
  const renewalAlerts = renewals.past_due_count + renewals.this_week_count;

  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <KpiCard
        href={`/t/${slug}/renewals`}
        title="Renewal alerts"
        value={renewalAlerts}
        accent="#E96F2D"
        icon={<RefreshCw className="w-5 h-5" />}
        sub={
          renewalAlerts > 0
            ? `${renewals.past_due_count} past due · ${renewals.this_week_count} this week`
            : "queue clear — nothing due this week"
        }
      />
      <KpiCard
        href={`/t/${slug}/offers`}
        title="Offers needing review"
        value={needsReview}
        accent="#C58B2F"
        icon={<AlertTriangle className="w-5 h-5" />}
        sub={needsReview > 0 ? "info-requested or send error" : "queue clear"}
      />
      <KpiCard
        href={`/t/${slug}/shopping-out`}
        title="Shopping out (7d)"
        value={shoppingActive}
        accent="#3978BE"
        icon={<Sparkles className="w-5 h-5" />}
        sub={shoppingActive > 0 ? "lenders awaiting reply" : "nothing in flight"}
      />
    </section>
  );
}

function KpiCard({
  href,
  title,
  value,
  accent,
  icon,
  sub,
}: {
  href: string;
  title: string;
  value: number;
  accent: string;
  icon: React.ReactNode;
  sub: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-xl border bg-bg-elev/40 hover:bg-bg-elev/70 transition-all hover:-translate-y-[1px] hover:shadow-lg"
      style={{ borderColor: `${accent}55` }}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div
            className="inline-flex items-center justify-center w-9 h-9 rounded-lg"
            style={{ background: `${accent}22`, color: accent }}
          >
            {icon}
          </div>
          <ArrowRight className="hover-reveal-cue w-3.5 h-3.5 text-fg-dim transition-opacity" />
        </div>
        <div className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-dim mb-1">
          {title}
        </div>
        <div className="text-3xl font-black text-fg leading-none">
          {value}
        </div>
        <div className="mt-1 text-[11px] text-fg-muted">{sub}</div>
      </div>
    </Link>
  );
}

/* ----------------------------------------------------------------- *
 * Generic KPI grid for non-SunBiz tenants
 * ----------------------------------------------------------------- */

function GenericKpis({ allRows }: { allRows: Array<{ entity: { name: string; label: string; fields: unknown[] }; total: number }> }) {
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {allRows.map(({ entity, total }) => (
        <div
          key={entity.name}
          className="rounded-xl border border-bg-border bg-bg-elev/40 p-4"
        >
          <div className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-dim mb-1">
            {entity.label}
          </div>
          <div className="text-3xl font-black text-fg leading-none">{total}</div>
          <div className="mt-1 text-[11px] text-fg-muted">{entity.fields.length} fields</div>
        </div>
      ))}
    </section>
  );
}

/* ----------------------------------------------------------------- *
 * Pipeline-at-a-glance — stacked color bar with Salesforce hex codes
 * ----------------------------------------------------------------- */

function PipelineGlanceCard({
  title,
  href,
  stages,
  rows,
  stageField,
}: {
  title: string;
  href: string;
  stages: StageMeta[];
  rows: TenantRecord[];
  stageField: string;
}) {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const s = String(r.data[stageField] || "");
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  const total = rows.length;

  return (
    <Card
      title={title}
      subtitle={`${total} ${total === 1 ? "record" : "records"} across ${stages.length} stages`}
      action={
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:text-accent/80"
        >
          Open <ArrowRight className="w-3 h-3" />
        </Link>
      }
    >
      <div className="space-y-3">
        {/* Stacked color bar */}
        <div className="flex w-full h-3 rounded-full overflow-hidden bg-bg-deep">
          {total === 0 ? (
            <div className="flex-1 bg-bg-elev/60" />
          ) : (
            stages.map((s) => {
              const c = counts[s.key] || 0;
              if (c === 0) return null;
              const pct = (c / total) * 100;
              return (
                <Link
                  key={s.key}
                  href={`${href}?stage=${encodeURIComponent(s.key)}`}
                  className="block h-full transition-opacity hover:opacity-80"
                  style={{ width: `${pct}%`, background: s.bg }}
                  title={`${s.label}: ${c}`}
                />
              );
            })
          )}
        </div>

        {/* Top 3 stages by count */}
        <ul className="space-y-1.5">
          {stages
            .map((s) => ({ stage: s, count: counts[s.key] || 0 }))
            .filter(({ count }) => count > 0)
            .sort((a, b) => b.count - a.count)
            .slice(0, 4)
            .map(({ stage, count }) => (
              <li key={stage.key}>
                <Link
                  href={`${href}?stage=${encodeURIComponent(stage.key)}`}
                  className="flex items-center justify-between gap-2 text-[12px] hover:text-fg group"
                >
                  <span className="flex items-center gap-2 text-fg-muted group-hover:text-fg transition-colors min-w-0">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ background: stage.bg }}
                    />
                    <span className="truncate">{stage.label}</span>
                  </span>
                  <span className="font-mono text-fg-dim group-hover:text-fg shrink-0">{count}</span>
                </Link>
              </li>
            ))}
          {total === 0 && (
            <li className="text-[11.5px] italic text-fg-dim text-center py-2">
              No records yet — they&apos;ll appear here as the pipeline fills.
            </li>
          )}
        </ul>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------- *
 * Today's focus — top urgent leads + renewals due
 * ----------------------------------------------------------------- */

// Migration 064 (2026-05-23) — imported / not_interested / approved
// retired from the active lead funnel. Remaining stages re-weighted so
// the urgency scorer ranks the active funnel cleanly without zombie keys.
const STAGE_WEIGHT: Record<string, number> = {
  hot_lead: 100,
  // Fresh inquiry — they just submitted the form. Rank near the very top of
  // Today's Focus so the team works it (or confirms Helios's auto-email landed)
  // before it cools, just under an already-engaged hot_lead.
  intent_inquiry_submitted: 98,
  // Live Subs (uw_sheet) — Ezra-approved Breeze deal: pre-qualified and
  // time-sensitive. Rank just under hot_lead/intent so it surfaces near the
  // top of Today's Focus (without this it falls to the `?? 30` default and
  // ranks below follow_up/missing_info — defeating the funnel intent).
  uw_sheet: 95,
  signed_application: 90,
  viewed_application: 80,
  sent_application: 70,
  missing_info: 65,
  follow_up: 50,
  submitted: 40,
  declined: 0,
  default: 0,
  dead_file: 0,
};

function urgencyScore(lead: TenantRecord): number {
  const stage = String(lead.data.stage || "");
  const base = STAGE_WEIGHT[stage] ?? 30;
  const updatedMs = Date.parse(lead.updated_at || lead.created_at || "");
  const daysSinceTouch = Number.isNaN(updatedMs)
    ? 0
    : Math.max(0, Math.floor((Date.now() - updatedMs) / (24 * 60 * 60 * 1000)));
  const revenue = typeof lead.data.monthly_revenue === "number" ? lead.data.monthly_revenue : 0;
  const revBoost = revenue > 0 ? Math.log10(revenue) * 6 : 0;
  return base + Math.sqrt(daysSinceTouch) * 8 + revBoost;
}

/* -----------------------------------------------------------------
 * Active Deals (Adon, 2026-06-22) — the deals the team is working RIGHT
 * NOW: post-shop-out applications a funder has engaged on. The operator
 * moves a shopped deal into `approved` once a funder bites, then works it
 * down the stips chain (requested_docs -> docs_out -> login -> funded).
 *
 * This is deliberately separate from "Biggest merchants to close" below:
 * that box is a lead-side REWARD ranking (who to chase next); this box is
 * the live deal board (what's on the table today). Stage is read from
 * data.status — the same field the one-click stage changer writes
 * (POST /api/leads/[id]/set-stage, entity=application), so moving a deal
 * into Approved via any stage control makes it appear here. No new
 * mutation surface — the existing stage changer IS the "move in" control.
 * ----------------------------------------------------------------- */

// Post-shop, pre-funded — the deals on the table today. Ordered by the
// work sequence so the freshest approvals sit on top; `funded` graduates
// out (it has its own KPI + Renewals surface).
const ACTIVE_DEAL_RANK: Record<string, number> = {
  approved: 0,
  requested_docs: 1,
  docs_out: 2,
  login: 3,
};

function dealAmount(app: TenantRecord): number {
  const d = app.data;
  if (typeof d.requested_amount === "number") return d.requested_amount;
  if (typeof d.monthly_revenue === "number") return d.monthly_revenue;
  return 0;
}

function ActiveDeals({ slug, applications }: { slug: string; applications: TenantRecord[] }) {
  const deals = applications
    .filter((a) => ACTIVE_DEAL_RANK[String(a.data.status || "")] !== undefined)
    .sort((a, b) => {
      const ra = ACTIVE_DEAL_RANK[String(a.data.status)] ?? 99;
      const rb = ACTIVE_DEAL_RANK[String(b.data.status)] ?? 99;
      if (ra !== rb) return ra - rb;
      return dealAmount(b) - dealAmount(a); // within a stage, biggest first
    });

  return (
    <Card
      title="Active deals — working now"
      subtitle="Approved & in-progress deals past shop-out: chasing stips, docs out, closing."
      action={
        <Link
          href={`/t/${slug}/applications?stage=approved`}
          className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:text-accent/80"
        >
          All applications <ArrowRight className="w-3 h-3" />
        </Link>
      }
    >
      {deals.length === 0 ? (
        <div className="text-sm text-fg-dim italic text-center py-4">
          No active deals yet. Move a shopped deal to <span className="font-semibold">Approved</span> once a funder bites — it&apos;ll surface here.
        </div>
      ) : (
        <ul className="divide-y divide-bg-border sm:grid sm:grid-cols-2 sm:gap-x-6 sm:divide-y-0">
          {deals.slice(0, 8).map((app) => {
            const stage = String(app.data.status || "");
            const stageMeta = OPPORTUNITY_PIPELINE_STAGES.find((s) => s.key === stage);
            const name =
              (typeof app.data.business_name === "string" && app.data.business_name) ||
              (typeof app.data.business_legal_name === "string" && app.data.business_legal_name) ||
              (typeof app.data.contact_name === "string" && app.data.contact_name) ||
              `Deal ${app.id.slice(0, 8)}`;
            const amount = dealAmount(app);
            return (
              <li key={app.id} className="border-b border-bg-border sm:border-b-0">
                <Link
                  href={pipelineRowHref(slug, "application", app.id)}
                  className="flex items-center justify-between gap-3 py-2 px-1 hover:bg-bg-elev/40 rounded transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-fg truncate">{name}</div>
                    <div className="text-[11px] text-fg-dim">
                      {amount > 0 ? formatMoney(amount) : "—"}
                      {app.updated_at ? ` · ${timeAgo(app.updated_at)}` : ""}
                    </div>
                  </div>
                  {stageMeta && (
                    <span
                      className="inline-block px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap shrink-0"
                      style={{ background: stageMeta.bg, color: stageMeta.fg }}
                    >
                      {stageMeta.label}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function TopUrgentLeads({ slug, leads }: { slug: string; leads: TenantRecord[] }) {
  // Terminal / parked states — anything in this set drops off the urgency
  // surface. 2026-06-18 (CC): `declined` was removed from the lead pipeline;
  // negative-reply / no-response leads now land in `ghost` (a 1-month
  // re-engagement bucket, not daily-attention work), so exclude ghost here.
  const TERMINAL = new Set(["default", "ghost", "dead_file"]);
  // Adon (2026-06-22): rank by deal VALUE, not the urgency formula —
  // this box is "the biggest merchants worth closing first" (highest
  // reward), distinct from the Active Deals board above. Tie-break on the
  // urgency score so two equally-sized leads order by who's going cold.
  const dealValue = (l: TenantRecord): number => {
    const d = l.data;
    if (typeof d.monthly_revenue === "number") return d.monthly_revenue;
    if (typeof d.requested_amount === "number") return d.requested_amount;
    return 0;
  };
  const top = [...leads]
    .filter((l) => !TERMINAL.has(String(l.data.stage || "")))
    .sort((a, b) => dealValue(b) - dealValue(a) || urgencyScore(b) - urgencyScore(a))
    .slice(0, 5);

  return (
    <Card
      title="Biggest merchants to close"
      subtitle="Your highest-revenue active leads — the deals worth chasing first."
      action={
        <Link
          href={`/t/${slug}/leads`}
          className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:text-accent/80"
        >
          All leads <ArrowRight className="w-3 h-3" />
        </Link>
      }
    >
      {top.length === 0 ? (
        <div className="text-sm text-fg-dim italic text-center py-4">
          No active leads yet. Import a list or wait for inbound — they&apos;ll surface here.
        </div>
      ) : (
        <ul className="divide-y divide-bg-border">
          {top.map((lead) => {
            const stage = String(lead.data.stage || "");
            const stageMeta = LEAD_PIPELINE_STAGES.find((s) => s.key === stage);
            const name =
              (typeof lead.data.business_name === "string" && lead.data.business_name) ||
              (typeof lead.data.contact_name === "string" && lead.data.contact_name) ||
              `Lead ${lead.id.slice(0, 8)}`;
            return (
              <li key={lead.id}>
                <Link
                  href={`/t/${slug}?lead=${lead.id}`}
                  className="flex items-center justify-between gap-3 py-2 px-1 hover:bg-bg-elev/40 rounded transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-fg truncate">{name}</div>
                    {typeof lead.data.monthly_revenue === "number" && (
                      <div className="text-[11px] text-fg-dim">{formatMoney(lead.data.monthly_revenue)}/mo</div>
                    )}
                  </div>
                  {stageMeta && (
                    <span
                      className="inline-block px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap shrink-0"
                      style={{ background: stageMeta.bg, color: stageMeta.fg }}
                    >
                      {stageMeta.label}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function RenewalsDueSoon({ slug, fundedDeals }: { slug: string; fundedDeals: TenantRecord[] }) {
  const due = fundedDeals
    .map((d) => {
      const fundedAt = typeof d.data.funded_at === "string" ? Date.parse(d.data.funded_at) : NaN;
      const term = typeof d.data.term_months === "number" ? d.data.term_months : 0;
      if (Number.isNaN(fundedAt) || term <= 0) return null;
      const termMs = term * 30 * 24 * 60 * 60 * 1000;
      const elapsed = Date.now() - fundedAt;
      const pct = elapsed / termMs;
      return { deal: d, pct };
    })
    .filter((x): x is { deal: TenantRecord; pct: number } => !!x && x.pct >= 0.4)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 3);

  return (
    <Card
      title="Renewals due soon"
      subtitle="Funded deals 40%+ through their term."
      action={
        <Link
          href={`/t/${slug}/renewals`}
          className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:text-accent/80"
        >
          All renewals <ArrowRight className="w-3 h-3" />
        </Link>
      }
    >
      {due.length === 0 ? (
        <div className="text-sm text-fg-dim italic text-center py-4">
          No renewals due yet — deals reach 40% of their term before they qualify.
        </div>
      ) : (
        <ul className="divide-y divide-bg-border">
          {due.map(({ deal, pct }) => {
            const amount = typeof deal.data.amount_funded === "number" ? deal.data.amount_funded : 0;
            const pctLabel = `${Math.round(pct * 100)}% in`;
            const tone =
              pct >= 0.5 ? "#E96F2D" : "#0070D2"; // overdue-ish vs upcoming
            return (
              <li key={deal.id}>
                <Link
                  // funded-deals is de-navved (renewals are computed from
                  // funded_deals on the Renewals page); the per-deal route
                  // lands on a raw field-edit form. Point at the Renewals
                  // page — consistent with this card's "All renewals" link
                  // and the "Renewals due" KPI card.
                  href={`/t/${slug}/renewals`}
                  className="flex items-center justify-between gap-3 py-2 px-1 hover:bg-bg-elev/40 rounded transition-colors"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-fg truncate">
                      {formatMoney(amount)} deal
                    </div>
                    {typeof deal.data.term_months === "number" && (
                      <div className="text-[11px] text-fg-dim">{deal.data.term_months}-month term</div>
                    )}
                  </div>
                  <span
                    className="inline-block px-2 py-0.5 rounded text-[10px] font-bold whitespace-nowrap shrink-0"
                    style={{ background: `${tone}22`, color: tone, border: `1px solid ${tone}55` }}
                  >
                    {pctLabel}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// formatMoney + timeAgo live in lib/fmt.ts (shared with the rest of the app).
