/**
 * lib/os/teammate-names.ts - what Settings calls an agent: the department it
 * leads, never the persona behind it.
 *
 * WHY. Settings > AI brain listed "Bravo", "Atlas", "Maven", "Aura", "Hermes",
 * "Solara" and "Helios" to every workspace, with copy about "C-suite agents"
 * and "the empire". Those are OASIS's internal agent names; a client's owner
 * should see the teammates the OS is built around (Chief of Staff, Sales,
 * Marketing, Client Success, Finance, Operations), and the AI Team roster
 * already names leads that way (components/os/aiteam/roster.ts). This gives
 * Settings the same answer.
 *
 * THE SOURCE. A house agent that leads a department is named for the
 * department(s) it answers in OASIS's own workspace: the binding table in
 * components/os/department/config.ts, read through departmentChannelFor, so a
 * re-binding there renames it here. House agents that lead no department are
 * named for their job. A slug this file does not know (an agent a workspace
 * built itself) gets null: the caller keeps the name its owner gave it.
 *
 * Pure: no session, no database. SettingsContent computes the map on the
 * server and hands plain data to the client cards.
 */
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { departmentChannelFor, departmentProfile } from "@/components/os/department/config";

export type TeammateName = { name: string; summary: string };

/** House agents with no department, named for what they do. */
const ROLE_NAMES: Readonly<Record<string, TeammateName>> = {
  aura: { name: "Personal assistant", summary: "Home, habits and personal routines." },
  hermes: { name: "Commerce", summary: "Point of sale, EDI and chargebacks." },
  "life-preservation": { name: "Memory keeper", summary: "Guided interviews that keep a family's stories and voices." },
  lex: { name: "Contracts", summary: "Drafts and reviews contracts and ranks the risky clauses. Not a lawyer." },
  solara: { name: "Operations workflows", summary: "Back-office workflows and data collection." },
  helios: { name: "Outreach", summary: "Outreach, text follow-ups and closing calls." },
  codex: { name: "Build helper", summary: "Runs the work behind teammates you build." },
};

const DEPARTMENT_NAMES: ReadonlyMap<string, TeammateName> = (() => {
  const led = new Map<string, { labels: string[]; summary: string }>();
  for (const dept of OS_DEPARTMENTS) {
    const binding = departmentChannelFor(dept.key, { oasis: true });
    if (binding.kind !== "agent") continue;
    const slug = binding.agentSlug.toLowerCase();
    const entry = led.get(slug);
    if (entry) entry.labels.push(dept.label);
    else led.set(slug, { labels: [dept.label], summary: departmentProfile(dept.key).purpose });
  }
  return new Map([...led].map(([slug, v]) => [slug, { name: v.labels.join(" · "), summary: v.summary }]));
})();

/** The department or job name for a house agent, or null for one a workspace built itself. */
export function teammateNameFor(slug: string): TeammateName | null {
  const key = (slug || "").trim().toLowerCase();
  return DEPARTMENT_NAMES.get(key) ?? ROLE_NAMES[key] ?? null;
}

/** The names for a set of slugs, keyed by the slug as given. Unknown slugs are left out. */
export function teammateNamesFor(slugs: readonly string[]): Record<string, TeammateName> {
  const out: Record<string, TeammateName> = {};
  for (const slug of slugs) {
    const name = teammateNameFor(slug);
    if (name) out[slug] = name;
  }
  return out;
}
