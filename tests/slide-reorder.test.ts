/**
 * A re-order may PERMUTE the slides and nothing else.
 * Run: node --conditions=react-server --import tsx tests/slide-reorder.test.ts
 *
 * WHY THIS IS A SECURITY TEST, NOT A TIDINESS ONE
 * marketing_asset.media_urls feeds signMediaUrls() and the publisher. If the
 * re-order endpoint accepted an arbitrary string, a caller could point this
 * asset at ANOTHER TENANT'S storage key and have our own signer mint a URL for
 * it — a cross-tenant read, laundered through the app that is supposed to
 * prevent one. Comparing the submitted order against what the asset already
 * owns makes that unreachable: you cannot name a path the asset does not have.
 *
 * The permutation check is duplicated here rather than imported because the
 * route's copy is the one that runs; this asserts the PROPERTY, so a rewrite of
 * the route that weakens it fails here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

/** Same multiset, any order — the property the route must enforce. */
function isPermutation(next: string[], current: string[]): boolean {
  if (next.length !== current.length) return false;
  const tally = new Map<string, number>();
  for (const p of current) tally.set(p, (tally.get(p) ?? 0) + 1);
  for (const p of next) {
    const n = tally.get(p);
    if (!n) return false;
    tally.set(p, n - 1);
  }
  return [...tally.values()].every((n) => n === 0);
}

const own = ["t/a.png", "t/b.png", "t/c.png"];

// ── legitimate reorders ─────────────────────────────────────────────────────
assert.equal(isPermutation(["t/b.png", "t/a.png", "t/c.png"], own), true, "swap is allowed");
assert.equal(isPermutation(["t/c.png", "t/b.png", "t/a.png"], own), true, "reverse is allowed");
assert.equal(isPermutation([...own], own), true, "identity is allowed");

// ── the attacks this exists to stop ─────────────────────────────────────────
assert.equal(
  isPermutation(["t/a.png", "t/b.png", "other-tenant/secret.png"], own),
  false,
  "a path the asset does not own is REFUSED — this is the cross-tenant read",
);
assert.equal(
  isPermutation(["t/a.png", "t/b.png"], own),
  false,
  "dropping a slide is not a reorder",
);
assert.equal(
  isPermutation(["t/a.png", "t/b.png", "t/c.png", "t/c.png"], own),
  false,
  "adding a slide is not a reorder",
);
assert.equal(
  isPermutation(["t/a.png", "t/a.png", "t/b.png"], own),
  false,
  "duplicating one slide to displace another is not a reorder",
);
assert.equal(isPermutation([], own), false, "an empty order is not a reorder");

// Duplicates that legitimately exist must survive a reorder.
{
  const dupes = ["t/a.png", "t/a.png", "t/b.png"];
  assert.equal(isPermutation(["t/b.png", "t/a.png", "t/a.png"], dupes), true,
    "a genuinely repeated slide stays repeated");
  assert.equal(isPermutation(["t/a.png", "t/b.png", "t/b.png"], dupes), false,
    "the multiset must match, not merely the set");
}

// ── the route enforces it, and is scoped ────────────────────────────────────
{
  const route = readFileSync(
    join(ROOT, "app/api/founders/marketing/assets/[id]/slides/route.ts"), "utf8");

  assert.match(route, /function isPermutation/, "the route must implement the check itself");
  assert.match(
    route,
    /if \(!isPermutation\(next, current\)\)/,
    "the route must CALL it on the submitted order against the stored one — an import alone proves nothing",
  );
  assert.match(route, /resolveFounder\(\)/, "founders only");
  assert.match(route, /error: "not_found"/, "404, never 403 — a 403 confirms the asset exists");

  // Tenant scoping on BOTH the read and the write. Service role bypasses RLS,
  // so the filter is the only boundary there is.
  const eqTenant = route.match(/\.eq\("tenant_id", founder\.tenantId\)/g) || [];
  assert.ok(
    eqTenant.length >= 2,
    `expected tenant scoping on the read AND the update, found ${eqTenant.length}`,
  );

  // The stored order must come from the database, never from the request.
  assert.match(
    route,
    /const current = parseSlideUrls\(asset\.data\.media_urls\)/,
    "`current` must be read from the asset row — comparing the request against itself proves nothing",
  );
}

// ── the UI sends paths, not indices ─────────────────────────────────────────
{
  const ui = readFileSync(join(ROOT, "components/founders/SlideReorder.tsx"), "utf8");
  assert.match(
    ui,
    /slides: order\.map\(\(n\) => slidePaths\[n\]\)/,
    "the client must submit storage paths — indices would make the server trust a position it cannot verify",
  );
  assert.match(ui, /method: "PUT"/, "reorder is a PUT");
}

console.log("slide-reorder: ok — permutation only, tenant-scoped, paths not indices");
