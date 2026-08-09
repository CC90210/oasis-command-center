import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clairEnabledForTenantSlug } from "../lib/clair/tenant-access";

assert.equal(clairEnabledForTenantSlug("sun"), true, "SunBiz keeps CLAIR");
assert.equal(clairEnabledForTenantSlug("SUN"), true, "SunBiz slug matching is normalized");
assert.equal(clairEnabledForTenantSlug("oasis"), false, "OASIS does not expose CLAIR");
assert.equal(clairEnabledForTenantSlug("oasis-ai-cc"), false, "OASIS aliases do not expose CLAIR");

const pipeline = fs.readFileSync(path.join(process.cwd(), "app/pipeline/[id]/page.tsx"), "utf8");
assert.doesNotMatch(pipeline, /ClairReportPanel/, "the OASIS lead detail page has no CLAIR pull UI");

const route = fs.readFileSync(path.join(process.cwd(), "app/api/leads/[id]/clair-report/route.ts"), "utf8");
assert.match(route, /clairAvailableForTenant\(auth\.tenantId\)/, "the CLAIR API enforces tenant availability");

console.log("clair tenant access tests passed");
