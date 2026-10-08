import { Card, EmptyState, Tag } from "@/components/Card";
import { QuickActionsGrid, type QuickActionHeading } from "@/components/reasoning/QuickActionsGrid";
import { quickActionsFor } from "@/lib/quick-actions";
import type { TenantManifest } from "@/lib/manifest/schema";
import { departmentProfile } from "@/components/os/department/config";
import { departmentForAgent } from "@/lib/os/chat-href";
import { departmentBySlug } from "@/lib/os/departments";
import { agentNameFor, agentTextFor, houseAgentDepartmentSlug } from "@/lib/os/agent-names";
import { viewerReadsInternalAgentNames } from "@/lib/os/agent-names-session";
import { openAskDepartments } from "@/lib/playbook/ask-access";

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
  const enabledAgents = manifest.agents.filter((a) => a.enabled);
  const enabled = enabledAgents.map((a) => a.slug.toLowerCase());
  const open = internalNames ? null : await openAskDepartments();
  const actions = quickActionsFor(enabled)
    .filter((q) => open === null || open.includes(departmentForAgent(q.agent)))
    .map((q) =>
      internalNames
        ? q
        : { ...q, title: agentTextFor(q.title, false), description: agentTextFor(q.description, false), prompt: agentTextFor(q.prompt, false) },
    );
  const headings = internalNames ? undefined : Object.fromEntries(actions.map((q) => [q.agent, departmentHeading(q.agent)]));

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
        <EmptyState
          message={
            enabled.length === 0
              ? `No agents enabled yet. Switch one on from Settings → Agents.`
              : `No quick actions for ${enabledAgents.map((a) => agentNameFor({ slug: a.slug, name: a.display_name }, internalNames)).join(", ")} yet — they'll appear here as we add more.`
          }
        />
      ) : (
        <QuickActionsGrid actions={actions} headings={headings} />
      )}
    </Card>
  );
}

/**
 * A group's heading for anyone but a founder: the department that answers for
 * the agent, and that department's own one-line purpose (its tab's subtitle).
 */
function departmentHeading(agent: string): QuickActionHeading {
  const dept = departmentBySlug(houseAgentDepartmentSlug(agent));
  return dept
    ? { label: dept.label, tagline: departmentProfile(dept.key).purpose }
    : { label: agentNameFor({ slug: agent }, false), tagline: "" };
}
