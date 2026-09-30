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

import { MANIFEST_SCHEMA_VERSION, parseManifest, type ManifestChatApp, type ManifestJevMode, type TenantManifest } from "@/lib/manifest/schema";
import type { DepartmentKey, ModuleKey } from "@/lib/os/types";
import { modulesForSetup, neutralTeamFor } from "@/lib/provisioning/team";

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
