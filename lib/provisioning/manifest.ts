/**
 * lib/provisioning/manifest.ts - the manifest OASIS writes when it sets up a
 * client workspace. PURE: tests/admin-installs.test.ts checks every field.
 *
 * What it holds, and why so little:
 *   brand     the workspace's own name. No tagline we would have to invent:
 *             the footer says who set it up, which is a fact.
 *   agents    the neutral department teammates (lib/provisioning/team.ts).
 *   os        the departments and opt-in modules chosen (a record, not a grant).
 *   integrations.chat_apps / jev  what the operator recorded for "Where does
 *             the team talk?" and the fast classifier. Jev defaults to "off".
 *   no data model, no prompts, every machine permission off. Those arrive when
 *             the workspace's own pages and routines are built for it.
 */

import {
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  type ManifestAgentBinding,
  type ManifestChatApp,
  type ManifestJevMode,
  type TenantManifest,
} from "@/lib/manifest/schema";
import type { DepartmentKey, ModuleKey } from "@/lib/os/types";
import { DEPARTMENT_TEAMMATE_SLUGS, modulesForSetup, neutralTeamFor } from "@/lib/provisioning/team";

export type ProvisionedManifestInput = {
  slug: string;
  name: string;
  departments: readonly DepartmentKey[];
  modules: readonly ModuleKey[];
  chatApps?: readonly ManifestChatApp[];
  jev?: ManifestJevMode;
  /** ISO time; injectable so tests are deterministic. */
  now?: string;
};

export function buildProvisionedManifest(input: ProvisionedManifestInput): TenantManifest {
  const now = input.now ?? new Date().toISOString();
  const name = input.name.trim().slice(0, 120);
  const manifest: TenantManifest = {
    version: 1,
    tenant_slug: input.slug,
    brand: {
      name,
      logo: "oasis",
      subtitle: "Workspace",
      footer_label: `${name} · OASIS OS`,
      footer_tagline: "Set up by OASIS.",
    },
    agents: neutralTeamFor(input.departments),
    nav: [
      { group: "Workspace", href: "/", label: "Today", icon: "LayoutDashboard" },
      { group: "Workspace", href: "/settings", label: "Settings", icon: "Settings" },
    ],
    data_model: [],
    default_prompts: [],
    permissions: { local_files: false, computer_control: false, web_access: false },
    onboarding_industry: "custom",
    ui: { advanced_picker: false },
    integrations: {
      chat_apps: [...(input.chatApps ?? [])],
      jev: input.jev ?? "off",
    },
    os: { departments: [...input.departments], modules: modulesForSetup(input.departments, input.modules) },
    meta: { created_at: now, updated_at: now, schema_version: MANIFEST_SCHEMA_VERSION },
  };
  // Round-trip through the parser: anything the schema would refuse fails here,
  // before a provisioning run records a step it cannot finish.
  return parseManifest(manifest);
}

/**
 * "Set up again" on a workspace that already has a setup (2026-09-30, fix pass).
 *
 * The first version saved `built` over the stored manifest whole, so the
 * workspace lost its own tagline, pages, data model, saved prompts and any
 * teammate it had added, and the audit diff was taken against the empty
 * placeholder, so nothing recorded the loss (tenant_manifests keeps one row).
 *
 * What the operator's choices own, and so replace:
 *   os                       the departments and add-ons;
 *   integrations.chat_apps   "Where does the team talk?";
 *   integrations.jev         the fast classifier;
 *   department teammates     the neutral agents lib/provisioning/team.ts binds
 *                            to departments. One that stays keeps its stored
 *                            binding (a name the owner gave it, enabled or
 *                            not) but leads the departments chosen now (its
 *                            `departments`, W4a: a stored binding from before
 *                            that field would otherwise lead nothing); one
 *                            whose department was removed goes.
 * Everything else is the workspace's own and is kept as stored: brand, nav,
 * pages, data_model, default_prompts, permissions, connectors, tier, ui, and
 * every teammate that is not a department teammate.
 *
 * One primary: the stored primary stays primary while it is still in the
 * team; otherwise the first teammate is.
 */
export function mergeProvisionedManifest(stored: TenantManifest, built: TenantManifest): TenantManifest {
  const storedBySlug = new Map(stored.agents.map((a) => [a.slug, a]));
  const team: ManifestAgentBinding[] = built.agents.map((a) => {
    const prev = storedBySlug.get(a.slug);
    return prev ? { ...prev, departments: [...(a.departments ?? [])] } : { ...a };
  });
  const own = stored.agents.filter((a) => !DEPARTMENT_TEAMMATE_SLUGS.has(a.slug)).map((a) => ({ ...a }));
  const agents = [...team, ...own];
  const storedPrimary = stored.agents.find((a) => a.primary)?.slug;
  const primarySlug = agents.some((a) => a.slug === storedPrimary) ? storedPrimary : agents[0]?.slug;
  const merged: TenantManifest = {
    ...stored,
    agents: agents.map((a) => {
      const { primary: _primary, ...rest } = a;
      return a.slug === primarySlug ? { ...rest, primary: true } : _primary === undefined ? rest : { ...rest, primary: false };
    }),
    integrations: {
      ...(stored.integrations ?? {}),
      chat_apps: [...(built.integrations?.chat_apps ?? [])],
      jev: built.integrations?.jev ?? "off",
    },
    os: built.os,
    meta: { ...stored.meta, updated_at: built.meta.updated_at },
  };
  return parseManifest(merged);
}
