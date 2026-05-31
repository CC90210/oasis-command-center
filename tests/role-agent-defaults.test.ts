/**
 * Tests for lib/role-agent-defaults. This module is NOT server-only
 * — it's a pure function with no Supabase calls — so we can import
 * + invoke it directly here.
 *
 * Locks the SunBiz role-to-agent matrix from the product decision
 * (TOMORROW.md item #5). A drift here means new hires get the wrong
 * agent palette on first sign-in.
 */

import assert from "node:assert/strict";
import { defaultAgentsForRole } from "../lib/role-agent-defaults";
import type { TenantManifest } from "../lib/manifest/schema";

function sunbizManifest(): TenantManifest {
  return {
    version: 1,
    tenant_slug: "sun",
    brand: {
      name: "SunBiz",
      logo: "sunbiz",
      subtitle: "Funding",
      footer_label: "SunBiz",
      footer_tagline: "",
    },
    agents: [
      { slug: "solara", display_name: "Solara", enabled: true, primary: true },
      { slug: "helios", display_name: "Helios", enabled: true },
    ],
    nav: [],
    data_model: [],
    data_backend: "supabase",
    deployment_mode: "dedicated",
    permissions: { local_files: false, computer_control: false, web_access: true },
    settings: {},
  } as unknown as TenantManifest;
}

// SunBiz role matrix (TOMORROW.md item #5).
const SUN = "sun";
const M = sunbizManifest();

assert.deepEqual(
  defaultAgentsForRole({ tenantSlug: SUN, role: "owner", manifest: M }),
  ["solara", "helios"],
  "SunBiz owner gets both",
);
assert.deepEqual(
  defaultAgentsForRole({ tenantSlug: SUN, role: "admin", manifest: M }),
  ["solara", "helios"],
  "SunBiz admin gets both",
);
assert.deepEqual(
  defaultAgentsForRole({ tenantSlug: SUN, role: "loan_officer", manifest: M }),
  ["solara", "helios"],
  "SunBiz loan_officer gets both",
);
assert.deepEqual(
  defaultAgentsForRole({ tenantSlug: SUN, role: "processor", manifest: M }),
  ["solara"],
  "SunBiz processor gets Solara only (no sales voice)",
);
assert.deepEqual(
  defaultAgentsForRole({ tenantSlug: SUN, role: "read_only", manifest: M }),
  ["solara"],
  "SunBiz read_only gets Solara only",
);
assert.deepEqual(
  defaultAgentsForRole({ tenantSlug: SUN, role: "member", manifest: M }),
  ["solara"],
  "SunBiz member gets Solara only",
);

// Cross-tenant: same SunBiz role list when tenant slug is its alias.
assert.deepEqual(
  defaultAgentsForRole({ tenantSlug: "submissions", role: "owner", manifest: M }),
  ["solara", "helios"],
  "SunBiz tenant alias 'submissions' shares the SunBiz policy",
);

// Unknown tenant slug falls through to manifest primary.
assert.deepEqual(
  defaultAgentsForRole({ tenantSlug: "hermes", role: "owner", manifest: M }),
  ["solara"],
  "unknown tenant falls back to manifest primary",
);

// No manifest + no policy = empty array.
assert.deepEqual(
  defaultAgentsForRole({ tenantSlug: "unknown", role: "owner", manifest: null }),
  [],
  "no manifest + no policy = empty",
);

console.log("role-agent-defaults ok (8 cases)");
