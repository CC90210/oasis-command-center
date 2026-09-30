/**
 * lib/provisioning/team.ts - what a client workspace's AI team is made of, from
 * the departments OASIS (or the owner, in the onboarding wizard) chose.
 *
 * PURE. No session, no database: the operator console, the provisioning run
 * and the onboarding wizard all build the same team from the same answer, and
 * tests/admin-installs.test.ts checks it in bare node.
 *
 * NEUTRAL BY CONSTRUCTION. A client never gets an OASIS house agent (the
 * personas that run OASIS itself) or a SunBiz one. Each department's teammate is
 * whatever components/os/department/config.ts binds that department to in a
 * workspace that is not OASIS's own (today: Sales -> the `sdr` library
 * template, Client Success -> `customer-support`; both prompts name only the
 * client's own brand). A department with no neutral agent yet gets no
 * teammate, and its channel says "not set up" rather than borrowing one.
 * Teammates are named for their department ("Sales lead"), never for the agent.
 */

import { departmentChannelFor } from "@/components/os/department/config";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import type { ManifestAgentBinding } from "@/lib/manifest/schema";
import type { DepartmentKey, ModuleKey } from "@/lib/os/types";

/** Every department, in rail order. Chief of Staff is always part of a workspace. */
export const PROVISION_DEPARTMENT_KEYS: readonly DepartmentKey[] = OS_DEPARTMENTS.map((d) => d.key);

/** The departments a new workspace starts with when nobody chose otherwise. */
export const DEFAULT_DEPARTMENTS: readonly DepartmentKey[] = ["chief_of_staff", "sales", "marketing", "client_success"];

/**
 * Opt-in modules a client workspace may ask for. `enablement`, `prospects` and
 * `commissions` are OASIS's own sales-team tools and are not offered. Choosing
 * one records the request (manifest.os.modules); lib/os/modules.ts decides what
 * the rail actually shows.
 */
export const OPT_IN_MODULES: ReadonlyArray<{ key: ModuleKey; label: string; description: string }> = [
  { key: "content", label: "Content", description: "Posts, a content calendar and drafts." },
  { key: "ads", label: "Ads", description: "Campaign tracking for paid ads." },
  { key: "research", label: "Research", description: "Market and competitor notes." },
  { key: "legal", label: "Legal", description: "Contracts and policies in one place." },
  { key: "meetings", label: "Meetings", description: "Call notes and follow-ups." },
  { key: "portal", label: "Client portal", description: "A page your own clients sign in to." },
];

const DEPARTMENT_SET: ReadonlySet<string> = new Set(PROVISION_DEPARTMENT_KEYS);
const MODULE_SET: ReadonlySet<string> = new Set(OPT_IN_MODULES.map((m) => m.key));

/**
 * Clean an untrusted department list: known keys only, rail order, no repeats,
 * and Chief of Staff always included (it is the Ask button's target).
 */
export function normalizeDepartments(input: unknown): DepartmentKey[] {
  const picked = new Set<string>(["chief_of_staff"]);
  if (Array.isArray(input)) {
    for (const v of input) if (typeof v === "string" && DEPARTMENT_SET.has(v)) picked.add(v);
  }
  return PROVISION_DEPARTMENT_KEYS.filter((k) => picked.has(k));
}

/** Clean an untrusted module list: opt-in modules only, no repeats, list order. */
export function normalizeModules(input: unknown): ModuleKey[] {
  const picked = new Set<string>();
  if (Array.isArray(input)) {
    for (const v of input) if (typeof v === "string" && MODULE_SET.has(v)) picked.add(v);
  }
  return OPT_IN_MODULES.map((m) => m.key).filter((k) => picked.has(k));
}

/**
 * The modules to record for a setup: the opt-in add-ons chosen, plus the
 * module a chosen department needs to appear (Finance needs `finance`; see
 * lib/os/departments.ts). Finance is not offered as a separate add-on because
 * choosing the department IS asking for it.
 */
export function modulesForSetup(departments: readonly DepartmentKey[], modules: readonly ModuleKey[]): ModuleKey[] {
  const out = [...modules];
  for (const dept of OS_DEPARTMENTS) {
    if (dept.module && departments.includes(dept.key) && !out.includes(dept.module)) out.push(dept.module);
  }
  return out;
}

/**
 * The manifest agents for these departments. One binding per neutral agent
 * (an agent that leads two departments is listed once, under the first), the
 * first one primary. No tool_palette: a client agent's missing palette is "no
 * tools" (lib/manifest/schema.ts resolveAgentToolPalette).
 */
export function neutralTeamFor(departments: readonly DepartmentKey[]): ManifestAgentBinding[] {
  const out: ManifestAgentBinding[] = [];
  for (const dept of OS_DEPARTMENTS) {
    if (!departments.includes(dept.key)) continue;
    const binding = departmentChannelFor(dept.key, { oasis: false });
    if (binding.kind !== "agent") continue;
    if (out.some((a) => a.slug === binding.agentSlug)) continue;
    out.push({ slug: binding.agentSlug, display_name: `${dept.label} lead`, enabled: true, primary: out.length === 0 });
  }
  return out;
}

/**
 * Every agent some department can bind as its teammate. On "Set up again" these
 * are the teammates the operator's department choice owns; any other agent in a
 * stored manifest is one the workspace added itself and is kept
 * (lib/provisioning/manifest.ts mergeProvisionedManifest).
 */
export const DEPARTMENT_TEAMMATE_SLUGS: ReadonlySet<string> = new Set(
  neutralTeamFor(PROVISION_DEPARTMENT_KEYS).map((a) => a.slug),
);

/** Department labels for display ("Chief of Staff, Sales"). */
export function departmentLabels(departments: readonly DepartmentKey[]): string[] {
  return OS_DEPARTMENTS.filter((d) => departments.includes(d.key)).map((d) => d.label);
}

/**
 * Add-on labels for display ("Content, Client portal"), never the module keys:
 * the setup steps are shown to the client on their setup page.
 */
export function moduleLabels(modules: readonly ModuleKey[]): string[] {
  return OPT_IN_MODULES.filter((m) => modules.includes(m.key)).map((m) => m.label);
}
