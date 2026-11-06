import { Card, EmptyState, Tag } from "@/components/Card";
import { QuickActionsGrid, type QuickActionHeading } from "@/components/reasoning/QuickActionsGrid";
import { quickActionsFor } from "@/lib/quick-actions";
import type { TenantManifest } from "@/lib/manifest/schema";
import { departmentProfile, workspaceBindings } from "@/components/os/department/config";
import { departmentForAgent, departmentLabel, type AskDepartmentSlug } from "@/lib/os/chat-href";
import { departmentBySlug } from "@/lib/os/departments";
import { agentNameFor, agentTextFor } from "@/lib/os/agent-names";
import { viewerReadsInternalAgentNames } from "@/lib/os/agent-names-session";
import { readOpenAskDepartments } from "@/lib/playbook/ask-access";
import { isOasisSurfaceTenant } from "@/lib/role-surfaces";

/**
 * Manifest-aware Reasoning surface for /t/<slug>/reasoning. Filters the
 * QUICK_ACTIONS catalog by the tenant's enabled agents (manifest.agents
 * where enabled=true) and feeds the existing QuickActionsGrid. Mirrors the
 * top-level /reasoning page's shape so an OASIS operator and a SunBiz
 * operator get the same UX inside their own tenant namespace.
 *
 * WHO READS WHAT (lib/os/agent-names.ts). The actions were written for OASIS's
 * founders, under each agent's own name. Anyone else reads each group as the
 * department that answers for the agent, the actions in department words, and
 * only the departments they may open: a rep was shown Bravo, Atlas and Maven
 * here, and an "Ask" into Finance or Marketing that answers them with a 404.
 *
 * WHICH AGENTS. Only the ones that run here: outside OASIS's own workspace a
 * house agent's binding does nothing (decision 21, components/os/department/
 * config.ts workspaceBindings), so its actions are not offered under any name.
 *
 * No client component needed — QuickActionsGrid is "use client" and handles
 * its own interactivity.
 */
export async function ManifestReasoning({
  manifest,
}: {
  manifest: TenantManifest;
  tenantSlug: string;
}) {
  const internalNames = await viewerReadsInternalAgentNames();
  const enabledAgents = workspaceBindings({ oasis: isOasisSurfaceTenant(manifest.tenant_slug), manifest }).filter((a) => a.enabled);
  const enabled = enabledAgents.map((a) => a.slug.toLowerCase());
  const written = quickActionsFor(enabled);
  // A founder may open every department. Anyone else is offered the actions
  // whose department the rail opens for them; null: that could not be checked.
  const open = internalNames ? null : await readOpenAskDepartments();
  const actions = (internalNames ? written : written.filter((q) => open !== null && open.includes(departmentForAgent(q.agent)))).map((q) =>
    internalNames
      ? q
      : { ...q, title: agentTextFor(q.title, false), description: agentTextFor(q.description, false), prompt: agentTextFor(q.prompt, false) },
  );
  // Departments head the groups for anyone but a founder, so the groups are
  // departments too: two agents of one department share one heading.
  const headings = internalNames
    ? undefined
    : Object.fromEntries(actions.map((q) => [departmentForAgent(q.agent), departmentHeading(departmentForAgent(q.agent))]));
  const names = enabledAgents.map((a) => agentNameFor({ slug: a.slug, name: a.display_name }, internalNames)).join(", ");
  // Why the list is empty, said as it is: none written yet, none this viewer's
  // role may open, or the check itself failed (an absent answer is not a zero).
  const empty =
    enabled.length === 0
      ? `No agents enabled yet. Switch one on from Settings → Agents.`
      : written.length === 0
        ? `No quick actions for ${names} yet — they'll appear here as we add more.`
        : open === null
          ? "Couldn't check which departments you can open, so no quick actions are shown. Reload to try again."
          : `The quick actions for ${names} go to departments your role can't open.`;

  return (
    <Card
      title="Quick actions"
      subtitle="Each one drops a prompt into chat with the right agent already selected. Hit Enter to send."
      action={
        <Tag tone="accent">
          {actions.length} actions · {enabled.length} agents
        </Tag>
      }
    >
      {actions.length === 0 ? (
        <EmptyState message={empty} />
      ) : (
        <QuickActionsGrid actions={actions} headings={headings} byDepartment={!internalNames} />
      )}
    </Card>
  );
}

/**
 * A group's heading for anyone but a founder: the department, and its own
 * one-line purpose (its tab's subtitle).
 */
function departmentHeading(slug: AskDepartmentSlug): QuickActionHeading {
  const dept = departmentBySlug(slug);
  return { label: departmentLabel(slug), tagline: dept ? departmentProfile(dept.key).purpose : "" };
}
