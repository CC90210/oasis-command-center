/**
 * no-subscription-infer-outside-router.test.ts — nothing reaches OASIS's
 * Claude subscription except through lib/ai/infer.ts, and that router refuses
 * every tenant that is not OASIS's own.
 *
 * WHY (docs/os-revamp/03-connectors-ai-finance.md F1, §a.4.6). The
 * subscription transport (lib/subscription-infer.ts inferText and
 * lib/bridge-infer.ts queueInfer / inferTextWithFallback) runs a prompt on the
 * Claude CLI under a personal Max plan. Fourteen call sites imported it
 * directly and passed whatever tenant they served, so a client's lead, SMS or
 * deal email became work on that plan. Locked decision #6: client work never
 * runs on CC's personal subscription.
 *
 * Two halves, because either alone proves nothing:
 *   1. STATIC. Only the router (and the two transport modules, which are one
 *      layer: subscription-infer wraps bridge-infer's queue) may import the
 *      transport. A new file that imports it directly fails here, before it
 *      can ship a way around the gate. Same reasoning as
 *      tests/portal-boundaries.test.ts: "nobody bypasses the router" is a
 *      property of the whole tree, which only a scan of the tree can establish.
 *   2. BEHAVIOURAL. The router itself, run against a real temp libSQL
 *      inference_jobs table: a client, retired SunBiz, an unknown id or no
 *      tenant is refused loudly and terminally, with NO job queued and no
 *      bridge contacted; an OASIS tenant still reaches the same queue as before.
 *
 * Run: node --conditions=react-server --import tsx tests/no-subscription-infer-outside-router.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, sep } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "no-subscription-infer-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("BRIDGE_")) delete process.env[key];
}

const ROOT = join(__dirname, "..");
const ROUTER = "lib/ai/infer.ts";
const TRANSPORT = ["lib/subscription-infer", "lib/bridge-infer"] as const;
/** The transport's own internal import (subscription-infer → bridge-infer). */
const TRANSPORT_FILES = new Set(["lib/subscription-infer.ts", "lib/bridge-infer.ts"]);

const SOURCE_DIRS = ["app", "lib", "components", "scripts", "workers"];
const ROOT_FILES = ["middleware.ts", "open-next.config.ts", "next.config.js"];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".open-next", ".git", "__pycache__"]);

// `from "x"`, `import "x"`, `import("x")`, `require("x")`, `export … from "x"`.
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Repo-relative path, extension stripped, that `spec` resolves to — or null
 *  for a package import. */
function resolveSpecifier(fromRel: string, spec: string): string | null {
  let target: string;
  if (spec.startsWith("@/")) target = spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) target = posix.join(posix.dirname(fromRel), spec);
  else return null;
  return posix.normalize(target).replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

function transportImportsIn(fromRel: string, src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(SPECIFIER_RE)) {
    const target = resolveSpecifier(fromRel, m[1]);
    if (target && (TRANSPORT as readonly string[]).includes(target)) hits.push(target);
  }
  return hits;
}

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
const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/");

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OASIS_WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d";
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const CLIENT = "9f9f9f9f-0000-4000-8000-00000000009f";

