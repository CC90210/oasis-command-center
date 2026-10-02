/* eslint-disable */
// TEMPORARY Worker smoke test (perf/worker-bundle-diet). Removed before merge.
//
// Runs the Worker that CI just built under `wrangler dev` (local workerd, no
// credentials, no secrets) and requests every app route once, so each route's
// server entry and the chunks it needs are loaded for real. Prints one line per
// route (status + error class) so two builds can be compared route by route,
// and every chunk-loading failure signature found in the responses or the log.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = "/tmp/wrangler-dev.log";
const BUDGET_MS = 9 * 60 * 1000;
const started = Date.now();

const CHUNK_ERRORS = /Unknown chunk|Cannot find module|reading 'call'|__webpack_modules__|is not a function|No such module|Dynamic require of/i;

const log = fs.openSync(LOG, "w");
const dev = spawn(
  "npx",
  ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--show-interactive-dev-session=false"],
  { stdio: ["ignore", log, log], detached: true, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, timeoutMs = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { redirect: "manual", signal: ac.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.subarray(0, 4096).toString("latin1");
    const m = head.match(CHUNK_ERRORS);
    return { status: res.status, len: buf.length, sha: createHash("sha256").update(buf).digest("hex").slice(0, 12), chunkErr: m ? m[0] : "", type: res.headers.get("content-type") || "" };
  } catch (e) {
    return { status: e.name === "AbortError" ? "timeout" : "fetch-error", len: 0, sha: "", chunkErr: "", type: "" };
  } finally {
    clearTimeout(t);
  }
}

let ready = false;
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  const r = await get("/robots.txt", 5000);
  if (r.status === 200) {
    ready = true;
    break;
  }
}
console.log(`wrangler dev ready: ${ready} after ${((Date.now() - started) / 1000).toFixed(0)}s`);

const manifest = JSON.parse(fs.readFileSync(".next/app-path-routes-manifest.json", "utf8"));
const routes = [...new Set(Object.values(manifest))]
  .map((r) =>
    r
      .replace(/\/\[\[\.\.\.[^\]]+\]\]/g, "")
      .replace(/\[\.\.\.[^\]]+\]/g, "smoke")
      .replace(/\[[^\]]+\]/g, "smoke") || "/",
  )
  .sort();
const extra = ["/", "/welcome", "/no-such-page-smoke", "/opengraph-image-pwu6ef"];
const all = [...new Set([...routes, ...extra])].sort();
console.log(`routes to request: ${all.length}`);

const results = {};
if (ready) {
  // The routes these checks name first, one at a time, before any load.
  for (const p of ["/opengraph-image-pwu6ef", "/robots.txt", "/", "/login", "/api/health"]) results[p] = await get(p, 40000);
  const queue = all.filter((p) => !(p in results));
  let next = 0;
  const worker = async () => {
    while (next < queue.length && Date.now() - started < BUDGET_MS) {
      const p = queue[next++];
      results[p] = await get(p, 25000);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  // A timeout says the dev server was busy (pages here wait on hosts that do
  // not answer without credentials), not what the route does. Retry each one
  // alone.
  const retry = Object.keys(results).filter((p) => results[p].status === "timeout");
  console.log(`retrying ${retry.length} timeout(s) one at a time`);
  for (const p of retry) {
    if (Date.now() - started > BUDGET_MS + 3 * 60 * 1000) break;
    results[p] = await get(p, 40000);
  }
}

const byStatus = {};
for (const r of Object.values(results)) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
console.log(`requested ${Object.keys(results).length} of ${all.length}; statuses: ${JSON.stringify(byStatus)}`);
const lines = all.map((p) => {
  const r = results[p];
  return r ? `${p} ${r.status}${r.chunkErr ? " CHUNK-ERROR:" + r.chunkErr : ""}` : `${p} not-requested`;
});
console.log(`route-status digest: ${createHash("sha256").update(lines.join("\n")).digest("hex")}`);
console.log("=== per-route status ===");
for (const l of lines) console.log(l);
for (const p of ["/opengraph-image-pwu6ef", "/robots.txt", "/", "/login", "/api/health"]) {
  const r = results[p];
  if (r) console.log(`detail ${p}: status=${r.status} type=${r.type} bytes=${r.len} sha256/12=${r.sha}`);
}

try {
  process.kill(-dev.pid, "SIGTERM");
} catch {}
await sleep(1500);
const text = fs.readFileSync(LOG, "utf8");
const hits = text.split("\n").filter((l) => CHUNK_ERRORS.test(l));
console.log(`\n=== wrangler dev log: ${hits.length} line(s) matching chunk-loading failure signatures ===`);
for (const l of hits.slice(0, 40)) console.log(l.slice(0, 300));
console.log("=== wrangler dev log tail ===");
for (const l of text.split("\n").slice(-25)) console.log(l.slice(0, 300));
process.exit(0);
