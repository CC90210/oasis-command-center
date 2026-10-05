/**
 * lib/os/teammate-names.ts - what Settings calls an agent: its name on this
 * workspace's roster, never the persona behind it.
 *
 * WHY. Settings > AI brain listed "Bravo", "Atlas", "Maven", "Aura", "Hermes",
 * "Solara" and "Helios" to every workspace. A first fix renamed them through a
 * hand-written job table ("General assistant", "Personal assistant",
 * "Commerce", "Memory keeper"...), which was a second roster that disagreed
 * with the AI Team page. That table is gone (W4a, 2026-10-01; audit S2-02,
 * S2-14): a teammate is called what its manifest binding calls it, through the
 * one roster every surface reads (lib/os/teammates.ts). In OASIS's workspace
 * that is "Chief of Staff · Operations", "Sales", "Marketing", "Client
 * Success" and "Finance"; in a client's, the leads OASIS set up for it ("Sales
 * lead", "Client Success lead") and the teammates it built.
 *
 * A slug that is not on the roster gets null here (a house agent that leads
 * nothing, an agent the workspace removed): callers show no name for it rather
 * than a persona's.
 *
 * Pure: no session, no database. SettingsContent computes the map on the
 * server and hands plain data to the client cards.
 */
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { departmentChannelFor, type DepartmentScope } from "@/components/os/department/config";
import { teammateFor } from "@/lib/os/teammates";

export type TeammateName = { name: string; summary: string };

/** Whose workspace the names are for, and its manifest (the roster). */
export type TeammateNameScope = DepartmentScope;

/** A custom teammate's line when its own description is not at hand. */
const BUILT_HERE = "Built for this workspace.";

/** The departments with an AI teammate answering in this workspace, in rail order. */
export function boundDepartmentLabels(scope: TeammateNameScope): string[] {
  return OS_DEPARTMENTS.filter((d) => departmentChannelFor(d.key, scope).kind === "agent").map((d) => d.label);
}

/** This workspace's name for a teammate, or null for a slug not on its roster. */
export function teammateNameFor(slug: string, scope: TeammateNameScope): TeammateName | null {
  const teammate = teammateFor(slug, scope);
  return teammate ? { name: teammate.name, summary: teammate.summary || BUILT_HERE } : null;
}

/** The names for a set of slugs, keyed by the slug as given. Slugs not on the roster are left out. */
export function teammateNamesFor(slugs: readonly string[], scope: TeammateNameScope): Record<string, TeammateName> {
  const out: Record<string, TeammateName> = {};
  for (const slug of slugs) {
    const name = teammateNameFor(slug, scope);
    if (name) out[slug] = name;
  }
  return out;
}

/**
 * The Workspace agents card's subtitle, built from the departments that have a
 * teammate answering in this workspace. It used to list all six to every
 * workspace, which a client's own Chief of Staff, Marketing and (missing)
 * Finance tabs contradicted.
 */
export function workspaceAgentsSubtitle(scope: TeammateNameScope): string {
  const labels = boundDepartmentLabels(scope);
  const inWords =
    labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const led = labels.length
    ? `A lead answers in each department's channel (${inWords}); the rest are teammates your team built.`
    : "No department has a lead yet; any teammate your team built is listed here.";
  return `The AI teammates this workspace runs. ${led} Core teammates are always on.`;
}
