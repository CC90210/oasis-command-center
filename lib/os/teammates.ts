/**
 * lib/os/teammates.ts - the workspace's AI teammates: ONE roster, read from its
 * manifest (W4a, 2026-10-01; audit S2-01, S2-02, S2-14, S5-F04).
 *
 * WHY. "Which agents does this workspace run" had many answers. The AI Team
 * page listed department leads from a static binding table; Settings > AI brain
 * listed manifest.agents renamed through a hand-written job table ("Personal
 * assistant", "Contracts", "Commerce", "Memory keeper") and offered OASIS's
 * house agents as add-ons; the welcome wizard kept its own label map. OASIS's
 * owner saw five leads on one page and five different rows on the other. Every
 * one of those surfaces now reads this:
 *
 *   lead     a binding that leads a department here (components/os/department/
 *            config.ts departmentLead: the manifest's `departments`, or, in
 *            OASIS's workspace only, OASIS's static lead where its manifest
 *            names none), in rail order;
 *   custom   every other binding the workspace built.
 *
 * NAMES. The binding's display_name is authoritative. The one exception is a
 * lead answering on OASIS's static fallback (a stored manifest written before
 * `departments` existed): its stored display_name is a persona ("Bravo"), so it
 * is named for the departments it leads, exactly as the AI Team named it before.
 *
 * HOUSE AGENTS (decision 21). A house agent (lib/agents.ts isHouseAgentSlug) is
 * a teammate only where it leads a department, which only OASIS's own
 * workspace can bind. Anywhere else it is not on the roster: CC's own agents
 * (aura, lex, hermes, life-preservation) live in Admin > Fleet, and a client
 * never runs one (config.ts workspaceBindings drops them outside OASIS).
 *
 * PURE: no session, no database. The AI Team roster (components/os/aiteam/
 * roster.ts), Settings, the welcome wizard and the activity log all call it.
 */
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import type { DepartmentKey } from "@/lib/os/types";
import type { ManifestAgentBinding } from "@/lib/manifest/schema";
import { isHouseAgentSlug } from "@/lib/agents";
import {
  bindingIsOn,
  departmentLead,
  departmentProfile,
  workspaceBindings,
  type DepartmentScope,
} from "@/components/os/department/config";

export type WorkspaceTeammate = {
  slug: string;
  /** What this workspace calls it: its binding's display_name. */
  name: string;
  /** One line: a lead's first department's purpose; "" for a custom teammate. */
  summary: string;
  kind: "lead" | "custom";
  /** The departments it leads here, in rail order ([] for a custom teammate). */
  departments: DepartmentKey[];
  /** Switched on (a core binding always is). */
  enabled: boolean;
  /** Always on, with no switch: a core binding, or a lead with no binding of its own. */
  core: boolean;
  primary: boolean;
  /**
   * It has a manifest binding to switch. False only for an OASIS lead that
   * answers on the static fallback with no binding of its own.
   */
  bound: boolean;
};

/** Department labels in rail order: ["Chief of Staff", "Operations"]. */
export function departmentLabelsFor(keys: readonly DepartmentKey[]): string[] {
  return OS_DEPARTMENTS.filter((d) => keys.includes(d.key)).map((d) => d.label);
}

/** "Chief of Staff · Operations": department labels in rail order. */
export function departmentNames(keys: readonly DepartmentKey[]): string {
  return departmentLabelsFor(keys).join(" · ");
}

export function workspaceTeammates(scope: DepartmentScope): WorkspaceTeammate[] {
  const bindings = workspaceBindings(scope);

  const leads = new Map<string, { slug: string; binding: ManifestAgentBinding | null; departments: DepartmentKey[]; declared: boolean }>();
  for (const dept of OS_DEPARTMENTS) {
    const lead = departmentLead(dept.key, scope);
    if (!lead) continue;
    const key = lead.slug.toLowerCase();
    const entry = leads.get(key);
    if (entry) {
      entry.departments.push(dept.key);
      entry.declared = entry.declared || lead.binding !== null;
    } else {
      leads.set(key, {
        slug: lead.slug,
        // The binding that switches it: the one its department channel obeys
        // (config.ts departmentLead `control`), so the two always agree.
        binding: lead.control,
        departments: [dept.key],
        declared: lead.binding !== null,
      });
    }
  }

  const out: WorkspaceTeammate[] = [];
  for (const { slug, binding, departments, declared } of leads.values()) {
    const named = declared ? binding?.display_name.trim() : "";
    out.push({
      slug,
      name: named || departmentNames(departments),
      summary: departmentProfile(departments[0]).purpose,
      kind: "lead",
      departments,
      enabled: binding ? bindingIsOn(binding) : true,
      core: binding ? binding.core === true : true,
      primary: binding?.primary === true,
      bound: binding !== null,
    });
  }

  const seen = new Set<string>(leads.keys());
  for (const b of bindings) {
    const key = b.slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // A house agent that leads nothing here is not a workspace teammate.
    if (isHouseAgentSlug(b.slug)) continue;
    out.push({
      slug: b.slug,
      name: b.display_name.trim() || b.slug,
      summary: "",
      kind: "custom",
      departments: [],
      enabled: bindingIsOn(b),
      core: b.core === true,
      primary: b.primary === true,
      bound: true,
    });
  }
  return out;
}

/** The roster entry for `slug` in this workspace, or null when it is not one of its teammates. */
export function teammateFor(slug: string, scope: DepartmentScope): WorkspaceTeammate | null {
  const key = (slug || "").trim().toLowerCase();
  if (!key) return null;
  return workspaceTeammates(scope).find((t) => t.slug.toLowerCase() === key) ?? null;
}
