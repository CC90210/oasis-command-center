/**
 * tests/content-speed.test.ts - the Content hub sends its frame before its
 * numbers, and makes no third-party call while it renders (W8b, 2026-10-01).
 *
 * CC, 2026-10-01: "clicking on the performance and whatnot, but it just takes
 * a while." Production Workers Logs: the Content tabs spend their time WAITING
 * on the database (Performance: 256-1,278 ms wall, 15-28 ms CPU), and every
 * page awaited all of its reads before it sent a byte. These pin:
 *
 *   1. Performance resolves after the founder gate with NO post_analytics read;
 *      its numbers sit behind one Suspense boundary whose fallback is an honest
 *      loading line (aria-busy, no digits), and they come from ONE bounded read
 *      of the stored snapshot. A failed read says so inside that section while
 *      the frame still renders.
 *   2. The budget: not one fetch() while the page renders, frame or numbers.
 *      The database here is a local libSQL file, so any fetch at all would be a
 *      third party (Zernio, Meta, a sync run inline).
 *
 * Real code paths: the real founder gate (a signed session checked against a
 * local libSQL file), the real readers and the real PostgREST bridge.
 * Statements are attributed through the app's own PERF_DB_VERBOSE seam
 * (lib/perf/server-timing.ts), which logs SQL text only.
 *
 * Run: node --conditions=react-server --import tsx tests/content-speed.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createClient } from "@libsql/client";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "6b6b6b6b-0000-4000-8000-00000000006b";
const CC = { id: "0f000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" };

const dbFile = join(mkdtempSync(join(tmpdir(), "content-speed-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "content-speed-test-secret-long-enough-0001";
process.env.FOUNDERS_TENANT_IDS = OASIS;
process.env.PERF_DB_VERBOSE = "1";
process.env.PERF_LOG = "0";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;

// The budget: every fetch is counted and refused.
const fetches: string[] = [];
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : (input as { url?: string })?.url || String(input);
  fetches.push(url);
  throw new Error(`network disabled in test: ${url.slice(0, 80)}`);
}) as typeof fetch;

// Every database statement, in order, from lib/perf/server-timing.ts.
const statements: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]) => {
  const s = String(args[0] ?? "");
  if (s.startsWith("[perf.db] ")) {
    try {
      statements.push(String(JSON.parse(s.slice(10)).sql));
    } catch {
      statements.push(s);
    }
    return;
  }
  origLog(...args);
};

// tsconfig sets jsx:"preserve", so tsx compiles page JSX with the classic
// runtime, which expects a global React.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === "oasis_session" && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: "oasis_session", value: sessionCookie }] : []),
    has: (name: string) => name === "oasis_session" && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  usePathname: () => "/founders/marketing",
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// The add box is a client component (useState): mounted, never rendered here.
{
  const p = join(__dirname, "..", "components/founders/TrainDropzone.tsx");
  require.cache[p] = {
    id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [],
    exports: { TrainDropzone: () => ReactNS.createElement("train-dropzone") },
  } as unknown as NodeModule;
}

/** Internal persona names, never on a page a founder or client reads (build rules). */
const PERSONA = /\b(?:Bravo|Maven|Atlas|Aura|Hermes|Lex|Conaugh)\b|\b(?:she|her)\b/i;

