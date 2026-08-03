import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import {
  COMPOSITION_ROOTS,
  FOUNDERS_PORTAL,
  KNOWN_BOUNDARY_DEBT,
  PORTALS,
  isCompositionRoot,
  isImportAllowed,
  isSharedPath,
  portalForPath,
} from "../lib/portals/registry";

/**
 * PORTALS MUST NOT DEPEND ON EACH OTHER. This test is the enforcement.
 *
 * Adon, 2026-08-03: "Those are two very separate pieces of software... It's
 * about separation. We need to ensure that there's no data leakage. We're going
 * to be hosting different industries on this command center but within the
 * command center itself there are going to be different applications for
 * different industries... going forward when we add real estate there's a
 * different portal."
 *
 * WHY A STATIC TEST AND NOT A CONVENTION. Same reasoning as
 * tests/clair-manual-only.test.ts: the property being defended ("no file in one
 * portal reaches into another") is a property of the WHOLE TREE and cannot be
 * established by exercising any single function. A convention in a README
 * cannot fail a build. This can.
 *
 * It also makes "push this to SunBiz" a checkable instruction rather than a
 * vibe: a change belongs to a portal when every path it touches is owned by
 * that portal or is shared.
 */

const ROOT = join(__dirname, "..");
const SOURCE_DIRS = ["app", "lib", "components"];
const SOURCE_EXT = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__pycache__"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));
const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/");

/** `@/lib/founders/gate` -> `lib/founders/gate`. Only alias imports resolve to
 *  repo paths; relative and package imports are out of scope for this rule. */
function resolveAliasImport(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  return spec.slice(2);
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const violations: string[] = [];
const seenEdges = new Set<string>();
let edgesChecked = 0;

for (const file of files) {
  const from = rel(file);
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(IMPORT_RE)) {
    const target = resolveAliasImport(m[1]);
    if (!target) continue;
    edgesChecked += 1;
    seenEdges.add(`${from}|${target}`);
    const verdict = isImportAllowed(from, target);
    if (!verdict.allowed) {
      violations.push(`  ${from}\n    -> @/${target}\n    ${verdict.reason}`);
    }
  }
}

// ── anti-vacuity ─────────────────────────────────────────────────────
// A scan that silently found nothing would PASS and prove nothing. Straight
// from tests/clair-manual-only.test.ts: a broken walk must fail, not pass.
assert.ok(
  files.length > 500,
  `only ${files.length} source files walked — the scan is broken, so a clean result is meaningless`,
);
assert.ok(
  edgesChecked > 500,
  `only ${edgesChecked} alias imports seen — the import regex is broken, so a clean result is meaningless`,
);
assert.ok(
  files.some((f) => rel(f).startsWith("app/founders/")),
  "the walk never reached app/founders/ — it cannot be proving anything about the founders portal",
);
assert.ok(
  files.some((f) => rel(f).startsWith("lib/lenders/")),
  "the walk never reached lib/lenders/ — it cannot be proving anything about SunBiz",
);

assert.equal(
  violations.length,
  0,
  `Portal boundary violations (${violations.length}):\n${violations.join("\n")}\n\n` +
    `Portals must not import each other. If the code is genuinely common to both,\n` +
    `move it to shared infrastructure and add its prefix to SHARED_PREFIXES in\n` +
    `lib/portals/registry.ts — deliberately, not incidentally.`,
);

// ── the debt list must not rot ───────────────────────────────────────
// Every grandfathered entry has to still be a real edge in the tree. When
// someone fixes one, this fails until the entry is deleted — otherwise a stale
// allowlist silently re-permits the import years later.
for (const debt of KNOWN_BOUNDARY_DEBT) {
  assert.ok(
    seenEdges.has(`${debt.from}|${debt.to}`),
    `KNOWN_BOUNDARY_DEBT lists ${debt.from} -> @/${debt.to}, but that import no longer exists.\n` +
      `It was fixed — delete the entry from lib/portals/registry.ts so the boundary is enforced again.`,
  );
  assert.ok(
    debt.reason.length > 80,
    `Boundary debt ${debt.from} -> ${debt.to} needs a real reason, not a placeholder`,
  );
}

// ── composition roots: few, findable, and real ───────────────────────
// These are the ONLY files allowed to cross the boundary. The list staying
// short is what keeps the rule meaningful — if it grows, the boundary has
// stopped being one.
assert.ok(
  COMPOSITION_ROOTS.length <= 3,
  `${COMPOSITION_ROOTS.length} composition roots is too many — each is a permanent hole in the boundary`,
);
for (const root of COMPOSITION_ROOTS) {
  assert.ok(
    root.startsWith("lib/portals/"),
    `composition root ${root} must live under lib/portals/ so every boundary crossing is findable in one place`,
  );
  assert.ok(
    files.some((f) => rel(f) === root),
    `composition root ${root} is declared but does not exist`,
  );
  assert.equal(portalForPath(root), null, `composition root ${root} must not be owned by a portal`);
}
assert.equal(isCompositionRoot("lib/portals/stage-hooks.ts"), true);
assert.equal(
  isCompositionRoot("lib/manifest/data.ts"),
  false,
  "shared infrastructure is not a composition root — that was the original bug",
);

