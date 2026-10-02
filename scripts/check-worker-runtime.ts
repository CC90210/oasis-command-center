/**
 * scripts/check-worker-runtime.ts - run the Worker CI just built under workerd,
 * a FRESH process (cold isolate) per group of routes, and fail on any sign that
 * code could not be loaded. (2026-10-02, review of #531)
 *
 * WHY. scripts/check-worker-chunks.ts proves every chunk the code can request
 * is inlined. This proves the built Worker actually loads and runs them, on the
 * paths that matter most: cold, the way a fresh production isolate meets them.
 * A warm isolate can hide a gap, because a chunk one route installed stays
 * installed for the next, so each group starts its own workerd and the first
 * request of each group finds nothing loaded.
 *
 * HOW, with no database and no secrets:
 *  - `wrangler dev` (local workerd, no Cloudflare account) per group, bundling
 *    the same .open-next/worker.js the deploy uploads.
 *  - Worker env EMPIRE_AUTH_BACKEND=turso and a throwaway AUTH_SESSION_SECRET,
 *    the production auth mode. A session cookie signed with that secret takes a
 *    signed-in request past middleware into the route, which then runs what a
 *    real user's request runs until the first database call. There is no
 *    database, so getTursoClient() throws "Turso misconfigured" at once: that
 *    log line is the expected end of those requests, and it proves the request
 *    got past every import before it. On that path lib/supabase-server.ts loads
 *    lib/turso-auth with a dynamic import(), and lib/bridge-proxy.ts loads
 *    lib/supabase-server and lib/platform-operator the same way, so the
 *    signed-in POSTs below exercise async chunk loading on a cold isolate.
 *  - Paths that need a real signed-in user from the database (the plan-mode
 *    import in app/api/chat/route.ts sits after one) cannot be reached here;
 *    the static check covers their chunk ids.
 *
 * IT FAILS ON: a process that exits or never reports Ready; a request that
 * times out or cannot connect; a route's own expectation not met; and any
 * chunk-loading signature (CHUNK_FAILURE) in a response body or the log.
 *
 * SELF-TEST. Last, it removes the switch case for the chunk that holds
 * lib/turso-auth from the bundled handler and runs one more cold group. The
 * gate must report that request, or the run fails: a gate that cannot see a
 * missing chunk is not checking anything. The handler is restored afterwards.
 *
 * Exit 0 = every group passed and the self-test caught the removed chunk.
 *
 * Run (after the OpenNext build): node --import tsx scripts/check-worker-runtime.ts
 */

import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** What a chunk or module that cannot be loaded looks like, in a body or the log. */
export const CHUNK_FAILURE =
  /Unknown chunk|Cannot find module|ChunkLoadError|Loading chunk [\w-]+ failed|reading 'call'|\(0\s*,\s*[\w$.]+\) is not a function|No such module|Dynamic require of/;

/** The log line a signed-in request ends on when it reached the database step. */
export const REACHED_DATABASE = /Turso misconfigured/;

