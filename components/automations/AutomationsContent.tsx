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
import { BreezeDealsPanel } from "@/components/automations/BreezeDealsPanel";
import { DescribeAutomationFlow } from "@/components/automations/DescribeAutomationFlow";
import { AgentsModulesStatusBoard } from "@/components/automations/AgentsModulesStatusBoard";
import { getActiveProfile, getBridgeOnline, getTenant } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { resolveClientProfileSlug } from "@/lib/client-profiles";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";
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
            <span className="text-fg font-bold">Where output ends up.</span>{" "}
            {tenantSlug === "sun"
              ? "Back in the dashboard — the Daily Plan, the deal records, the Breeze BD deal queue below, and alerts. Calls and texts to merchants go out through Kixie and TextTorrent. Scored Breeze deals go to Ezra's Telegram for approve/decline — approving there creates the lead."
              : "Telegram (alerts + briefs), local files (snapshots), or back into the dashboard (scoring + sync jobs)."}
          </p>
          <p>
            <span className="text-fg font-bold">Switching jobs on/off.</span> Each row has a
            toggle. Flip it off and the job stops within a minute — spec stays saved.
          </p>
          {tenantSlug === "sun" && (
            <p>
              <span className="text-fg font-bold">The four sections below.</span>{" "}
              <span className="text-fg">Modules</span> is what the system can do — your live
              capabilities, for reference (nothing to switch).{" "}
              <span className="text-fg">Scheduled jobs</span> are the timed automations; flip one
              off to pause it (takes effect within ~60s on the VPS).{" "}
              <span className="text-fg">Breeze BD deals</span> is the live intake queue — every UW
              sheet the scrubber verified and scored, with its Telegram approval status.{" "}
              <span className="text-fg">Background workers</span> are the always-on processes that
              power all of it — Start, Stop, or Restart each one and the signal goes straight to
              the VPS.
            </p>
          )}
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
          {isOasisSurfaceTenant(tenantSlug) && (
            // The panel existed and rendered for exactly one tenant: "sun".
            // OASIS's own workspace — where the empire daemons actually run —
            // never saw it, so the page that lists scheduled jobs had no way to
            // show the always-on processes doing the work beside them. The
            // Instagram setter was the cost: a live daemon answering real
            // prospects, invisible on the operations page, with only its parked
            // cron twin visible and reading OFF.
            //
            // Gated on the SURFACE, not the role — same rule as the Breeze
            // section below. isOasisSurfaceTenant covers OASIS's own workspaces
            // only, and /automations is already 404 for the personas whose
            // canSeeSystemSurfaces is false (reps, managers), so no client
            // tenant and no rep gets CC's machine's daemon list.
            <BackgroundWorkersPanel />
          )}
          {tenantSlug === "sun" && (
            // SURFACE, NOT ROLE. This read `(isOperator || tenantSlug === "sun")`
            // until 2026-08-17, and the first half of that leaked a client's book
            // onto OASIS's own operations page.
            //
            // `isOperatorEmail` is true for CC. `/automations` at the top level of
            // oasisai.work is the OASIS surface, tenantSlug is not "sun" — and the
            // panel rendered anyway. Worse, it worked: GET /api/automations/breeze-deals
            // deliberately resolves an empire operator to the SunBiz tenant
            // (`tenants.slug = 'submissions'`), so the request returned REAL deals.
            // CC opened OASIS's automations and read Kinesioworks' revenue,
            // Diamond Ridge's leverage, 146 pending submissions.
            //
            // Being allowed to see a client's data somewhere is not permission to
            // render it everywhere. Role answers "may this person"; the surface
            // answers "is this the place", and only the second one belongs in this
            // condition. The Breeze queue is Adon's underwriting desk and lives on
            // the SunBiz surface, where its own heading already says so.
            //
            // The route keeps its operator path on purpose — Adon's tooling calls it
            // directly and /t/sun/automations still renders this section. Nothing
            // lost, just no longer painted onto the wrong portal.
            //
            // B3 (2026-07-23), retained: the heading below separates "your SunBiz
            // automations" from "the Breeze/MCA underwriting surface Adon operates",
            // which previously ran together under a plain border-top.
            <section
              aria-labelledby="underwriting-breeze-heading"
              className="border-t-2 border-bg-border pt-6 space-y-6"
            >
              <div>
                <h2
                  id="underwriting-breeze-heading"
                  className="text-xs font-bold uppercase tracking-wider text-fg-muted"
                >
                  Underwriting / Breeze
                </h2>
                <p className="text-[11px] text-fg-dim mt-0.5">
                  The MCA/underwriting surface — deal intake queue + the background daemons that
                  power it. Separate from the SunBiz automations above.
                </p>
              </div>
              <BreezeDealsPanel />
              <BackgroundWorkersPanel />
            </section>
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
