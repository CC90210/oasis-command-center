/**
 * AutomationsContent — shared body of the Automations surface.
 *
 * Used by:
 *   - app/automations/page.tsx (top-level — always renders for the
 *     signed-in user's home tenant)
 *   - components/automations/TenantAutomations.tsx (mounted by the
 *     manifest catch-all for kind="automations", routes through
 *     /t/<slug>/automations with preview-mode handling)
 *
 * Single source of truth — extracted 2026-05-25 (Option A pattern,
 * matches what SettingsContent did for /settings). Previously the
 * SUN_SEED nav pointed Sun Biz operators at top-level /automations,
 * which conflated tenant routing with operator-home routing. Now
 * /t/sun/automations goes through the catch-all and TenantAutomations
 * gates preview mode cleanly.
 */

import { PageHeader } from "@/components/Card";
import { CronJobsManager } from "@/components/automations/CronJobsManager";
import { BackgroundWorkersPanel } from "@/components/automations/BackgroundWorkersPanel";
import { DescribeAutomationFlow } from "@/components/automations/DescribeAutomationFlow";
import { AgentsModulesStatusBoard } from "@/components/automations/AgentsModulesStatusBoard";
import { getActiveProfile, getBridgeOnline, getTenant } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { getSessionUser } from "@/lib/supabase-server";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { getManifest, manifestExists } from "@/lib/manifest/loader";
import { Clock, Cpu, Cloud, Download } from "lucide-react";
import Link from "next/link";

