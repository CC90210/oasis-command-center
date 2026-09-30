/**
 * lib/os/teammate-names.ts - what Settings calls an agent: the department it
 * leads in THIS workspace, never the persona behind it.
 *
 * WHY. Settings > AI brain listed "Bravo", "Atlas", "Maven", "Aura", "Hermes",
 * "Solara" and "Helios" to every workspace, with copy about "C-suite agents"
 * and "the empire". Those are OASIS's internal agent names; a client's owner
 * should see the teammates the OS is built around (Chief of Staff, Sales,
 * Marketing, Client Success, Finance, Operations), and the AI Team roster
 * already names leads that way (components/os/aiteam/roster.ts). This gives
 * Settings the same answer, for the same workspace.
 *
 * THE SOURCE. A house agent that leads a department is named for the
 * department(s) it answers in the VIEWER's workspace: the binding table in
 * components/os/department/config.ts, read through departmentChannelFor with
 * the viewer's `oasis` flag, exactly as the roster and the /team/<dept> tabs
 * read it. So in OASIS's own workspace bravo is "Chief of Staff · Operations",
 * maven "Marketing" and atlas "Finance"; in a client's workspace those three
 * lead nothing (the client's Chief of Staff and Marketing tabs say "not set up
 * yet", and a client has no Finance tab at all), so they are named for their
 * job instead, and only Sales and Client Success carry department names. It
 * used to read OASIS's bindings for everyone, which put "Finance" on a client's
 * Settings next to a Finance tab that does not exist for them.
 *
 * House agents that lead no department are named for their job. A slug this
 * file does not know (an agent a workspace built itself) gets null: the caller
 * keeps the name its owner gave it.
 *
 * Pure: no session, no database. SettingsContent computes the map on the
 * server and hands plain data to the client cards.
 */
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { departmentChannelFor, departmentProfile } from "@/components/os/department/config";

export type TeammateName = { name: string; summary: string };

/** Which workspace the names are for: OASIS's own, or anyone else's. */
export type TeammateNameScope = { oasis: boolean };

/**
 * House agents named for what they do, used wherever the agent leads no
 * department in the viewer's workspace. bravo, maven and atlas lead
 * departments in OASIS's workspace and nowhere else, so these three labels are
 * what a client sees; none of them is a department name.
 */
const ROLE_NAMES: Readonly<Record<string, TeammateName>> = {
  bravo: { name: "General assistant", summary: "Plans, answers questions and drafts across the workspace." },
  maven: { name: "Content assistant", summary: "Drafts posts, campaigns and ad copy." },
  atlas: { name: "Money assistant", summary: "Answers questions about cash, invoices and budgets." },
  aura: { name: "Personal assistant", summary: "Home, habits and personal routines." },
  hermes: { name: "Commerce", summary: "Point of sale, EDI and chargebacks." },
  "life-preservation": { name: "Memory keeper", summary: "Guided interviews that keep a family's stories and voices." },
  lex: { name: "Contracts", summary: "Drafts and reviews contracts and ranks the risky clauses. Not a lawyer." },
  solara: { name: "Operations workflows", summary: "Back-office workflows and data collection." },
  helios: { name: "Outreach", summary: "Outreach, text follow-ups and closing calls." },
  codex: { name: "Build helper", summary: "Runs the work behind teammates you build." },
};

/** The departments with an AI teammate in this kind of workspace, in rail order. */
export function boundDepartmentLabels(scope: TeammateNameScope): string[] {
  return OS_DEPARTMENTS.filter((d) => departmentChannelFor(d.key, scope).kind === "agent").map((d) => d.label);
}

function departmentNames(scope: TeammateNameScope): ReadonlyMap<string, TeammateName> {
  const led = new Map<string, { labels: string[]; summary: string }>();
  for (const dept of OS_DEPARTMENTS) {
    const binding = departmentChannelFor(dept.key, scope);
    if (binding.kind !== "agent") continue;
    const slug = binding.agentSlug.toLowerCase();
    const entry = led.get(slug);
    if (entry) entry.labels.push(dept.label);
    else led.set(slug, { labels: [dept.label], summary: departmentProfile(dept.key).purpose });
  }
  return new Map([...led].map(([slug, v]) => [slug, { name: v.labels.join(" · "), summary: v.summary }]));
}

const DEPARTMENT_NAMES = {
  oasis: departmentNames({ oasis: true }),
  client: departmentNames({ oasis: false }),
} as const;

/** The department or job name for a house agent in this workspace, or null for one a workspace built itself. */
export function teammateNameFor(slug: string, scope: TeammateNameScope): TeammateName | null {
  const key = (slug || "").trim().toLowerCase();
  const byDepartment = scope.oasis ? DEPARTMENT_NAMES.oasis : DEPARTMENT_NAMES.client;
  return byDepartment.get(key) ?? ROLE_NAMES[key] ?? null;
}

/** The names for a set of slugs, keyed by the slug as given. Unknown slugs are left out. */
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
 * teammate in this workspace. It used to list all six to every workspace,
 * which a client's own Chief of Staff, Marketing and (missing) Finance tabs
 * contradicted.
 */
export function workspaceAgentsSubtitle(scope: TeammateNameScope): string {
  const labels = boundDepartmentLabels(scope);
  const inWords =
    labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  const led = labels.length
    ? `Each is named for the department it leads here (${inWords}) or, if it leads none, for its job.`
    : "Each is named for its job.";
  return `The AI teammates this workspace runs. ${led} Core teammates are always on.`;
}
