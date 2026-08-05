import { Card, PageHeader, EmptyState, Tag } from "@/components/Card";
import { recentDecisions, getActiveProfile } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { AgentDecisionsCard } from "@/components/AgentDecisionsCard";
import { QuickActionsGrid } from "@/components/reasoning/QuickActionsGrid";
import { quickActionsFor } from "@/lib/quick-actions";
import { getTenantEnabledAgents } from "@/lib/manifest/tenant-scope";

export const dynamic = "force-dynamic";

export default async function ReasoningPage() {
  // Phase 5 — manifest is the source of truth for enabled agents per tenant.
  // QuickActionsGrid downstream takes the slug array so it keeps rendering
  // the right per-agent prompts as the manifest evolves.
  const profile = await safe("reasoning.profile", getActiveProfile(), null);
  const manifestEnabledSlugs = await getTenantEnabledAgents(profile?.tenant_id ?? null);

  // Strict tenant scoping. Empty array yields an empty state — never
  // falls back to ["bravo"] which would leak Bravo's decisions to a
  // SunBiz tenant whose manifest + profile were both unpopulated.
  const enabled =
    manifestEnabledSlugs.length > 0
      ? manifestEnabledSlugs
      : (profile?.agents_enabled || []);

  // Agent decisions tape is scoped by tenant_id + enabled agents — see
  // recentDecisions() docstring for the schema-debt explanation. Without
  // this, a SunBiz user would see CC's OASIS Bravo decisions because the
  // table has no tenant_id column yet.
  const decisions = await safe(
    "reasoning.recent_decisions",
    recentDecisions(profile?.tenant_id ?? null, enabled, 20),
    []
  );

  const quickActions = quickActionsFor(enabled);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Reasoning"
        subtitle="Click an action to send it straight to chat. The agent runs it for you — no terminal, no setup."
        action={<Tag tone="accent">{`${quickActions.length} actions · ${enabled.length} agents`}</Tag>}
      />

      <Card
        title="Quick actions"
        subtitle="Each one drops a prompt into chat with the right agent already selected. Hit Enter to send."
      >
        {quickActions.length === 0 ? (
          <EmptyState message="No agents enabled. Toggle agents in Settings → Agents." />
        ) : (
          <QuickActionsGrid actions={quickActions} />
        )}
      </Card>

      {/* Same tape /operations renders for CC. Shared component so the two
          surfaces can't drift — the empty-state copy in particular is
          brand-neutral on purpose (2026-05-25 cross-tenant audit) and that
          fix should never have to be made twice. */}
      <AgentDecisionsCard decisions={decisions} />
    </div>
  );
}