export async function AutomationsContent({
  previewMode = false,
  tenantSlug: overrideSlug,
  hideHeader = false,
}: {
  /** Operator is viewing a tenant they don't own. Renders the chrome
   *  + empty scaffold; NO sub-components mount, so no client-side
   *  fetch can leak operator-scoped data into the tenant view. */
  previewMode?: boolean;
  /** When mounted by the catch-all dispatcher, this is the URL
   *  tenant's slug (used to scope the modules board). Otherwise
   *  the signed-in user's tenant slug is resolved below. */
  tenantSlug?: string | null;
  /** Catch-all dispatcher already renders the page title — suppress
   *  the inner one when mounted there. */
  hideHeader?: boolean;
}) {
  if (previewMode) {
    return <PreviewAutomations tenantSlug={overrideSlug ?? "this tenant"} hideHeader={hideHeader} />;
  }

  const profile = await safe("automations.profile", getActiveProfile(), null);
  const bridgeOnline = await safe(
    "automations.bridge_online",
    getBridgeOnline(profile?.tenant_id || null),
    false,
  );
  const user = await getSessionUser().catch(() => null);
  const isOperator = isOperatorEmail(user?.email || undefined);

  const tenantIdForSlug = profile?.tenant_id ?? null;
  const tenantSlug = overrideSlug ?? (
    tenantIdForSlug
      ? await safe(
          "automations.tenant_slug",
          (async () => {
            const t = await getTenant(tenantIdForSlug);
            return t ? resolveClientProfileSlug(t) : null;
          })(),
          null,
        )
      : null
  );
  const hasTenantManifest = tenantSlug
    ? await safe("automations.manifest_exists", manifestExists(tenantSlug), false)
    : false;
  const manifest = tenantSlug && hasTenantManifest
    ? await safe("automations.manifest", getManifest(tenantSlug), null)
    : null;
  const profileAgentKeys = Array.isArray(profile?.agents_enabled) ? profile.agents_enabled : [];
  const manifestAgentKeys = (manifest?.agents || [])
    .filter((agent) => agent.enabled)
    .map((agent) => agent.slug);
  const automationAgentKeys = Array.from(
    new Set((profileAgentKeys.length > 0 ? profileAgentKeys : manifestAgentKeys)
      .map((key) => String(key).trim().toLowerCase())
      .filter(Boolean)),
  );

  return (
    <div className="space-y-6 animate-fade-in">
      {!hideHeader && (
        <PageHeader
          title="Automations"
          subtitle="Scheduled jobs your agents run for you — daily briefs, follow-up reminders, lead scoring, anything you describe in plain English."
        />
      )}

      <div className="rounded-xl border border-bg-border bg-bg-deep/40 p-4 flex items-start gap-3">
        {bridgeOnline ? (
          <Cpu className="w-5 h-5 text-status-engaged shrink-0 mt-0.5" />
        ) : (
          <Cloud className="w-5 h-5 text-fg-dim shrink-0 mt-0.5" />
        )}
        <div className="flex-1 text-xs leading-relaxed">
          {bridgeOnline ? (
            <>
              <span className="text-status-engaged font-bold">Your computer is connected.</span>{" "}
              Jobs run on the schedule below. Edits take effect within a minute. Switch any job off
              and it stops firing — the spec stays saved so you can flip it back on later.
            </>
          ) : (
            <>
              <span className="text-fg-muted font-bold">Computer not connected yet.</span>{" "}
              Jobs you create here are saved, but they won&apos;t start running until you pair a
              machine. Click <span className="text-fg font-medium">Install bridge</span> —
              it takes about a minute, one command to copy-paste, and you&apos;re live.
            </>
          )}
        </div>
        {!bridgeOnline && (
          <Link
            href="/settings/devices/install"
            className="btn-primary inline-flex items-center gap-1.5 text-xs shrink-0"
          >
            <Download className="w-3 h-3" />
            Install bridge
          </Link>
        )}
        <Clock className="w-4 h-4 text-fg-dim shrink-0 mt-0.5 hidden sm:block" />
      </div>

      <details className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-sm">
        <summary className="cursor-pointer select-none flex items-center gap-2 text-fg font-bold">
          <span className="inline-block">▸</span>
          How automations work, in plain English
        </summary>
        <div className="mt-3 space-y-3 text-fg-muted leading-relaxed">
          <p>
            <span className="text-fg font-bold">Where they run.</span> Each automation runs on
            the connected machine, not the cloud. The machine wakes up every minute, checks the
            schedule, and runs anything that&apos;s due — quietly in the background.
          </p>
          <p>
            <span className="text-fg font-bold">What it costs.</span> Most jobs are free
            (pulling data, taking snapshots, syncing Stripe). AI-powered ones cost roughly
            25¢ per daily summary; scoring a single lead is ~a penny. Email/SMS sends use your
            own Gmail / Twilio with no markup.
          </p>
          <p>
            <span className="text-fg font-bold">Where output ends up.</span> Telegram (alerts +
            briefs), local files (snapshots), or back into the dashboard (scoring + sync jobs).
          </p>
          <p>
            <span className="text-fg font-bold">Switching jobs on/off.</span> Each row has a
            toggle. Flip it off and the job stops within a minute — spec stays saved.
          </p>
          <p>
            <span className="text-fg font-bold">Making your own.</span> Describe what you want
            in the box below and your agent writes the script, shows you what it does, and
            saves it switched-off so nothing fires until you read it.
          </p>
        </div>
      </details>

      {profile ? (
        <>
          <DescribeAutomationFlow />
          <AgentsModulesStatusBoard tenantSlug={tenantSlug} />
          <CronJobsManager agentKeys={automationAgentKeys} />
          {(isOperator || tenantSlug === "sun") && (
            <div className="border-t border-bg-border pt-6">
              <BackgroundWorkersPanel />
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-8 text-center text-fg-muted">
          Sign in to manage your automations.
        </div>
      )}
    </div>
  );
}

/**
 * Preview-mode render — operator is viewing /t/<slug>/automations for
 * a tenant they don't own. Renders chrome + empty scaffold; NO sub-
 * components mount, so no client-side fetch leaks operator-scoped data
 * (CC's cron jobs, empire background workers, AI-draft history) into
 * the tenant view.
 */
function PreviewAutomations({ tenantSlug, hideHeader }: { tenantSlug: string; hideHeader: boolean }) {
  return (
    <div className="space-y-6 animate-fade-in">
      {!hideHeader && (
        <PageHeader
          title="Automations"
          subtitle={`Tenant-scoped automations for ${tenantSlug}. Sign in as the tenant operator to manage these.`}
        />
      )}
      <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-8 text-center text-fg-muted">
        Preview mode — no automations data is fetched. The tenant operator manages cron jobs +
        sees the bridge status here once signed in.
      </div>
    </div>
  );
}
