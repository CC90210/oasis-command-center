/**
 * robots.txt and sitemap must not drift from the marketing route registry.
 * Run: node --import tsx tests/robots-tiers.test.ts
 *
 * THREE PROPERTIES, ALL OF WHICH FAIL SILENTLY IN PRODUCTION
 *
 * 1. THE NAMED-GROUP TRAP. A crawler matching a named `User-agent` group
 *    ignores `User-agent: *` entirely — no merge, no inheritance. So the
 *    obvious two-line tier-2 group:
 *
 *        User-agent: GPTBot
 *        Allow: /
 *
 *    does not mean "GPTBot is welcome on the marketing pages". It means GPTBot
 *    may crawl the whole authenticated operator app, because every Disallow in
 *    the wildcard group vanished for that one crawler. Nothing errors. The only
 *    symptom is merchant data in someone's index. This test asserts every named
 *    tier-2 group carries a rule set IDENTICAL to the wildcard group.
 *
 * 2. REGISTRY DRIFT. Adding a page to lib/marketing/routes.ts publishes it to
 *    users but not to crawlers, and vice versa. Both directions are wrong and
 *    neither throws.
 *
 * 3. THE UNSUBSCRIBE LEAK. /unsubscribe carries the recipient's email in the
 *    query string. Indexing it publishes merchant addresses; following it fires
 *    opt-outs nobody requested. It must be disallowed in EVERY group.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert";
import { ALL_MARKETING_PATHS, CONTACT_EMAIL, MARKETING_HOME_PATH, SITE_ORIGIN } from "../lib/marketing/routes";
import { PAGES, sitemapPaths } from "../app/sitemap";

const robots = readFileSync(join(process.cwd(), "public", "robots.txt"), "utf8");
const llms = readFileSync(join(process.cwd(), "public", "llms.txt"), "utf8");

/**
 * Not pages, but what the pages need. Under `Disallow: /` each of these is
 * blocked unless allowed back by name, and every one of those blocks is silent:
 * - /llms.txt is the briefing this whole file exists to let AI crawlers read.
 * - /_next/static/ holds the CSS, JS and fonts; Google renders pages and marks
 *   them broken without it.
 * - /favicon.ico and /opengraph-image are what a search result and a shared
 *   link show.
 * - /sitemap.xml is referenced below; a crawler that obeys the Disallow cannot
 *   fetch the list of pages it is being pointed at.
 */
const ASSET_ALLOWS = ["/llms.txt", "/sitemap.xml", "/_next/static/", "/favicon.ico", "/opengraph-image"];

/** Parse into groups: user-agent list -> ordered rule lines. */
function parseGroups(text: string): { agents: string[]; rules: string[] }[] {
  const groups: { agents: string[]; rules: string[] }[] = [];
  let current: { agents: string[]; rules: string[] } | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value);
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      if (!current) continue;
      current.rules.push(`${key}:${value}`);
      lastWasAgent = false;
    }
  }
  return groups;
}

const groups = parseGroups(robots);
const byAgent = new Map<string, string[]>();
for (const g of groups) for (const a of g.agents) byAgent.set(a, g.rules);

const TIER2 = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "DuckAssistBot",
  "MistralAI-User",
];
const TIER3 = ["CCBot", "Bytespider", "anthropic-ai"];

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${(e as Error).message}`);
  }
}

const wildcard = byAgent.get("*");

check("a wildcard group exists", () => {
  assert.ok(wildcard && wildcard.length > 0, "no `User-agent: *` group with rules");
});

check("the wildcard group is default-deny", () => {
  assert.equal(wildcard![0], "disallow:/", "the first wildcard rule must be `Disallow: /`");
});

for (const agent of TIER2) {
  check(`tier-2 ${agent} restates the wildcard rules verbatim`, () => {
    const rules = byAgent.get(agent);
    assert.ok(rules, `no group for ${agent}`);
    assert.deepEqual(
      rules,
      wildcard,
      `${agent} does not carry the same rules as *. A named group does NOT inherit ` +
        `from the wildcard, so any difference here is a real exposure, not a style nit.`
    );
  });
}

for (const agent of TIER3) {
  check(`tier-3 ${agent} is fully blocked`, () => {
    assert.deepEqual(byAgent.get(agent), ["disallow:/"], `${agent} must be Disallow: / and nothing else`);
  });
}

check("every marketing route is allowed in every non-tier-3 group", () => {
  const expected = ALL_MARKETING_PATHS.map((p) => (p === MARKETING_HOME_PATH ? "/home" : p));
  for (const [agent, rules] of byAgent) {
    if (TIER3.includes(agent)) continue;
    for (const path of expected) {
      assert.ok(
        rules.includes(`allow:${path}`),
        `${agent} does not Allow ${path}, but lib/marketing/routes.ts publishes it`
      );
    }
  }
});

check("the AI briefing and the render assets are reachable in every non-tier-3 group", () => {
  for (const [agent, rules] of byAgent) {
    if (TIER3.includes(agent)) continue;
    for (const path of ASSET_ALLOWS) {
      assert.ok(
        rules.includes(`allow:${path}`),
        `${agent} cannot fetch ${path}: \`Disallow: /\` blocks it and nothing allows it back`
      );
    }
  }
});

