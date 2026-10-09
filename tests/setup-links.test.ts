/**
 * Every "Set up / Connect / Add a key / Fix" button lands on the exact place
 * that fulfils it (lib/setup-links.ts).
 *
 * CC, 2026-10-09: "when you're on different pages and it tells you to set it
 * up, it's really mapping ... have proper processes in place to fulfill that."
 *
 * Four things are proved here, so a CTA cannot rot back into a dead link:
 *   1. every registry href resolves to an app route file;
 *   2. every #anchor in a registry href is an id in the file the registry names,
 *      and the settings pages that carry one mount OpenSectionOnHash (a
 *      fragment alone scrolls to a closed <details>);
 *   3. every connector:<slug> is a real catalog connector, in the registry and
 *      in every call site;
 *   4. nothing in components/ or app/ hardcodes a Settings / Connections href:
 *      the registry is the only place those strings live (allow-list below,
 *      each entry with its reason).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import {
  STATIC_SETUP_NEEDS,
  setupAnchorSource,
  setupAudience,
  setupHref,
  setupLink,
  viewerMaySetUp,
  type SetupNeed,
} from "../lib/setup-links";
import { CONNECTOR_CATALOG, connectorBySlug } from "../lib/os/connectors";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Every need the registry can answer: the static ones and one per catalog connector. */
const ALL_NEEDS: SetupNeed[] = [
  ...STATIC_SETUP_NEEDS,
  ...CONNECTOR_CATALOG.map((c) => `connector:${c.slug}` as SetupNeed),
];

function split(href: string): { path: string; query: string; hash: string } {
  const hashAt = href.indexOf("#");
  const hash = hashAt === -1 ? "" : href.slice(hashAt + 1);
  const rest = hashAt === -1 ? href : href.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  return { path: queryAt === -1 ? rest : rest.slice(0, queryAt), query: queryAt === -1 ? "" : rest.slice(queryAt + 1), hash };
}

function routeFile(path: string): string {
  return path === "/" ? "app/page.tsx" : `app${path}/page.tsx`;
}

test("every registry href resolves to an app route file", () => {
  for (const need of ALL_NEEDS) {
    const href = setupHref(need);
    assert.ok(href.startsWith("/"), `${need}: ${href} is not an in-app path`);
    const { path } = split(href);
    assert.ok(existsSync(join(ROOT, routeFile(path))), `${need}: ${href} has no route file at ${routeFile(path)}`);
  }
});

test("every #anchor is an id in the file the registry names", () => {
  let anchored = 0;
  for (const need of ALL_NEEDS) {
    const { hash, path } = split(setupHref(need));
    const source = setupAnchorSource(need);
    if (!hash) {
      assert.equal(source, null, `${need}: names an anchor source but its href has no #anchor`);
      continue;
    }
    anchored++;
    assert.ok(source, `${need}: ${hash} has no anchorIn file in lib/setup-links.ts`);
    assert.ok(existsSync(join(ROOT, source)), `${need}: anchorIn ${source} does not exist`);
    const text = readFileSync(join(ROOT, source), "utf8");
    assert.ok(new RegExp(`\\bid=["'{\`]*${hash}["'\`}]`).test(text), `${need}: #${hash} is not an id in ${source}`);

    // A settings section is a collapsed <details>; the browser scrolls to it
    // without opening it. The page must reach OpenSectionOnHash.
    if (source === "components/settings/SettingsContent.tsx") {
      assert.ok(text.includes("<OpenSectionOnHash"), `${source} must render OpenSectionOnHash for #${hash}`);
      assert.ok(read(routeFile(path)).includes("SettingsContent"), `${routeFile(path)} must render SettingsContent for #${hash}`);
    }
  }
  assert.ok(anchored >= 6, `expected the registry to carry its anchored needs, found ${anchored}`);
});

test("a settings anchor sits inside the section its page renders", () => {
  // /settings/<page>#id: the id must be in a SettingsSection shown for that
  // page's section prop (show("<section>") in SettingsContent).
  const content = read("components/settings/SettingsContent.tsx");
  for (const need of ALL_NEEDS) {
    const { path, hash } = split(setupHref(need));
    if (!hash || setupAnchorSource(need) !== "components/settings/SettingsContent.tsx") continue;
    const page = read(routeFile(path));
    const section = /section="([a-z-]+)"/.exec(page)?.[1];
    assert.ok(section, `${routeFile(path)} does not pass a section to SettingsContent`);
    // The attribute on its own line, not the same text quoted in a comment.
    const idAt = content.search(new RegExp(`^\\s+id="${hash}"\\s*$`, "m"));
    assert.ok(idAt !== -1, `#${hash} is not in SettingsContent`);
    // The nearest show("...") above the id is the gate that decides whether it renders.
    const gate = /show\("([a-z-]+)"\)/.exec(content.slice(content.lastIndexOf("show(\"", idAt)))?.[1];
    assert.equal(
      gate,
      section,
      `#${hash} is not under show("${section}") in SettingsContent, so ${path} would not render it`,
    );
  }
});

test("every connector need names a real catalog connector", () => {
  for (const c of CONNECTOR_CATALOG) {
    assert.equal(setupHref(`connector:${c.slug}` as SetupNeed), `/settings/connections?app=${encodeURIComponent(c.slug)}`);
  }
  // A slug the catalog lacks falls back to the hub, never to a drawer that opens nothing.
  assert.equal(connectorBySlug("not-a-connector"), null);
  assert.equal(setupHref("connector:not-a-connector"), setupHref("connections"));
});

