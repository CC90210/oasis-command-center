/**
 * P1 instant-load pins (2026-09-01).
 *
 * Two kinds of check:
 *   1. resolvePrimaryAgent() unit tests — the extracted resolver must keep
 *      the layout's cross-tenant heartbeat guard (manifest validation).
 *   2. Source pins on the de-duplication work. These are drift tripwires,
 *      not proofs: they fail loudly if someone reintroduces a raw
 *      `tenants` read in the deduped call sites, or moves the snapshot/
 *      bridge reads back into the root layout's blocking path.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePrimaryAgent } from "../lib/shell-status";
import type { TenantManifest } from "../lib/manifest/schema";

function src(path: string): string {
  return readFileSync(path, "utf8");
}

function manifestWith(agents: Array<{ slug: string; enabled: boolean; primary?: boolean }>): TenantManifest {
  return { agents } as unknown as TenantManifest;
}

async function main(): Promise<void> {
  // ---- resolvePrimaryAgent keeps the manifest-validation guard ----
  const manifest = manifestWith([
    { slug: "bravo", enabled: true, primary: true },
    { slug: "atlas", enabled: true },
  ]);
  assert.equal(
    resolvePrimaryAgent({ primary_agent: "Atlas" }, manifest),
    "atlas",
    "an enabled requested agent wins (case-insensitive)",
  );
  assert.equal(
    resolvePrimaryAgent({ primary_agent: "stale-foreign-agent" }, manifest),
    "bravo",
    "a non-enabled requested agent falls back to the manifest primary — the cross-tenant heartbeat guard",
  );
  assert.equal(
    resolvePrimaryAgent(null, null),
    "bravo",
    "no profile, no manifest → the historical default",
  );
  assert.equal(
    resolvePrimaryAgent({ primary_agent: "ghost" }, null),
    "ghost",
    "no manifest to validate against → requested passes through (legacy behavior)",
  );

  // ---- source pins: the deduped call sites stay deduped ----
  const roleSurfaces = src("lib/role-surfaces-session.ts");
  assert.ok(roleSurfaces.includes("getTenant("), "role-surfaces reads via cached getTenant");
  assert.ok(
    !roleSurfaces.includes('.from("tenants")'),
    "role-surfaces must not reintroduce its own raw tenants read (dup ~140ms round trip on 9+ pages)",
  );

  const pipeline = src("app/pipeline/page.tsx");
  assert.ok(
    !pipeline.includes('.from("tenants")'),
    "pipeline page must not reintroduce its own raw tenants read",
  );

  const layout = src("app/layout.tsx");
  assert.ok(
    !layout.includes("agent_state_snapshot") && !layout.includes("getBridgeOnline"),
    "the snapshot/bridge reads must stay OUT of the root layout's blocking path (P1: they render after paint via /api/shell/status)",
  );
  assert.ok(layout.includes("deferStatus"), "layout opts the sidebar into deferred status");
  assert.ok(layout.includes("resolvePrimaryAgent"), "layout resolves the agent slug via the shared guard");

  const sidebar = src("components/Sidebar.tsx");
  assert.ok(sidebar.includes("/api/shell/status"), "sidebar fetches deferred status");
  assert.ok(sidebar.includes("deferStatus = false"), "deferred status is opt-in, default off");

  const statusRoute = src("app/api/shell/status/route.ts");
  assert.ok(statusRoute.includes("status: 401"), "status route fails closed without a session");
  assert.ok(statusRoute.includes("no-store"), "status route is never cached");
  assert.ok(statusRoute.includes("resolvePrimaryAgent"), "status route shares the agent guard");

  console.log("perf-p1: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
