/* eslint-disable */
// TEMPORARY bundle-composition diagnostic (perf/worker-bundle-diet). Removed before merge.
//
// Joins OpenNext's esbuild metafile (handler.mjs.meta.json: bytes each input
// contributes to the Worker's server bundle) with diag-out/server-modules-*.json
// (written by scripts/diag-webpack-plugin.cjs: which modules and layers each
// webpack server chunk holds) and prints where the Worker's bytes come from.
import fs from "node:fs";
import path from "node:path";

const kib = (n) => (n / 1024).toFixed(1).padStart(9);
const norm = (p) => p.split("\\").join("/");

function pkgOf(p) {
  const k = p.lastIndexOf("node_modules/");
  if (k < 0) return null;
  const rest = p.slice(k + "node_modules/".length).split("/");
  let name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  if (name === "next" && rest[1] === "dist") {
    name = rest[2] === "compiled" ? `next/dist/compiled/${rest[3] && rest[3].startsWith("@") ? `${rest[3]}/${rest[4]}` : rest[3]}` : `next/dist/${rest[2]}`;
  }
  return name;
}

function top(obj, n, label) {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log(`\n=== ${label} (top ${n}) ===`);
  for (const [k, v] of rows) console.log(`${kib(v)} KiB  ${k}`);
}

const metaPath = ".open-next/server-functions/default/handler.mjs.meta.json";
const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const outKey = Object.keys(meta.outputs).find((k) => k.endsWith("handler.mjs"));
const out = meta.outputs[outKey];
const inputs = Object.entries(out.inputs).map(([p, v]) => [norm(p), v.bytesInOutput]);
console.log(`handler.mjs output bytes=${out.bytes} (${kib(out.bytes)} KiB) from ${inputs.length} inputs`);

const cat = {};
const npmDirect = {};
const nextServer = [];
for (const [p, b] of inputs) {
  const j = p.indexOf(".next/server/");
  if (j >= 0) {
    const rel = p.slice(j + ".next/server/".length);
    nextServer.push([rel, b]);
    const c = rel.startsWith("chunks/")
      ? "webpack:chunks/"
      : rel.startsWith("app/")
        ? "webpack:app/ entries"
        : rel.startsWith("pages/")
          ? "webpack:pages/"
          : `webpack:${rel}`;
    cat[c] = (cat[c] || 0) + b;
    continue;
  }
  const pkg = pkgOf(p);
  if (pkg) {
    npmDirect[pkg] = (npmDirect[pkg] || 0) + b;
    cat["esbuild:node_modules"] = (cat["esbuild:node_modules"] || 0) + b;
    if (/load-manifest/.test(p)) console.log(`load-manifest input (inlined manifests): ${p} ${kib(b)} KiB`);
    continue;
  }
  cat[`other:${p}`] = (cat[`other:${p}`] || 0) + b;
}
top(cat, 30, "categories");

// Who pulls each directly-bundled package in: the metafile's import edges.
{
  const importers = {};
  for (const [p, info] of Object.entries(meta.inputs)) {
    const from = norm(p);
    for (const imp of info.imports || []) {
      const to = norm(imp.path || "");
      const pkg = pkgOf(to);
      if (!pkg) continue;
      const fromPkg = pkgOf(from) || (from.includes(".next/server/") ? from.slice(from.indexOf(".next/server/")) : from);
      if (fromPkg === pkg) continue;
      (importers[pkg] ||= new Set()).add(`${fromPkg} (${imp.kind})`);
    }
  }
  console.log("\n=== importers of directly-bundled packages (first 6 each) ===");
  for (const pkg of Object.keys(importers).sort()) console.log(`${pkg} <- ${[...importers[pkg]].slice(0, 6).join(", ")}`);
}
top(npmDirect, 50, "npm packages bundled directly by OpenNext's esbuild (outside webpack chunks)");

const diagDir = "diag-out";
const diagFiles = fs.existsSync(diagDir) ? fs.readdirSync(diagDir).filter((f) => f.startsWith("server-modules-")) : [];
console.log(`\nwebpack diag files: ${diagFiles.join(", ") || "(none)"}`);
const chunkMap = {};
for (const f of diagFiles) {
  const raw = JSON.parse(fs.readFileSync(path.join(diagDir, f), "utf8"));
  const keys = Object.keys(raw);
  console.log(`${f}: ${keys.length} chunk files; sample keys: ${keys.slice(0, 8).join(" | ")}`);
  for (const k of keys) {
    // chunk.files are relative to the compiler's output.path; normalise to the
    // path under .next/server/ that the esbuild metafile uses.
    let n = norm(k).replace(/^(\.\.\/)+/, "");
    const s = n.indexOf("server/");
    if (n.startsWith("server/")) n = n.slice("server/".length);
    else if (s > 0 && n.slice(0, s).endsWith(".next/")) n = n.slice(s + "server/".length);
    chunkMap[n] = raw[k];
  }
}
{
  let matched = 0;
  for (const [rel] of nextServer) if (chunkMap[rel]) matched++;
  console.log(`metafile .next/server inputs: ${nextServer.length}; with a module map: ${matched}; sample inputs: ${nextServer.slice(0, 5).map(([r]) => r).join(" | ")}`);
}