// The fix itself: the shared record layer must no longer reach into SunBiz.
{
  const dataTs = files.find((f) => rel(f) === "lib/manifest/data.ts");
  assert.ok(dataTs, "lib/manifest/data.ts should exist");
  const src = readFileSync(dataTs!, "utf8");
  // Match an IMPORT, not a mention: the file carries a comment explaining why
  // the old import was removed, and that comment is worth keeping.
  assert.ok(
    !/(?:from|import)\s*\(?\s*["']@\/lib\/drips\//.test(src),
    "lib/manifest/data.ts imports @/lib/drips/ again — the generic multi-tenant record layer " +
      "must not depend on SunBiz's drip engine. Route it through lib/portals/stage-hooks.ts.",
  );
  assert.ok(
    src.includes("runStageTransitionHooks"),
    "lib/manifest/data.ts must still run the stage-transition hooks — dropping the call " +
      "silently stops drip cancellation and merchants get texted after they convert",
  );
}

// ── the rule itself, exercised directly ──────────────────────────────
// The scan above proves the tree is clean RIGHT NOW. These prove the rule would
// actually catch a violation, so a clean scan means something.
assert.equal(
  isImportAllowed("app/founders/marketing/page.tsx", "lib/lenders/classify-reply").allowed,
  false,
  "founders importing SunBiz lender code is refused",
);
assert.equal(
  isImportAllowed("lib/lenders/shop-out.ts", "lib/founders/gate").allowed,
  false,
  "SunBiz importing founders code is refused (both directions)",
);
assert.equal(
  isImportAllowed("lib/queries.ts", "lib/founders/gate").allowed,
  false,
  "shared infrastructure may not reach into a portal — that is how a platform file quietly becomes portal-only",
);
assert.equal(
  isImportAllowed("app/founders/marketing/page.tsx", "lib/founders/gate").allowed,
  true,
  "within a portal is fine",
);
assert.equal(
  isImportAllowed("app/founders/marketing/page.tsx", "lib/api-helpers").allowed,
  true,
  "any portal may use shared infrastructure",
);
assert.equal(
  isImportAllowed("app/layout.tsx", "lib/founders/gate").allowed,
  true,
  "the root layout may import the founders gate to decide whether to render the nav tab",
);

// ── the two "marketing" namespaces must not be confused ──────────────
// lib/marketing/ is the PUBLIC website (oasis). lib/founders-marketing-core.ts
// is the founders' internal studio. Same word, different owners — this is the
// single most likely place for someone to wire the wrong one.
assert.equal(
  portalForPath("lib/marketing/routes.ts"),
  "oasis",
  "lib/marketing/ is the PUBLIC marketing site, owned by oasis",
);
assert.equal(
  portalForPath("lib/founders-marketing-core.ts"),
  "founders",
  "the founders marketing studio is a different portal entirely",
);
assert.equal(
  isImportAllowed("app/founders/marketing/page.tsx", "lib/marketing/routes").allowed,
  false,
  "the founders studio may not import the public marketing site's code",
);

// ── ownership is coherent ────────────────────────────────────────────
assert.equal(portalForPath("app/founders/marketing/page.tsx"), "founders");
assert.equal(portalForPath("lib/lenders/classify-reply.ts"), "sunbiz");
assert.equal(portalForPath("lib/oasis-sla.ts"), "oasis");
assert.equal(portalForPath("lib/queries.ts"), null, "shared code is owned by no portal");
assert.equal(isSharedPath("lib/manifest/loader.ts"), true);
assert.equal(isSharedPath("lib/founders/gate.ts"), false);

// No path may be claimed by two portals — that would make ownership ambiguous
// and the boundary unenforceable.
for (const a of PORTALS) {
  for (const b of PORTALS) {
    if (a.id === b.id) continue;
    for (const pa of a.owns) {
      for (const pb of b.owns) {
        assert.ok(
          !pa.startsWith(pb) && !pb.startsWith(pa),
          `portals ${a.id} and ${b.id} both claim overlapping paths: ${pa} vs ${pb}`,
        );
      }
    }
  }
}

// A portal owning a path that is also declared shared would make the rule
// self-contradictory.
for (const portal of PORTALS) {
  for (const owned of portal.owns) {
    assert.equal(
      isSharedPath(owned),
      false,
      `${portal.id} owns ${owned}, but it is also listed in SHARED_PREFIXES`,
    );
  }
}

// ── the founders portal is not a tenant ──────────────────────────────
// If it ever gains a tenant slug it becomes a customer surface, which is the
// opposite of what it is for.
assert.deepEqual(
  FOUNDERS_PORTAL.tenantSlugs,
  [],
  "the founders portal serves no tenant — it is the platform owner's own tooling",
);
assert.equal(FOUNDERS_PORTAL.routePrefix, "/founders");
assert.ok(
  FOUNDERS_PORTAL.owns.every((p) => p.startsWith("app/founders") || p.startsWith("lib/founders") || p.startsWith("components/founders")),
  "founders portal owns only founders-namespaced paths",
);

console.log(
  `portal-boundaries: OK — ${files.length} files scanned, ${edgesChecked} alias imports checked, ` +
    `${PORTALS.length} portals, 0 new cross-portal dependencies` +
    (KNOWN_BOUNDARY_DEBT.length
      ? ` (${KNOWN_BOUNDARY_DEBT.length} known debt: ${KNOWN_BOUNDARY_DEBT.map((d) => `${d.from} -> ${d.to}`).join(", ")})`
      : ""),
);
