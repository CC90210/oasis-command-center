/**
 * The PostgREST bridge over the whole database stays deleted.
 *
 * WHY. app/api/pg/rest/v1/[...path] was a PostgREST-compatible bridge over
 * Turso for the SunBiz TextTorrent runtime (retired 2026-09-28). It was public
 * in middleware and gated only by two static bearers (TT_PG_BRIDGE_TOKEN,
 * APEX_PG_BRIDGE_TOKEN); behind those there was no per-row boundary at all, so
 * one leaked token exposed every client workspace's operational rows. Deleted
 * 2026-10-01 (OS plan W0; audit stage-3a critic, "PostgREST bridge").
 *
 * A route folder that comes back, a public prefix that comes back, or a
 * bridge bearer read anywhere in the app is each a red build here, by name.
 *
 * Run: node --conditions=react-server --import tsx tests/pg-bridge-removed.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PUBLIC_PATH_PREFIXES, isPublic } from "../middleware";

const ROOT = process.cwd();

// ── 1. No route handler under app/api/pg ───────────────────────────────────
assert.equal(existsSync(join(ROOT, "app", "api", "pg")), false, "app/api/pg exists again: the PostgREST bridge is back");

// ── 2. Middleware lists no /api/pg prefix, and the path is session-gated ───
const pgPrefixes = PUBLIC_PATH_PREFIXES.filter((p) => p === "/api/pg" || p.startsWith("/api/pg/"));
assert.deepEqual(pgPrefixes, [], `middleware.ts lists ${pgPrefixes.join(", ")} as public`);
for (const path of ["/api/pg", "/api/pg/rest/v1/tenants", "/api/pg/rest/v1/rpc/patch_tenant_record_data"]) {
  assert.equal(isPublic(path), false, `${path} bypasses the session middleware`);
}

// ── 3. The bridge bearers are read nowhere in the app ──────────────────────
//
// The names are the whole credential story of that route; a module reading
// either one is a bridge wearing a new path. The deploy workflow's generated
// secret list (.github/) is maintained from the BEA secret manifest, not here.
const BEARERS = /TT_PG_BRIDGE_TOKEN|APEX_PG_BRIDGE_TOKEN|turso-rpc-texttorrent/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(tsx?|jsx?|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const scanned: string[] = [];
const hits: string[] = [];
for (const base of ["app", "components", "lib", "scripts", "workers"]) {
  const dir = join(ROOT, base);
  if (!existsSync(dir)) continue;
  for (const file of sourceFiles(dir)) {
    scanned.push(file);
    if (BEARERS.test(readFileSync(file, "utf8"))) hits.push(relative(ROOT, file).replace(/\\/g, "/"));
  }
}
assert.ok(scanned.length > 500, `the scan read only ${scanned.length} files; the walker is broken`);
assert.deepEqual(hits, [], "these files read a bridge bearer or the TextTorrent RPC ports");
const middleware = readFileSync(join(ROOT, "middleware.ts"), "utf8");
assert.doesNotMatch(middleware, /"\/api\/pg"/, "middleware.ts carries the literal public entry again");

console.log(`pg-bridge-removed: OK — no app/api/pg, no public prefix, ${scanned.length} source files read no bridge bearer`);