check("no group allows a path that is not a public marketing route", () => {
  const allowed = new Set([...ALL_MARKETING_PATHS.map((p) => String(p)), "/", "/$", ...ASSET_ALLOWS]);
  for (const [agent, rules] of byAgent) {
    for (const r of rules) {
      if (!r.startsWith("allow:")) continue;
      const path = r.slice("allow:".length);
      assert.ok(
        allowed.has(path),
        `${agent} allows ${path}, which is not in lib/marketing/routes.ts. ` +
          `Everything else in this app is an authenticated surface holding merchant PII.`
      );
    }
  }
});

check("/unsubscribe is disallowed in every non-tier-3 group", () => {
  for (const [agent, rules] of byAgent) {
    if (TIER3.includes(agent)) continue;
    assert.ok(
      rules.includes("disallow:/unsubscribe"),
      `${agent} does not disallow /unsubscribe. That URL carries the recipient's ` +
        `email address in the query string.`
    );
  }
});

check("the API surface is disallowed in every non-tier-3 group", () => {
  for (const [agent, rules] of byAgent) {
    if (TIER3.includes(agent)) continue;
    assert.ok(rules.includes("disallow:/api/"), `${agent} does not disallow /api/`);
  }
});

check("Content-Signal is declared", () => {
  assert.match(robots, /^Content-Signal:\s*ai-train=no,\s*search=yes,\s*ai-input=yes$/m);
});

check("the sitemap is referenced", () => {
  assert.match(robots, /^Sitemap:\s*https:\/\/oasisai\.work\/sitemap\.xml$/m);
});

check("robots.txt has one source: public/robots.txt, never app/robots.ts beside it", () => {
  // Both answer /robots.txt. Which one a host serves is decided by the host, not
  // by us, and this test only reads the public file, so a second source would be
  // an unchecked policy that might be the live one.
  assert.ok(
    !existsSync(join(process.cwd(), "app", "robots.ts")),
    "app/robots.ts exists beside public/robots.txt. Delete it; the public file is the policy."
  );
});

/* ---------------------------------------------------------------- llms.txt */

check("llms.txt links every public page and nothing that is not one", () => {
  const linked = new Set(
    [...llms.matchAll(/\]\((https:\/\/oasisai\.work[^)]*)\)/g)].map((m) => new URL(m[1]).pathname)
  );
  for (const p of sitemapPaths()) {
    assert.ok(linked.has(p), `llms.txt does not link ${p}, which the sitemap publishes`);
  }
  for (const p of linked) {
    assert.ok(
      sitemapPaths().includes(p),
      `llms.txt links ${p}, which is not a public page. An assistant will send people to a 404.`
    );
  }
  assert.ok(llms.includes(SITE_ORIGIN.replace("https://", "")), "llms.txt must name the canonical domain");
});

check("llms.txt gives the same contact address as the site", () => {
  const addresses = new Set(llms.match(/[a-z0-9._-]+@oasisai\.work/gi) ?? []);
  assert.deepEqual(
    [...addresses],
    [CONTACT_EMAIL],
    `llms.txt publishes ${[...addresses].join(", ") || "no address"}; the site publishes ${CONTACT_EMAIL}`
  );
});

/* ------------------------------------------------------------------ sitemap */

check("the sitemap collapses /home to the canonical apex", () => {
  const paths = sitemapPaths();
  assert.ok(paths.includes("/"), "sitemap must list the apex");
  assert.ok(
    !paths.includes(MARKETING_HOME_PATH),
    "/home serves identical bytes to / and must not be listed separately"
  );
});

check("every sitemap path has explicit metadata including a lastmod", () => {
  for (const p of sitemapPaths()) {
    const meta = PAGES[p];
    assert.ok(
      meta,
      `no PAGES entry for ${p}. Add one in app/sitemap.ts — a missing entry would ` +
        `throw at build, and lastmod must never fall back to build time or every ` +
        `deploy tells crawlers all nine pages changed.`
    );
    assert.match(meta.lastmod, /^\d{4}-\d{2}-\d{2}$/, `${p} lastmod must be an explicit ISO date`);
    assert.ok(meta.priority > 0 && meta.priority <= 1, `${p} priority out of range`);
  }
});

check("PAGES has no entries for routes that no longer exist", () => {
  const live = new Set(sitemapPaths());
  for (const p of Object.keys(PAGES)) {
    assert.ok(live.has(p), `PAGES has a stale entry for ${p}`);
  }
});

check("lastmod is never the build date", () => {
  const today = new Date().toISOString().slice(0, 10);
  const all = Object.values(PAGES).map((m) => m.lastmod);
  assert.ok(
    !all.every((d) => d === today),
    "every lastmod equals today's date, which is what `new Date()` at build time looks like"
  );
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nrobots + sitemap parity: all checks passed");
