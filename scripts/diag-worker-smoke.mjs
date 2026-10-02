/* eslint-disable */
// THROWAWAY smoke check for PR #531 (diag/worker-smoke-check, never merged).
//
// Runs the Worker CI just built from perf/worker-bundle-diet under `wrangler
// dev` (local workerd, no credentials) and requests a fixed list of routes ONE
// AT A TIME, so no request competes with another for workerd's outbound
// connections. Re-checks the three routes that answered 500 inside an
// overloaded burst in the parallel smoke run, and their neighbours.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = "/tmp/wrangler-dev.log";
const log = fs.openSync(LOG, "w");
const dev = spawn(
  "npx",
  ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--show-interactive-dev-session=false"],
  { stdio: ["ignore", log, log], detached: true, env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path, timeoutMs = 45000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(BASE + path, { redirect: "manual", signal: ac.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ms: Date.now() - started, len: buf.length, sha: createHash("sha256").update(buf).digest("hex").slice(0, 12), type: res.headers.get("content-type") || "" };
  } catch (e) {
    return { status: e.name === "AbortError" ? "timeout" : "fetch-error", ms: Date.now() - started, len: 0, sha: "", type: "" };
  } finally {
    clearTimeout(t);
  }
}
let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await sleep(2000);
  ready = (await get("/robots.txt", 5000)).status === 200;
}
console.log(`wrangler dev ready: ${ready}`);
const routes = [
  "/contacts", "/configure", "/contact", "/api/forms/smoke/mint-link", "/api/forms/smoke", "/api/forms",
  "/commissions", "/demo/sun", "/desktop-link", "/dmca", "/download", "/clients", "/client-portal",
  "/opengraph-image-pwu6ef", "/robots.txt", "/sitemap.xml", "/", "/login", "/signup", "/privacy", "/terms",
  "/work", "/about", "/fleet", "/welcome", "/start", "/api/health", "/no-such-page-smoke", "/unsubscribe",
  "/forgot-password", "/link-expired",
];
for (const p of routes) {
  const r = ready ? await get(p) : { status: "not-ready" };
  console.log(`${p} ${r.status} ${r.ms ?? ""}ms ${r.type ?? ""} ${r.len ?? ""}B ${r.sha ?? ""}`);
}
try {
  process.kill(-dev.pid, "SIGTERM");
} catch {}
await sleep(1500);
const text = fs.readFileSync(LOG, "utf8");
const bad = text.split("\n").filter((l) => /ERROR|Unknown chunk|Cannot find module|reading 'call'|is not a function|overloaded/i.test(l));
console.log(`\n=== wrangler dev log: ${bad.length} error line(s) ===`);
for (const l of bad.slice(0, 40)) console.log(l.slice(0, 300));
console.log("=== request log ===");
for (const l of text.split("\n").filter((l) => l.includes("[wrangler:info]"))) console.log(l.slice(0, 200));
process.exit(0);