// ── a tiny server renderer ────────────────────────────────────────────────
// Resolves function and async components. With `stopAtSuspense`, a boundary is
// left as { type: "suspense", fallback, pending } so a check can see what the
// page sends BEFORE the boundary's own data arrives.
type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
type Host = { type: string; props: Record<string, unknown> & { children?: unknown } };
async function resolve(node: unknown, stopAtSuspense: boolean): Promise<unknown> {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return Promise.all(node.map((n) => resolve(n, stopAtSuspense)));
  if (typeof node !== "object" || !("type" in node)) return null;
  const el = node as El;
  if (el.type === ReactNS.Suspense) {
    if (stopAtSuspense) {
      return { type: "suspense", props: { fallback: await resolve(el.props.fallback, true), pending: el.props.children } };
    }
    return resolve(el.props.children, false);
  }
  if (el.type === ReactNS.Fragment) return resolve(el.props.children, stopAtSuspense);
  if (typeof el.type === "function") return resolve(await (el.type as (p: unknown) => unknown)(el.props), stopAtSuspense);
  if (typeof el.type === "object") return { type: "icon", props: {} }; // forwardRef/memo: lucide icons
  return { type: el.type, props: { ...el.props, children: await resolve(el.props.children, stopAtSuspense) } };
}
const hosts = (n: unknown): Host[] =>
  Array.isArray(n) ? n.flatMap(hosts) : n && typeof n === "object" && "props" in n ? [n as Host, ...hosts((n as Host).props.children)] : [];
const textOf = (n: unknown): string =>
  typeof n === "string" || typeof n === "number"
    ? String(n)
    : Array.isArray(n)
      ? n.map(textOf).join("")
      : n && typeof n === "object" && "props" in n
        ? textOf((n as Host).props.children)
        : "";