/** Source files under dir, as repo-relative POSIX paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e)) out.push(relative(ROOT, full).split(sep).join("/"));
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const SCANNED = [...sourceFiles("components"), ...sourceFiles("app").filter((f) => !f.startsWith("app/api/"))];

test("every connector:<slug> in source is a real catalog connector", () => {
  const seen = new Set<string>();
  for (const file of [...SCANNED, ...sourceFiles("lib")]) {
    if (file === "lib/setup-links.ts") continue;
    for (const m of readFileSync(join(ROOT, file), "utf8").matchAll(/["'`]connector:([a-z0-9-]+)["'`]/g)) {
      seen.add(m[1]);
      assert.ok(connectorBySlug(m[1]), `${file}: connector:${m[1]} is not in the connectors catalog`);
    }
  }
  assert.ok(seen.size >= 3, `expected call sites to use connector needs, found ${[...seen].join(", ")}`);
});

/**
 * A CTA hardcodes a Settings destination when a string literal in these files
 * IS one: "/settings", "/settings/ai", "/settings#devices", "/settings/connections?app=x",
 * "/integrations". Files below own their own section or are the navigation
 * itself; each says why.
 */
const SETTINGS_HREF = /["'`]\/(settings|connections|integrations)(?=[/?#"'`])[^"'`]*["'`]/;

const ALLOW: ReadonlyArray<{ match: (file: string) => boolean; why: string }> = [
  { match: (f) => f.startsWith("app/settings/"), why: "the Settings pages themselves: their own back links, redirects and sibling-section links" },
  { match: (f) => f.startsWith("components/settings/"), why: "the Settings area: section nav, section list and in-section links (settings-sections.ts is the section registry)" },
  { match: (f) => f === "components/os/RailFooter.tsx", why: "the rail's permanent Settings and Connections destinations, not a setup CTA" },
  { match: (f) => f === "components/os/OsRail.tsx", why: "the rail's own navigation, not a setup call to action" },
  { match: (f) => f === "app/login/LoginForm.tsx" || f === "app/signup/page.tsx", why: "sign-in and sign-up return paths, not setup CTAs" },
  { match: (f) => f === "components/automations/AutomationsContent.tsx", why: "its Install bridge button is pinned to a literal href and a workspace gate by tests/f0-containment.test.ts (F0 containment); the registry's bridge_install holds the same href" },
  { match: (f) => f === "components/os/today/WorkspaceSetupPending.tsx", why: "pinned to import nothing from lib (tests/os-today.test.ts): it renders before any session read; /settings is the Profile page, which the registry calls business_profile" },
  { match: (f) => f.startsWith("app/onboarding/"), why: "the onboarding flow's own redirects" },
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

test("no component or page hardcodes a Settings / Connections href (use lib/setup-links.ts)", () => {
  const offenders: string[] = [];
  for (const file of SCANNED) {
    if (ALLOW.some((a) => a.match(file))) continue;
    stripComments(readFileSync(join(ROOT, file), "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (SETTINGS_HREF.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 110)}`);
      });
  }
  assert.deepEqual(offenders, [], `route these through lib/setup-links.ts:\n${offenders.join("\n")}`);
});

test("the allow-list does not outlive its files", () => {
  for (const a of ALLOW) {
    assert.ok(a.why.length > 20, "an allow-list entry needs a real reason");
    assert.ok(SCANNED.some((f) => a.match(f)), `allow-list entry matches no file any more: ${a.why}`);
  }
});

test("a viewer who cannot open the target is told who can, never linked to a refusal", () => {
  const member = { canManage: false, isOperator: false };
  const owner = { canManage: true, isOperator: false };
  const operator = { canManage: true, isOperator: true };

  // Owner-only settings.
  for (const need of ["ai_account", "ai_engine", "revenue_goal", "brand", "team", "connections", "connector:stripe", "connector:slack"] as SetupNeed[]) {
    assert.equal(setupAudience(need), "manage", `${need} is an owner's setting`);
    const asked = setupLink(need, member);
    assert.equal(asked.kind, "ask", `${need}: a member must not be linked to a page that refuses them`);
    if (asked.kind === "ask") assert.match(asked.text, /^Ask your workspace owner|^Ask OASIS/);
    const link = setupLink(need, owner);
    assert.equal(link.kind, "link");
    if (link.kind === "link") assert.equal(link.href, setupHref(need));
  }

  // The one app a member connects themselves.
  assert.equal(setupAudience("connector:google-workspace"), "everyone");
  assert.equal(setupLink("connector:google-workspace", member).kind, "link");

  // Devices are the verified operator's, not a workspace admin's.
  assert.equal(setupAudience("bridge_devices"), "operator");
  assert.equal(viewerMaySetUp("bridge_devices", owner), false);
  assert.equal(viewerMaySetUp("bridge_devices", operator), true);
  assert.equal(setupLink("bridge_devices", owner).kind, "ask");

  // Installing the bridge is the verified operator's alone (F0 containment).
  assert.equal(setupAudience("bridge_install"), "operator");
  assert.equal(setupLink("bridge_install", owner).kind, "ask");
  assert.equal(setupLink("bridge_install", operator).kind, "link");

  // The words on the button can be the surface's own.
  const custom = setupLink("ai_account", owner, "Add AI key");
  assert.deepEqual(custom, { kind: "link", href: setupHref("ai_account"), label: "Add AI key" });
});

test("no call to action points at n8n", () => {
  for (const need of ALL_NEEDS) {
    assert.ok(!/n8n/i.test(setupHref(need)), `${need} points at n8n`);
  }
  assert.equal(connectorBySlug("n8n"), null, "n8n is not a product connector");
  const offenders = SCANNED.filter((f) => /href=[^\n]*n8n/i.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(offenders, []);
});
