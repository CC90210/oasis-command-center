/**
 * /agents — the AI Team (plan D4, CC's "Agents" tab).
 *
 * WHAT IT SHOWS (one roster, W4a 2026-10-01: the workspace manifest, read
 * through components/os/aiteam/roster.ts; Settings > AI brain lists the same)
 *   Department leads   the teammate leading each department channel the viewer
 *                      can open, with where it lives (Web; Slack as the
 *                      workspace's real state, lib/slack/status.ts, or the
 *                      Slack card's own words when that connection is failing;
 *                      Telegram only where the workspace has a team bot set
 *                      up, as its Connections card says).
 *   Custom teammates   agents this workspace built in the builder, On/Off as
 *                      the workspace manifest has them.
 *   On / Off           owners and admins switch any teammate that is not core
 *                      (POST /api/tenant/agents/toggle); everyone else reads it.
 *   New teammate       owners/admins: the existing builder, plus six starting
 *                      templates (Setter, Support rep, Bookkeeper, Media buyer,
 *                      Content producer, Project manager) it opens prefilled.
 *
 * WHAT MOVED OUT. This page used to be the operator fleet: the ChatWidget
 * power chat on the CLI bridge, provider-key nudges and every agent's
 * schedules. That is OASIS machinery, not a client's team, and it now lives at
 * Admin › Fleet (/admin/agents, operator-only; components/os/landings/
 * AgentFleet.tsx + fleet-data.ts). Nothing here reads bridge pairings,
 * provider keys or the Empire schedules.
 *
 * GATES, before any read, in this order:
 *   1. requireSystemSurface() — the page's own persona wall, the same one
 *      /operations, /automations and /health carry (tests/role-surfaces
 *      pins it). It 404s an outside contractor before anything is fetched.
 *   2. mayOpenOsHref(viewer.navInput, "/agents") — the rail's row (lib/os/nav.ts
 *      "ai-team": owners and admins, audience "manage", in ANY provisioned
 *      workspace; decision 22 opened it to client owners, whose only agent
 *      surface was a Settings card), so the page opens exactly when the rail
 *      draws it. An unprovisioned workspace 404s too, as its rail shows Today
 *      only.
 * The roster is built for any workspace: outside OASIS it lists only the
 * neutral leads and the workspace's own teammates, never an OASIS persona.
 *
 * Inside the page, a department lead is listed only if the viewer can open its
 * tab (components/os/department/gate.ts, the rail's own predicate), and a
 * client workspace is only ever shown neutral templates, never an OASIS persona
 * (components/os/department/config.ts).
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Card, EmptyState } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { loadAiTeam } from "@/components/os/aiteam/roster";
import { TeammateRow } from "@/components/os/aiteam/TeammateRow";
import { TeammateToggle } from "@/components/os/aiteam/TeammateToggle";
import { TemplatePicker } from "@/components/os/aiteam/TemplatePicker";
import { resolveOsViewer } from "@/components/os/department/viewer";
import { mayOpenOsHref } from "@/lib/os/nav";
import { requireSystemSurface } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";

const AI_TEAM_HREF = "/agents";

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-2.5">
      <h2 className="text-sm font-semibold leading-5 text-fg">{title}</h2>
      {hint && <p className="text-[13px] leading-5 text-fg-muted">{hint}</p>}
    </div>
  );
}

export default async function AiTeamPage() {
  await requireSystemSurface();
  const viewer = await resolveOsViewer();
  if (!viewer.ok) {
    if (viewer.reason === "signed_out") notFound();
    return (
      <PageFrame title="AI team" subtitle="We could not confirm which workspace you are in.">
        <Card>
          <EmptyState message="Refresh to try again. No teammates were guessed in the meantime." />
        </Card>
      </PageFrame>
    );
  }
  if (!viewer.provisioned) notFound();
  if (!mayOpenOsHref(viewer.navInput, AI_TEAM_HREF)) notFound();

  // The workspace's own roster (its manifest, lib/os/teammates.ts): "On" here
  // is lib/manifest/agent-roster.ts's rule, the one Settings and the chat
  // picker use.
  const team = await loadAiTeam(viewer);

  return (
    <PageFrame
      title="AI team"
      subtitle="The AI teammates working in your departments. Each one answers in its department's channel."
      className="space-y-8"
      actions={
        team.builderHref ? (
          <Link href={team.builderHref} prefetch={false} className="btn-primary inline-flex items-center gap-1.5">
            <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
            New teammate
          </Link>
        ) : null
      }
    >
      <section>
        <SectionTitle title="Department leads" hint="Open a department to talk to its lead." />
        {team.leads.length === 0 ? (
          <Card>
            <EmptyState message="No departments are open to you in this workspace yet." />
          </Card>
        ) : (
          <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-bg-panel">
            {team.leads.map((lead) => (
              <TeammateRow
                key={lead.id}
                name={lead.name}
                summary={lead.summary}
                departments={lead.departments}
                web={lead.web}
                webReason={lead.webReason}
                slack={lead.slack}
                slackProblem={team.channels.slackProblem}
                telegramSetUp={team.channels.telegramSetUp}
                href={lead.departments[0]?.href ?? null}
                control={lead.toggle ? <TeammateToggle {...lead.toggle} name={lead.name} /> : undefined}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionTitle
          title="Custom teammates"
          hint={team.builderHref ? "Built by your team for work the departments do not cover." : undefined}
        />
        {!team.custom.ok ? (
          <Card>
            <EmptyState message="Couldn’t load your custom teammates. Refresh to try again." />
          </Card>
        ) : team.custom.value.length === 0 ? (
          <Card>
            <EmptyState
              message={
                team.builderHref
                  ? "No custom teammates yet. Start from a template below, or build one from scratch."
                  : "No custom teammates yet. Owners and admins can add them."
              }
            />
          </Card>
        ) : (
          <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-bg-panel">
            {team.custom.value.map((c) => (
              <TeammateRow
                key={c.slug}
                name={c.name}
                meta={c.category}
                summary={c.summary}
                web={c.web}
                webReason={c.webReason}
                telegramSetUp={team.channels.telegramSetUp}
                href={c.webHref}
                badge={c.enabled ? "On" : "Off"}
                control={c.toggle ? <TeammateToggle {...c.toggle} name={c.name} /> : undefined}
              />
            ))}
          </ul>
        )}
      </section>

      {team.builderHref && (
        <section>
          <SectionTitle title="Start from a template" hint="Each opens the builder. You review everything before it goes live." />
          <TemplatePicker builderHref={team.builderHref} />
        </section>
      )}
    </PageFrame>
  );
}