let failures = 0;
let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    origLog(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    origLog(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function main() {
  origLog("content-speed:");
  const raw = createClient({ url: `file:${dbFile}` });
  await raw.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, updated_at TEXT);
    CREATE TABLE post_analytics (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, zernio_post_id TEXT NOT NULL,
      platform_post_id TEXT NOT NULL, platform TEXT NOT NULL, account_username TEXT, asset_id TEXT,
      impressions INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0,
      likes INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0,
      shares INTEGER NOT NULL DEFAULT 0, saves INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0, follows INTEGER NOT NULL DEFAULT 0,
      engagement_rate REAL NOT NULL DEFAULT 0, avg_watch_s REAL, duration_s REAL,
      content_excerpt TEXT, published_at TEXT, last_synced_at TEXT NOT NULL, measured_at TEXT);
    CREATE INDEX idx_post_analytics_published ON post_analytics (tenant_id, published_at DESC);
    CREATE TABLE marketing_corpus (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL,
      label TEXT NOT NULL, title TEXT, source_url TEXT, state TEXT NOT NULL, last_error TEXT,
      contributed_by TEXT NOT NULL, created_at TEXT NOT NULL, indexed_at TEXT);
  `);
  const pa = (id: string, tenant: string, platform: string, views: number, likes: number, measured: boolean, days: number) => ({
    sql: `INSERT INTO post_analytics (id, tenant_id, zernio_post_id, platform_post_id, platform, views, likes,
            avg_watch_s, duration_s, content_excerpt, published_at, last_synced_at, measured_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, tenant, `z-${id}`, `pp-${id}`, platform, views, likes, platform === "instagram" ? 6 : null,
      platform === "instagram" ? 12 : null, `caption ${id}`, daysAgo(days), daysAgo(0), measured ? daysAgo(0) : null],
  });
  await raw.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [CC.id, CC.email] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, display_name, updated_at)
              VALUES ('p-cc', ?, ?, ?, 'owner', 1, ?, 'CC', 'CC', ?)`,
        args: [CC.id, CC.email, OASIS, daysAgo(30), daysAgo(30)],
      },
      pa("a1", OASIS, "instagram", 1200, 30, true, 2),
      pa("a2", OASIS, "tiktok", 800, 20, true, 3),
      pa("a3", OASIS, "youtube", 0, 0, false, 0), // dispatched, not measured yet
      pa("a4", OASIS, "instagram", 50_000, 9, true, 45), // outside the 30-day window
      pa("b1", OTHER, "instagram", 99_999, 99, true, 1), // another tenant
      {
        sql: `INSERT INTO marketing_corpus (id, tenant_id, kind, label, title, source_url, state, contributed_by, created_at, indexed_at)
              VALUES ('c1', ?, 'link', 'exemplar', 'A reel that works', 'https://www.instagram.com/reel/abc/', 'indexed', ?, ?, ?),
                     ('c2', ?, 'link', 'counter_example', NULL, 'https://example.com/bad-ad', 'queued', ?, ?, NULL),
                     ('c9', ?, 'link', 'exemplar', 'Not ours', 'https://example.com/x', 'indexed', 'x', ?, ?)`,
        args: [OASIS, CC.email, daysAgo(2), daysAgo(2), OASIS, CC.email, daysAgo(0), OTHER, daysAgo(1), daysAgo(1)],
      },
    ],
    "write",
  );
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: CC.id, email: CC.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });

  const { default: PerformancePage } = await import("../app/founders/marketing/performance/page");

  // ── 1. Performance: the frame first ──────────────────────────────────────
  let frame: unknown = null;
  await check("Performance resolves after the gate with no post_analytics read; the numbers wait behind one Suspense boundary", async () => {
    statements.length = 0;
    const el = await PerformancePage();
    const gate = [...statements];
    assert.ok(gate.some((s) => /_supabase_auth_users/.test(s)), `the real gate ran: ${gate.join(" | ")}`);
    assert.deepEqual(gate.filter((s) => /post_analytics/.test(s)), [], "the page itself must not wait on the read");
    frame = await resolve(el, true);
    assert.deepEqual(statements.filter((s) => /post_analytics/.test(s)), [], "nor anything the frame renders");
    const text = textOf(frame);
    assert.match(text, /Performance/);
    assert.match(text, /Back to Content/);
    const boundaries = hosts(frame).filter((h) => h.type === "suspense");
    assert.equal(boundaries.length, 1, "one boundary around the numbers");
    const fallback = boundaries[0].props.fallback;
    assert.ok(hosts(fallback).some((h) => h.props["aria-busy"] === "true"), "the fallback says it is busy");
    assert.match(textOf(fallback), /Loading/, "and says so in words");
    assert.doesNotMatch(textOf(fallback), /\d/, "no number in a placeholder: it would be read as data");
  });

  // ── 1b. ...then the real numbers from one bounded read ──────────────────
  await check("the numbers stream from ONE bounded read of the stored snapshot, this tenant and window only", async () => {
    const boundary = hosts(frame).find((h) => h.type === "suspense")!;
    statements.length = 0;
    const numbers = await resolve(boundary.props.pending, false);
    const reads = statements.filter((s) => /post_analytics/.test(s));
    assert.equal(reads.length, 1, `one read: ${statements.join(" | ")}`);
    assert.match(reads[0], /LIMIT (?:\d+|\?)/, "bounded");
    const text = textOf(numbers);
    assert.match(text, /2 posts · last 30 days/, text.slice(0, 300));
    assert.match(text, /2,000/, "1,200 + 800 views: the other tenant's 99,999 and the 45-day-old 50,000 are not in it");
    assert.doesNotMatch(text, /99,999|50,000|51,200/);
    assert.match(text, /1 post published\s+recently has no numbers yet/, "the unmeasured post is reported, not summed");
  });

  // ── 1c. a failed read stays inside its section ───────────────────────────
  await check("a failed read says so inside the numbers section; the frame still renders", async () => {
    await raw.execute("ALTER TABLE post_analytics RENAME TO post_analytics_away");
    try {
      const el = await PerformancePage();
      const tree = await resolve(el, false);
      const text = textOf(tree);
      assert.match(text, /Back to Content/, "the frame");
      assert.match(text, /The analytics read failed/);
      assert.match(text, /Could not read the metrics/);
      assert.doesNotMatch(text, /Nothing published in the last 30 days/, "a failure is not an empty month");
    } finally {
      await raw.execute("ALTER TABLE post_analytics_away RENAME TO post_analytics");
    }
  });

  // ── 3. Training: the add box with the frame, the contents streamed ───────
  const { default: TrainPage } = await import("../app/founders/marketing/train/page");
  await check("Training renders its frame and the add box with no corpus read; the counts and the list stream behind one boundary", async () => {
    statements.length = 0;
    const frame = await resolve(await TrainPage(), true);
    assert.deepEqual(statements.filter((s) => /marketing_corpus/.test(s)), [], "nothing waits on the corpus read");
    assert.ok(hosts(frame).some((h) => h.type === "train-dropzone"), "the add box is in the frame");
    const boundaries = hosts(frame).filter((h) => h.type === "suspense");
    assert.equal(boundaries.length, 1);
    assert.doesNotMatch(textOf(boundaries[0].props.fallback), /\d/, "no number in a placeholder");
    statements.length = 0;
    const contents = textOf(await resolve(boundaries[0].props.pending, false));
    assert.ok(statements.some((s) => /marketing_corpus/.test(s)), "the boundary does the reading");
    assert.match(contents, /Learned1/, "one learned, this tenant only");
    assert.match(contents, /Being read1/);
    assert.match(contents, /Never do this1/);
    assert.match(contents, /What is in it/);
    assert.match(contents, /A reel that works/);
    assert.doesNotMatch(contents, /Not ours/, "another tenant's material");
  });

  await check("Training says, in plain words, what it is, what is in it and how to add to it; no persona name; Tools has its place above it", async () => {
    const text = textOf(await resolve(await TrainPage(), false));
    assert.match(text, /what the marketing agent learns from/i, "what it is");
    assert.match(text, /reels, TikToks, YouTube\s+videos, GitHub repos and articles/, "what goes in it");
    assert.match(text, /Every five minutes a background job reads each new link/, "what happens to it (the Training Corpus Ingest job's schedule)");
    assert.match(text, /Add examples/);
    assert.match(text, /Paste or drop links/, "how to add to it");
    assert.match(text, /Do more of this, Never do this, or Just context/);
    assert.doesNotMatch(text, PERSONA, `a persona name or pronoun on the page: ${text.match(PERSONA)?.[0]}`);
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(__dirname, "..", "app/founders/marketing/train/page.tsx"), "utf8");
    const tools = src.indexOf("TOOLS: the Train tools track");
    const material = src.indexOf('aria-labelledby="training-material"');
    assert.ok(tools > 0 && material > tools, "the Tools place is marked, above the training material section");
    const { CORPUS_LABEL_COPY } = await import("../lib/founders/ingest-core");
    for (const [k, v] of Object.entries(CORPUS_LABEL_COPY)) {
      assert.doesNotMatch(`${v.title} ${v.help}`, PERSONA, `label ${k} names a persona`);
    }
  });

  await check("a failed corpus read says it could not read the material, never 'nothing in it yet'", async () => {
    // A broken read, not a missing table (that one is the honest pre-migration
    // empty): a table of the same name without the columns the read selects.
    await raw.execute("ALTER TABLE marketing_corpus RENAME TO marketing_corpus_away");
    await raw.execute("CREATE TABLE marketing_corpus (id TEXT PRIMARY KEY, tenant_id TEXT)");
    try {
      const text = textOf(await resolve(await TrainPage(), false));
      assert.match(text, /Couldn't read the training material/);
      assert.doesNotMatch(text, /Nothing in it yet/);
    } finally {
      await raw.execute("DROP TABLE marketing_corpus");
      await raw.execute("ALTER TABLE marketing_corpus_away RENAME TO marketing_corpus");
    }
  });

  // ── 2. the budget ────────────────────────────────────────────────────────
  // `fetches` has counted since the process started, so this covers every
  // render above (frame, numbers, the failure paths) and one more full one.
  await check("no fetch() at all while Performance or Training renders: frames, numbers and the failure paths", async () => {
    await resolve(await PerformancePage(), false);
    await resolve(await TrainPage(), false);
    assert.deepEqual(fetches, [], "a page render reached the network outside its database");
  });

  origLog(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  origLog(e);
  process.exit(1);
});