/** A session cookie in lib/turso-auth.ts's format: base64url(JSON).base64url(HMAC-SHA256). */
export function mintSession(secret: string, nowMs = Date.now()): string {
  const payload = {
    sub: "00000000-0000-4000-8000-000000000000",
    email: "worker-runtime-gate@example.invalid",
    exp: Math.floor(nowMs / 1000) + 3600,
    ver: 0,
    onb: "done",
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function chunkFailureLines(text: string): string[] {
  return text.split("\n").filter((l) => CHUNK_FAILURE.test(l));
}

/**
 * Remove the inlined switch case(s) for one chunk from the bundled handler, so
 * a request that needs it hits the Unknown-chunk default. Returns how many
 * cases were removed; 0 means the bundle no longer has the shape this expects.
 */
export function removeChunkCase(bundle: string, chunkId: number): { source: string; removed: number } {
  let removed = 0;
  const source = bundle.replace(new RegExp(`case ${chunkId}:(\\s*[\\w$]+\\(require_[\\w$]*\\(\\)\\);)`, "g"), (_m, rest: string) => {
    removed++;
    return `case -${chunkId}:${rest}`;
  });
  return { source, removed };
}

type Result = { status: number | "timeout" | "connect-error"; body: string; bytes: Buffer; headers: Headers; ms: number };
type Probe = {
  name: string;
  method?: "GET" | "POST";
  path: string | ((found: Found) => string);
  signedIn?: boolean;
  json?: unknown;
  /** Return a problem, or null when the response is right. */
  expect?: (r: Result, found: Found) => string | null;
  /** This request must end on the database step (see REACHED_DATABASE). */
  reachesDatabase?: boolean;
};
type Group = { name: string; probes: Probe[] };
type Found = { ogImage?: string };

const ROOT = path.join(__dirname, "..");
const SERVER_DIR = path.join(ROOT, ".open-next/server-functions/default/.next/server");
const HANDLER = path.join(ROOT, ".open-next/server-functions/default/handler.mjs");
const OG_PNG = path.join(ROOT, "app/(marketing)/opengraph-image.png");
const REQUEST_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 120_000;
const ACCESS_LOG_WAIT_MS = 10_000;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The log after wrangler says Ready: the part that belongs to the requests. */
export function afterReady(log: string): string {
  const at = log.search(/Ready on http:\/\//);
  return at < 0 ? log : log.slice(at);
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const statusIs =
  (...ok: number[]) =>
  (r: Result) =>
    typeof r.status === "number" && ok.includes(r.status) ? null : `status ${r.status}, expected ${ok.join(" or ")}`;

function groups(): Group[] {
  const html = (r: Result) =>
    statusIs(200)(r) ?? ((r.headers.get("content-type") || "").includes("text/html") ? null : `content-type ${r.headers.get("content-type")}`);
  const ogPng = readFileSync(OG_PNG);
  return [
    {
      name: "public pages",
      probes: [
        {
          name: "marketing home",
          path: "/",
          expect: (r, found) => {
            const bad = html(r);
            if (bad) return bad;
            const og = /<meta property="og:image" content="([^"]+)"/.exec(r.body);
            if (!og) return "no og:image tag on the home page";
            found.ogImage = og[1].replace(/&amp;/g, "&");
            return null;
          },
        },
        { name: "login page", path: "/login", expect: html },
        { name: "robots.txt", path: "/robots.txt", expect: statusIs(200) },
      ],
    },
    {
      name: "share card",
      probes: [
        {
          name: "og:image from the home page",
          path: (found) => {
            if (!found.ogImage) throw new Error("the public-pages group found no og:image URL");
            const u = new URL(found.ogImage);
            return u.pathname + u.search;
          },
          expect: (r, found) => {
            const u = new URL(found.ogImage!);
            if (u.pathname !== "/opengraph-image-pwu6ef.png") return `og:image path ${u.pathname}, expected /opengraph-image-pwu6ef.png`;
            if (!/^\?[0-9a-f]{16}$/.test(u.search)) return `og:image URL ${u.search || "(no query)"} carries no content hash`;
            const bad = statusIs(200)(r);
            if (bad) return bad;
            if (r.headers.get("content-type") !== "image/png") return `content-type ${r.headers.get("content-type")}`;
            if (sha256(r.bytes) !== sha256(ogPng)) return `served ${r.bytes.length} bytes that are not the committed card`;
            if (!/immutable/.test(r.headers.get("cache-control") || "")) return `cache-control ${r.headers.get("cache-control")}`;
            return null;
          },
        },
        {
          name: "old card URL",
          path: "/opengraph-image-pwu6ef",
          expect: (r) =>
            statusIs(308)(r) ??
            (/\/opengraph-image-pwu6ef\.png$/.test(r.headers.get("location") || "") ? null : `location ${r.headers.get("location")}`),
        },
      ],
    },
    {
      name: "signed-in POST through lib/bridge-proxy's dynamic imports",
      probes: [{ name: "POST /api/bridge/exec-tool", method: "POST", path: "/api/bridge/exec-tool", signedIn: true, json: { tool_name: "Read", input: {} }, reachesDatabase: true }],
    },
    {
      name: "signed-in chat POST",
      probes: [{ name: "POST /api/chat", method: "POST", path: "/api/chat", signedIn: true, json: { chat_mode: "plan", messages: [{ role: "user", content: "hello" }] }, reachesDatabase: true }],
    },
    {
      name: "signed-in pages",
      probes: [
        { name: "GET /pipeline", path: "/pipeline", signedIn: true },
        { name: "GET /settings", path: "/settings", signedIn: true },
      ],
    },
    {
      name: "API and not-found",
      probes: [
        // Public, and answers 200 even when the session lookup fails: it logs
        // that failure, so it too must reach the database step.
        { name: "GET /api/health", path: "/api/health", expect: statusIs(200), reachesDatabase: true },
        { name: "unknown page", path: "/no-such-page-runtime-gate", signedIn: true, expect: statusIs(404) },
      ],
    },
  ];
}

async function request(base: string, probe: Probe, found: Found, cookie: string): Promise<Result> {
  const started = Date.now();
  const target = typeof probe.path === "function" ? probe.path(found) : probe.path;
  const headers: Record<string, string> = {};
  if (probe.signedIn) headers.cookie = `oasis_session=${cookie}`;
  if (probe.json !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(base + target, {
      method: probe.method || "GET",
      headers,
      body: probe.json === undefined ? undefined : JSON.stringify(probe.json),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, body: bytes.toString("latin1"), bytes, headers: res.headers, ms: Date.now() - started };
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { status: timeout ? "timeout" : "connect-error", body: "", bytes: Buffer.alloc(0), headers: new Headers(), ms: Date.now() - started };
  }
}

type GroupOutcome = { problems: string[]; log: string; lines: string[] };

async function runGroup(group: Group, index: number, secret: string, found: Found): Promise<GroupOutcome> {
  const port = 8800 + index;
  const args = [
    "wrangler", "dev",
    "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", String(9300 + index),
    "--show-interactive-dev-session=false",
    "--var", "EMPIRE_AUTH_BACKEND:turso",
    "--var", "EMPIRE_DATA_BACKEND:turso_cloud",
    "--var", `AUTH_SESSION_SECRET:${secret}`,
  ];
  // The log goes to a file, not a pipe: wrangler's access lines and the
  // Worker's console output arrive there while the process runs (pipes lost
  // them when the process was stopped right after a request).
  const logFile = path.join(tmpdir(), `worker-runtime-gate-${process.pid}-${index}.log`);
  const fd = openSync(logFile, "w");
  const child = spawn("npx", args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  closeSync(fd);
  const readLog = () => {
    try {
      return readFileSync(logFile, "utf8");
    } catch {
      return "";
    }
  };
  let exited = false;
  child.on("exit", () => (exited = true));
  const problems: string[] = [];
  const lines: string[] = [];
  const stop = async () => {
    if (!exited && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already gone
      }
      for (let i = 0; i < 50 && !exited; i++) await new Promise((r) => setTimeout(r, 200));
      if (!exited) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  };
  try {
    const started = Date.now();
    while (!new RegExp(`Ready on http://127\\.0\\.0\\.1:${port}`).test(readLog())) {
      if (exited) {
        problems.push(`${group.name}: wrangler dev exited before it was ready`);
        return { problems, log: "", lines };
      }
      if (Date.now() - started > READY_TIMEOUT_MS) {
        problems.push(`${group.name}: wrangler dev not ready after ${READY_TIMEOUT_MS / 1000}s`);
        return { problems, log: "", lines };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const ready = Date.now() - started;
    const cookie = mintSession(secret);
    for (const probe of group.probes) {
      const logBefore = readLog().length;
      let r: Result;
      try {
        r = await request(`http://127.0.0.1:${port}`, probe, found, cookie);
      } catch (err) {
        problems.push(`${group.name} / ${probe.name}: ${(err as Error).message}`);
        continue;
      }
      // wrangler writes its access line for a request after the response, and
      // the Worker's own console output around it. Wait for that line before
      // reading this request's share of the log, then a little longer.
      const target = typeof probe.path === "function" ? probe.path(found) : probe.path;
      const access = new RegExp(`\\[wrangler:info\\] ${probe.method || "GET"} ${escapeRegExp(target.split("?")[0])}[?\\s]`);
      for (let waited = 0; waited < ACCESS_LOG_WAIT_MS && !access.test(readLog().slice(logBefore)); waited += 100) {
        await new Promise((res) => setTimeout(res, 100));
      }
      await new Promise((res) => setTimeout(res, 1000));
      const own = readLog().slice(logBefore);
      if (!access.test(own)) lines.push(`  note: no access-log line for ${probe.name} within ${ACCESS_LOG_WAIT_MS / 1000}s`);
      const issues: string[] = [];
      if (r.status === "timeout" || r.status === "connect-error") issues.push(`${r.status} after ${r.ms}ms`);
      const bodyFailure = CHUNK_FAILURE.exec(r.body.slice(0, 200_000));
      if (bodyFailure) issues.push(`response body: ${bodyFailure[0]}`);
      for (const l of chunkFailureLines(own)) issues.push(`log: ${l.trim().slice(0, 240)}`);
      if (probe.reachesDatabase && !REACHED_DATABASE.test(own)) issues.push("never reached the database step (no 'Turso misconfigured' in the log)");
      const expected = probe.expect?.(r, found);
      if (expected) issues.push(expected);
      lines.push(`  ${issues.length ? "FAIL" : "ok  "} ${String(r.status).padEnd(7)} ${String(r.ms).padStart(5)}ms  ${group.name} / ${probe.name}`);
      for (const i of issues) problems.push(`${group.name} / ${probe.name}: ${i}`);
    }
    lines.unshift(`group "${group.name}": fresh workerd ready in ${ready}ms`);
    return { problems, log: readLog(), lines };
  } finally {
    await stop();
    try {
      unlinkSync(logFile);
    } catch {
      // already gone
    }
  }
}

function chunkHoldingTursoAuth(): number[] {
  const dir = path.join(SERVER_DIR, "chunks");
  return readdirSync(dir)
    .filter((n) => /^\d+\.js$/.test(n) && readFileSync(path.join(dir, n), "utf8").includes("AUTH_SESSION_SECRET missing/short"))
    .map((n) => Number(n.slice(0, -3)));
}

async function main(): Promise<number> {
  for (const needed of [SERVER_DIR, HANDLER, OG_PNG]) {
    if (!existsSync(needed)) {
      console.error(`check-worker-runtime: ${needed} is missing; run the OpenNext build first`);
      return 1;
    }
  }
  const started = Date.now();
  const secret = randomBytes(32).toString("hex");
  const found: Found = {};
  const problems: string[] = [];
  const all = groups();
  for (let i = 0; i < all.length; i++) {
    const out = await runGroup(all[i], i, secret, found);
    console.log(out.lines.join("\n"));
    problems.push(...out.problems);
    if (out.problems.length) console.log(`--- log of group "${all[i].name}" after Ready ---\n${afterReady(out.log).split("\n").slice(0, 120).join("\n")}`);
  }

  // Self-test: the same kind of request against a handler missing one chunk.
  const ids = chunkHoldingTursoAuth();
  if (ids.length === 0) {
    problems.push("self-test: found no chunk holding lib/turso-auth (marker 'AUTH_SESSION_SECRET missing/short'); update the marker");
  } else {
    const original = readFileSync(HANDLER, "utf8");
    copyFileSync(HANDLER, `${HANDLER}.runtime-gate-backup`);
    try {
      let mutated = original;
      let removed = 0;
      for (const id of ids) {
        const r = removeChunkCase(mutated, id);
        mutated = r.source;
        removed += r.removed;
      }
      if (removed === 0) {
        problems.push(`self-test: no inlined case for chunk(s) ${ids.join(", ")} in handler.mjs; the bundle's shape changed`);
      } else {
        writeFileSync(HANDLER, mutated);
        const probe: Probe = { name: "POST /api/bridge/exec-tool, chunk removed", method: "POST", path: "/api/bridge/exec-tool", signedIn: true, json: { tool_name: "Read", input: {} } };
        const out = await runGroup({ name: `self-test without chunk ${ids.join(", ")}`, probes: [probe] }, all.length, secret, found);
        console.log(out.lines.join("\n"));
        const caught = out.problems.some((p) => /Unknown chunk/.test(p));
        if (caught) {
          console.log(`  self-test: the gate reported the request that needed chunk ${ids.join(", ")} ("Unknown chunk"), as it must`);
        } else {
          problems.push(`self-test: with chunk ${ids.join(", ")} removed the gate reported nothing it could tie to it (${out.problems.join("; ") || "no problems"}); it cannot see a missing chunk`);
          console.log(`--- log of the self-test after Ready ---\n${afterReady(out.log).split("\n").slice(0, 120).join("\n")}`);
        }
      }
    } finally {
      writeFileSync(HANDLER, original);
    }
  }

  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  if (problems.length) {
    console.error(`check-worker-runtime: FAIL in ${minutes} min, ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(`check-worker-runtime: ${all.length} cold groups and the self-test passed in ${minutes} min`);
  return 0;
}

if (/check-worker-runtime\.ts$/.test(process.argv[1] || "")) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
