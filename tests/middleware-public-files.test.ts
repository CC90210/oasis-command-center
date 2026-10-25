/**
 * middleware-public-files.test.ts — a file extension makes a path public only
 * for a real file: at the root, or inside a folder that exists under public/.
 *
 * WHY. isPublic() used to let any path ending .json, .png, .txt and so on skip
 * the session gate, /api/** included: /api/leads/x.json was public at the edge
 * (2026-10-19 audit). Every route checked its own session, so nothing leaked, but
 * the next route that trusted middleware would have answered anyone. And
 * /api/exec-override was a public prefix with no route behind it, so anything
 * added there later would have been public by default.
 *
 * Run: node --conditions=react-server --import tsx tests/middleware-public-files.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { isPublic, PUBLIC_ASSET_DIRS, PUBLIC_PATH_PREFIXES } from "../middleware";

const ROOT = join(__dirname, "..");
const PUBLIC = join(ROOT, "public");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

check("the asset folders listed in middleware are exactly the folders under public/", () => {
  const real = readdirSync(PUBLIC).filter((n) => statSync(join(PUBLIC, n)).isDirectory()).sort();
  assert.deepEqual([...PUBLIC_ASSET_DIRS].sort(), real, "add a new public/ folder to PUBLIC_ASSET_DIRS in middleware.ts");
});

check("every file under public/ is still served without a session", () => {
  const files = walk(PUBLIC).map((f) => "/" + relative(PUBLIC, f).split(sep).join("/"));
  assert.ok(files.length > 0, "public/ has files");
  const gated = files.filter((p) => !isPublic(p));
  assert.deepEqual(gated, [], "these public files would now need a session");
});

check("root files, generated metadata and the two install paths stay public", () => {
  for (const p of ["/robots.txt", "/sitemap.xml", "/favicon.ico", "/manifest.webmanifest", "/icon.png", "/opengraph-image-abc123", "/install.sh", "/install.ps1"]) {
    assert.equal(isPublic(p), true, p);
  }
});

check("an extension anywhere else no longer skips the session gate", () => {
  for (const p of [
    "/api/leads/abc.json",
    "/api/x.png",
    "/api/cron-jobs/export.json",
    "/api/manifest/acme/records/lead.txt",
    "/pipeline/abc.json",
    "/settings/brand.png",
    "/t/acme/data.json",
    "/brandx/logo.png",
    "/brand.evil/logo.png",
    "/connectorsx/a.svg",
  ]) {
    assert.equal(isPublic(p), false, `${p} must need a session`);
  }
});

check("a root path or an asset-folder path without a file extension still needs a session", () => {
  for (const p of ["/settings", "/pipeline", "/schedule", "/brand", "/brand/admin", "/connectors/manage"]) {
    assert.equal(isPublic(p), false, `${p} must need a session`);
  }
});

check("/api/exec-override is no longer public, and no route ever answered it", () => {
  assert.equal(isPublic("/api/exec-override"), false);
  assert.equal(isPublic("/api/exec-override/approve"), false);
  assert.equal(existsSync(join(ROOT, "app", "api", "exec-override")), false);
});

// Every URL a page or route handler answers: route groups dropped, a dynamic segment matches anything.
function appRoutes(): string[][] {
  const appDir = join(ROOT, "app");
  const out: string[][] = [];
  for (const file of walk(appDir)) {
    const segs = relative(appDir, dirname(file)).split(sep).filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
    const name = basename(file);
    if (/^(page|route)\.(t|j)sx?$/.test(name)) out.push(segs);
    // Next's metadata files answer at their own name (app/sitemap.ts -> /sitemap.xml).
    else if (segs.length === 0 && /^(sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\./.test(name)) out.push([name.split(".")[0]]);
  }
  return out;
}

check("every public path prefix has something behind it: a route, a rewrite or redirect, a public/ folder, or Next's own files", () => {
  const routes = appRoutes();
  const nextConfig = readFileSync(join(ROOT, "next.config.js"), "utf8");
  // Framework-served paths no app file declares.
  const FRAMEWORK = new Set(["/_next", "/favicon"]);
  const answered = (prefix: string) => {
    const segs = prefix.split("/").filter(Boolean);
    if (FRAMEWORK.has(prefix.replace(/\/$/, ""))) return true;
    if (segs.length > 0 && PUBLIC_ASSET_DIRS.includes(segs[0])) return true;
    // Match the prefix as a whole quoted path or a path that continues it, never a longer
    // name that merely starts the same ("/api/pg" must not match "/api/pgx").
    const bare = prefix.replace(/\/$/, "");
    const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`["'\`]${escaped}(?=["'\`/:(]|$)`).test(nextConfig)) return true;
    return routes.some((r) => {
      const n = Math.min(segs.length, r.length);
      for (let i = 0; i < n; i++) if (!r[i].startsWith("[") && r[i] !== segs[i]) return false;
      return r.length >= segs.length || r.some((s) => s.startsWith("[..."));
    });
  };
  const dead = PUBLIC_PATH_PREFIXES.filter((p) => !answered(p));
  assert.deepEqual(dead, [], "a public prefix with nothing behind it makes whatever is added there later public by default");
});

if (failures > 0) {
  console.log(`\nmiddleware-public-files.test.ts — ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nmiddleware-public-files.test.ts — extensions are public only for real files ✓");
