import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");
const toolbar = read("components/leads/LeadActionToolbar.tsx");
const lifecycle = read("app/pipeline/[id]/LeadLifecycleActions.tsx");
const callRoute = read("app/api/leads/[id]/call/route.ts");
const kixie = read("lib/integrations/kixie.ts");
const store = read("lib/tenant-integration-store.ts");

assert.match(toolbar, /href=\{`tel:\$\{dialTarget\}`\}/);
assert.match(toolbar, /onClick=\{onDialerOpened\}/);
assert.doesNotMatch(
  toolbar,
  /fetch\(`\/api\/leads\/\$\{leadId\}\/call`/,
  "the OASIS lead action must not invoke a shared calling account",
);
assert.match(lifecycle, /onDialerOpened=\{\(\) => \{[\s\S]*?setCallAccepted\(true\)/);
assert.match(callRoute, /isOasisSurfaceTenant\(String\(tenant\.data\.slug\)\)/);
assert.match(callRoute, /getKixieCredentials\(tenantId, \{ allowEnvFallback \}\)/);
assert.match(kixie, /getTenantIntegrationBundle\(tenantId, "kixie", options\)/);
assert.match(store, /if \(options\.allowEnvFallback !== false\) \{/);

console.log("oasis call isolation tests passed");
