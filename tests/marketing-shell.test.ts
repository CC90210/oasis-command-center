import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GROWTH_SECTIONS, MARKETING_SHELL_ACTIVE } from "../lib/founders/growth-shell";
import { OS_NAV_CATALOG } from "../lib/os/nav";
import { FOUNDERS_NAV, FOUNDERS_PORTAL, portalForPath } from "../lib/portals/registry";

const root = join(__dirname, "..");
assert.equal(MARKETING_SHELL_ACTIVE, false, "Feature 1 stays operationally inactive");
assert.deepEqual(GROWTH_SECTIONS.map((x) => x.label), ["Overview", "Organic", "Paid Ads", "Outreach", "Account Connections"]);
assert.equal(new Set(GROWTH_SECTIONS.map((x) => x.href)).size, GROWTH_SECTIONS.length, "routes are unique");
for (const section of GROWTH_SECTIONS) {
  const relative = section.href === "/founders/growth" ? "app/founders/growth/page.tsx" : `app${section.href}/page.tsx`;
  assert.equal(existsSync(join(root, relative)), true, `${section.href} has a page`);
  assert.equal(portalForPath(relative), "founders", `${section.href} stays founders-owned`);
}
// ── one name for the hub at /founders/marketing, and it is "Content" ──────────
// CC, 2026-08-13: "For some reason, there's a duplication... There are now two
// tabs for this: Content and Marketing." The assertions this replaces pinned
// that exact pair as correct, so the defect could not have been caught here.
//
// What is actually invariant is not a pair of strings — it is that the nav never
// offers two destinations under the same name, and that every writer calls one
// route by one name. There are TWO writers for /founders/marketing: FOUNDERS_NAV
// (the founders chips and the manifest-shell rows) and OS_NAV_CATALOG (the OS
// rail and its breadcrumb). This test read only the first, so they drifted —
// the rail said "Content" while the page, its <title> and its chips said
// "Marketing" — until CC settled on "Content" for the hub on 2026-10-01. Both
// checks hold on either side of the Feature 1 switch, so this keeps testing
// something once APEX flips it.
const HUB = "/founders/marketing";
const founderLabels = FOUNDERS_PORTAL.sections.map((x) => x.label);
assert.equal(
  new Set(founderLabels).size,
  founderLabels.length,
  `two founders sections share a label: ${founderLabels.join(", ")} — that is the duplicate-tab bug`,
);
const hubNav = FOUNDERS_NAV.find((n) => n.href === HUB);
const hubRail = OS_NAV_CATALOG.find((e) => e.href === HUB);
assert.ok(hubNav, "the founders nav has the hub");
assert.ok(hubRail, "the OS rail catalog has the hub");
assert.equal(hubNav!.label, "Content", "the hub is called Content (CC, 2026-10-01)");
assert.equal(
  hubRail!.label,
  hubNav!.label,
  `the OS rail calls ${HUB} "${hubRail!.label}" but the founders nav calls it "${hubNav!.label}" — the second writer drifted`,
);
assert.deepEqual(
  FOUNDERS_PORTAL.sections.filter((s) => s.label === "Content").map((s) => s.href),
  [HUB],
  "exactly one founders section is called Content, and it is the hub",
);
assert.equal(OS_NAV_CATALOG.filter((e) => e.label === "Content").length, 1, "the rail has one Content row");
const marketingLabelled = FOUNDERS_PORTAL.sections.filter((s) => s.label === "Marketing");

if (MARKETING_SHELL_ACTIVE) {
  assert.deepEqual(marketingLabelled.map((s) => s.href), ["/founders/growth"], "active: Marketing is the growth module");
} else {
  // Inactive is the state that shipped broken, so it gets the sharper checks.
  assert.deepEqual(
    marketingLabelled,
    [],
    "inactive: nothing in the founders nav is called Marketing — the hub is Content and the growth shell is absent",
  );
  assert.equal(
    FOUNDERS_PORTAL.sections.some((s) => s.href.startsWith("/founders/growth")),
    false,
    "inactive: the growth shell must be ABSENT from the nav, not merely enabled:false — " +
      "a disabled section still renders as a greyed chip, which is still a second tab",
  );
}

// ── the sidebar and the header chips cannot disagree ──────────────────────────
// app/layout.tsx renders FOUNDERS_NAV; app/founders/layout.tsx renders
// FOUNDERS_PORTAL.sections. They drifted apart in #175 because each carried its
// own hardcoded list. Structurally they are now one list — this proves it stays
// that way, and that app/layout.tsx has not grown a second copy.
for (const item of FOUNDERS_NAV) {
  const section = FOUNDERS_PORTAL.sections.find((s) => s.href === item.href);
  assert.ok(section, `sidebar links ${item.href} but the header has no such section`);
  assert.equal(
    section!.label,
    item.label,
    `sidebar calls ${item.href} "${item.label}" but the header calls it "${section!.label}"`,
  );
}
const rootLayout = readFileSync(join(root, "app/layout.tsx"), "utf8");
assert.match(rootLayout, /FOUNDERS_NAV/, "the sidebar must read FOUNDERS_NAV");
assert.equal(
  /group: "Founders", href: "\/founders\//.test(rootLayout),
  false,
  "app/layout.tsx hardcodes a founders nav row again — that is how the two navs drifted apart",
);
const growthLayout = readFileSync(join(root, "app/founders/growth/layout.tsx"), "utf8");
assert.match(growthLayout, /resolveFounder/, "growth layout has its own founders gate");
assert.match(growthLayout, /notFound/, "unauthorized callers fail closed");
console.log("marketing-shell: all assertions passed");