async function main() {
  console.log("no-subscription-infer-outside-router:");

  // ── 1. static ─────────────────────────────────────────────────────────
  await check("the import matcher sees every import form and ignores strings that are not imports", () => {
    const hits = (from: string, src: string) => transportImportsIn(from, src);
    assert.deepEqual(hits("lib/x.ts", `import { queueInfer } from "@/lib/bridge-infer";`), ["lib/bridge-infer"]);
    assert.deepEqual(hits("lib/x.ts", `import { inferText } from "./subscription-infer";`), ["lib/subscription-infer"]);
    assert.deepEqual(hits("lib/sms/x.ts", `const m = await import("../bridge-infer");`), ["lib/bridge-infer"]);
    assert.deepEqual(hits("app/api/x/route.ts", `const m = require("@/lib/subscription-infer.ts");`), ["lib/subscription-infer"]);
    assert.deepEqual(hits("lib/x.ts", `export { queueInfer } from "@/lib/bridge-infer";`), ["lib/bridge-infer"]);
    assert.deepEqual(hits("lib/x.ts", `import type { InferTextResult } from "@/lib/subscription-infer";`), ["lib/subscription-infer"]);
    // lib/portals/registry.ts lists the path as a string; that is not an import.
    assert.deepEqual(hits("lib/portals/registry.ts", `export const SHARED = ["lib/bridge-infer", "lib/queries"];`), []);
    assert.deepEqual(hits("lib/x.ts", `import { inferForTenant } from "@/lib/ai/infer";`), []);
  });

  await check("no file other than lib/ai/infer.ts imports subscription-infer or bridge-infer", () => {
    const files = [
      ...SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d))),
      ...ROOT_FILES.map((f) => join(ROOT, f)).filter((f) => {
        try {
          return statSync(f).isFile();
        } catch {
          return false;
        }
      }),
    ];
    // Anti-vacuity: a broken walk would pass and prove nothing.
    assert.ok(files.length > 500, `only ${files.length} source files walked — the scan is broken`);
    assert.ok(files.some((f) => rel(f) === ROUTER), "the walk never reached the router");

    const violations: string[] = [];
    let routerEdges = 0;
    for (const file of files) {
      const from = rel(file);
      for (const target of transportImportsIn(from, readFileSync(file, "utf8"))) {
        if (from === ROUTER) {
          routerEdges += 1;
          continue;
        }
        if (TRANSPORT_FILES.has(from)) continue;
        violations.push(`  ${from} -> ${target}`);
      }
    }
    // The router really imports the transport, so the matcher really matches.
    assert.ok(routerEdges >= 2, `the router's own transport imports were not seen (${routerEdges}) — the matcher is broken`);
    assert.equal(
      violations.length,
      0,
      `Direct imports of the subscription transport (${violations.length}):\n${violations.join("\n")}\n\n` +
        `Import inferForTenant / queueInferForTenant / inferTextWithFallbackForTenant from lib/ai/infer.ts\n` +
        `and pass the tenant you already have. Only OASIS's own tenants may run on the subscription.`,
    );
  });

  // ── 2. behavioural ────────────────────────────────────────────────────
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE inference_jobs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, source TEXT NOT NULL, system TEXT, prompt TEXT NOT NULL,
      model_tier TEXT NOT NULL DEFAULT 'fast', max_tokens INTEGER NOT NULL DEFAULT 1024,
      status TEXT NOT NULL DEFAULT 'pending', result_text TEXT, error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      claimed_at TEXT, completed_at TEXT
    );
  `);
  // The router records every request in ai_usage_events (lib/ai/usage.ts);
  // tests/ai-usage-ledger.test.ts pins those rows.
  await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__192_ai_usage.sql"), "utf8"));
  const jobs = async (tenantId: string | null) =>
    Number(
      (
        await db.execute({
          sql: tenantId === null
            ? "SELECT COUNT(*) AS n FROM inference_jobs WHERE tenant_id IS NULL"
            : "SELECT COUNT(*) AS n FROM inference_jobs WHERE tenant_id = ?",
          args: tenantId === null ? [] : [tenantId],
        })
      ).rows[0].n,
    );

  const networkCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    networkCalls.push(String(input));
    throw new Error("no network in this test");
  }) as typeof fetch;

  const router = await import("../lib/ai/infer");

  /** Run fn with console.error captured; returns the captured lines. */
  async function loud(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
    try {
      await fn();
    } finally {
      console.error = original;
    }
    return lines;
  }
  const refused = (error: string) => error.startsWith(`${router.MANAGED_RUNTIME_NOT_CONFIGURED}:`);

  await check("inferForTenant refuses a client, SunBiz, an unknown id and no tenant — loudly, terminally, nothing queued", async () => {
    for (const tenant of [CLIENT, SUNBIZ, null, "", "oasis-ai-cc"]) {
      let result: Awaited<ReturnType<typeof router.inferForTenant>> | null = null;
      const logged = await loud(async () => {
        result = await router.inferForTenant(tenant, {
          source: "router-test",
          system: "s",
          prompt: "p",
          maxTokens: 10,
          timeoutMs: 50,
        });
      });
      assert.ok(result);
      const r = result as Awaited<ReturnType<typeof router.inferForTenant>>;
      assert.equal(r.ok, false, `tenant ${tenant}`);
      if (!r.ok) {
        assert.equal(r.pending, false, "a refusal is terminal: the caller must not defer-and-retry it");
        assert.ok(refused(r.error), r.error);
      }
      assert.ok(logged.some((l) => l.includes(router.MANAGED_RUNTIME_NOT_CONFIGURED)), "the refusal must be logged");
    }
    assert.equal(await jobs(CLIENT), 0);
    assert.equal(await jobs(SUNBIZ), 0);
    assert.equal(await jobs(null), 0);
  });

  await check("queueInferForTenant refuses a non-OASIS tenant with timedOut:false and queues nothing", async () => {
    await loud(async () => {
      const r = await router.queueInferForTenant(
        { source: "router-test-queue", prompt: "p", tenantId: SUNBIZ, dedupeKey: "k1" },
        { timeoutMs: 50, pollMs: 10 },
      );
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.timedOut, false);
        assert.ok(refused(r.error), r.error);
      }
    });
    assert.equal(await jobs(SUNBIZ), 0);
  });

  await check("inferTextWithFallbackForTenant refuses before the bridge or the queue is touched", async () => {
    await loud(async () => {
      await assert.rejects(
        router.inferTextWithFallbackForTenant(CLIENT, {
          system: "s",
          prompt: "p",
          bridgeTarget: { baseUrl: "https://bridge.example.test", bearerToken: "t" },
          maxTokens: 10,
          queueTimeoutMs: 50,
        }),
        (e: Error) => refused(e.message),
      );
    });
    assert.deepEqual(networkCalls, [], "a refused tenant reached a bridge");
    assert.equal(await jobs(CLIENT), 0);
  });

  await check("an OASIS tenant still reaches the subscription queue (unchanged path)", async () => {
    const r = await router.inferForTenant(OASIS, {
      source: "router-test-oasis",
      system: "s",
      prompt: "p",
      maxTokens: 10,
      timeoutMs: 10,
    });
    // No daemon drains the temp queue, so the job is left pending: exactly
    // what the real transport reports when the daemon is slower than the caller.
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.pending, true, r.error);
      assert.ok(!refused(r.error));
    }
    assert.equal(await jobs(OASIS), 1);
  });

  await check("the other OASIS tenant collects a finished job through queueInferForTenant", async () => {
    const args = { source: "router-test-webdev", prompt: "p", tenantId: OASIS_WEBDEV, dedupeKey: "webdev1" };
    const first = await router.queueInferForTenant(args, { timeoutMs: 10, pollMs: 5 });
    assert.equal(first.ok, false);
    assert.equal(await jobs(OASIS_WEBDEV), 1);
    // Play the daemon: complete the queued job.
    await db.execute({
      sql: "UPDATE inference_jobs SET status = 'complete', result_text = 'answer' WHERE tenant_id = ?",
      args: [OASIS_WEBDEV],
    });
    const second = await router.queueInferForTenant(args, { timeoutMs: 10, pollMs: 5 });
    assert.deepEqual(second, { ok: true, text: "answer", reused: true });
  });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("subscription inference router tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
