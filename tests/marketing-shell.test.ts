import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GROWTH_SECTIONS, MARKETING_SHELL_ACTIVE } from "../lib/founders/growth-shell";
import { FOUNDERS_PORTAL, portalForPath } from "../lib/portals/registry";

const root = join(__dirname, "..");
assert.equal(MARKETING_SHELL_ACTIVE, false, "Feature 1 stays operationally inactive");
assert.deepEqual(GROWTH_SECTIONS.map((x) => x.label), ["Overview", "Organic", "Paid Ads", "Outreach", "Account Connections"]);
assert.equal(new Set(GROWTH_SECTIONS.map((x) => x.href)).size, GROWTH_SECTIONS.length, "routes are unique");
for (const section of GROWTH_SECTIONS) {
  const relative = section.href === "/founders/growth" ? "app/founders/growth/page.tsx" : `app${section.href}/page.tsx`;
  assert.equal(existsSync(join(root, relative)), true, `${section.href} has a page`);
  assert.equal(portalForPath(relative), "founders", `${section.href} stays founders-owned`);
}
const founderLabels = FOUNDERS_PORTAL.sections.map((x) => x.label);
assert.equal(founderLabels.includes("Content"), true, "legacy studio is labelled Content");
assert.equal(founderLabels.includes("Marketing"), true, "new module is labelled Marketing");
const growthLayout = readFileSync(join(root, "app/founders/growth/layout.tsx"), "utf8");
assert.match(growthLayout, /resolveFounder/, "growth layout has its own founders gate");
assert.match(growthLayout, /notFound/, "unauthorized callers fail closed");
console.log("marketing-shell: all assertions passed");