const byKeyLayer = {};
const byPkg = {};
const bySrcDir = {};
const bySrcFile = {};
const byLayer = {};
let unattributed = 0;
const chunkTops = [];
for (const [rel, bytes] of nextServer) {
  const mods = chunkMap[rel];
  if (!mods) {
    unattributed += bytes;
    chunkTops.push([rel, bytes, "(no webpack map)"]);
    continue;
  }
  const total = Object.values(mods).reduce((a, b) => a + b, 0) || 1;
  const inChunk = [];
  for (const [kl, size] of Object.entries(mods)) {
    const share = (bytes * size) / total;
    const bar = kl.lastIndexOf("|");
    const key = kl.slice(0, bar);
    const layer = kl.slice(bar + 1);
    byKeyLayer[kl] = (byKeyLayer[kl] || 0) + share;
    byLayer[layer] = (byLayer[layer] || 0) + share;
    if (key.startsWith("npm:")) byPkg[key.slice(4)] = (byPkg[key.slice(4)] || 0) + share;
    else if (key.startsWith("src:")) {
      const src = key.slice(4);
      bySrcFile[src] = (bySrcFile[src] || 0) + share;
      const segs = src.split("/");
      const d = segs.length > 2 ? segs.slice(0, 2).join("/") : segs[0];
      bySrcDir[d] = (bySrcDir[d] || 0) + share;
    } else byPkg[key] = (byPkg[key] || 0) + share;
    inChunk.push([key, share]);
  }
  inChunk.sort((a, b) => b[1] - a[1]);
  chunkTops.push([rel, bytes, inChunk.slice(0, 4).map(([k, s]) => `${k}=${(s / 1024).toFixed(0)}K`).join(" ")]);
}
console.log(`\nwebpack inputs without a module map: ${kib(unattributed)} KiB`);
top(byLayer, 20, "webpack bytes by layer (estimated, prorated by module source size)");
top(byPkg, 80, "webpack bytes by npm package, all layers (estimated)");
const pkgLayer = {};
for (const [kl, v] of Object.entries(byKeyLayer)) if (kl.startsWith("npm:")) pkgLayer[kl.slice(4)] = v;
top(pkgLayer, 60, "webpack bytes by npm package|layer (estimated)");
top(bySrcDir, 50, "webpack bytes by source dir (estimated)");
top(bySrcFile, 60, "webpack bytes by source file (estimated)");
chunkTops.sort((a, b) => b[1] - a[1]);
console.log("\n=== largest .next/server inputs (top 60) ===");
for (const [rel, b, info] of chunkTops.slice(0, 60)) console.log(`${kib(b)} KiB  ${rel}  ${info}`);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push([norm(p), fs.statSync(p).size]);
  }
  return acc;
}
console.log("\n=== .open-next non-JS module candidates (wasm/bin) ===");
for (const [p, s] of walk(".open-next").filter(([p]) => /\.(wasm|bin)$/.test(p) && !p.includes("/assets/"))) console.log(`${kib(s)} KiB  ${p}`);
for (const f of [".open-next/middleware/handler.mjs", ".open-next/worker.js", ".open-next/server-functions/default/handler.mjs"]) {
  if (fs.existsSync(f)) console.log(`${kib(fs.statSync(f).size)} KiB  ${f}`);
}
console.log("\n=== wrangler dry-run outdir ===");
for (const [p, s] of walk(".wrangler/ci-dry-run")) console.log(`${kib(s)} KiB  ${p}`);

// Information only: how much of worker.js is wrangler re-printing the already
// minified handler.mjs without minification. Not used by any check.
try {
  const { execSync } = await import("node:child_process");
  const outMin = execSync("npx wrangler deploy --dry-run --outdir .wrangler/diag-minify --minify 2>&1", {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = outMin.split("\n").find((l) => l.includes("Total Upload"));
  console.log(`\n=== same dry run with wrangler --minify (information only) ===\n${line || "(no size line)"}`);
} catch (err) {
  console.log(`wrangler --minify dry run failed: ${err && err.message ? err.message.split("\n")[0] : err}`);
}
