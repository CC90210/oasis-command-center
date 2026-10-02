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
 *      the frame still renders, whether the read returns an error or throws.
 *   2. The budget: not one fetch() while a Content page renders, frame or
 *      numbers. The database here is a local libSQL file, so any fetch at all
 *      would be a third party (Zernio, Meta, a sync run inline).
 *   3. Training: the add box renders with the frame, the counts and the list
 *      stream behind one boundary, the page says in plain words what the
 *      material is, what is in it and how to add to it, names no persona, and
 *      keeps a marked place for the Train tools track's Tools section above
 *      the material. A failed read, returned or thrown, is not "nothing in it
 *      yet".
 *   4. Overview: no card waits on another tab's data. The frame (title and the
 *      Performance card, which needs no read) arrives after the gate alone;
 *      the queue, the Library, Training and Requests cards each have their own
 *      boundary; the Training card reads only the training material and opens
 *      the Training tab, and a failed or thrown read of it stays in that card;
 *      one request reads the Library's summary once (React cache(), under
 *      React's own server renderer); Requests says what a request is and who
 *      acts on it; no persona name on any branch of the copy (work queued for
 *      the agent, nothing awaiting a verdict, a failed read).
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
import { Writable } from "node:stream";
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

/**
 * A page module loaded afresh with some of its readers replaced, so a check can
 * make a reader THROW rather than return an error: safe() is all that stands
 * between a throw and an error page over the whole tab. Every other check keeps
 * the real modules; the cache entries are put back before this returns.
 */
function freshPage(page: string, readers: Record<string, Record<string, unknown>>): () => Promise<unknown> {
  const pagePath = require.resolve(page);
  const saved = new Map<string, NodeModule | undefined>([[pagePath, require.cache[pagePath]]]);
  for (const [request, overrides] of Object.entries(readers)) {
    const p = require.resolve(request);
    saved.set(p, require.cache[p]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the real module is spread into the stub
    stub(request, { __esModule: true, ...require(request), ...overrides });
  }
  delete require.cache[pagePath];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh CommonJS instance of the page, which reads the stubs above
    return require(pagePath).default;
  } finally {
    for (const [p, m] of saved) {
      if (m) require.cache[p] = m;
      else delete require.cache[p];
    }
  }
}

/** What console.error and console.warn printed while fn ran: the server log. */
async function serverLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const { error, warn } = console;
  console.error = console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
  return lines;
}

const THROWN = "socket hang up (a reader that throws, content-speed)";

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
    CREATE TABLE marketing_asset (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, track TEXT, status TEXT NOT NULL,
      brand_slug TEXT NOT NULL, brand_name TEXT, author_email TEXT, published_at TEXT);
    CREATE TABLE marketing_review (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, acted_on_at TEXT);
    CREATE TABLE marketing_request (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT, status TEXT NOT NULL);
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
      {
        // OASIS's own: two waiting on a verdict, one live. One client asset, one for another tenant.
        sql: `INSERT INTO marketing_asset (id, tenant_id, track, status, brand_slug, brand_name, author_email, published_at) VALUES
              ('m1', ?, 'organic', 'in_review', 'oasis-ai', 'OASIS AI', ?, NULL),
              ('m2', ?, 'organic', 'draft', 'oasis-ai', 'OASIS AI', ?, NULL),
              ('m3', ?, 'paid', 'published', 'oasis-ai', 'OASIS AI', ?, ?),
              ('m4', ?, 'organic', 'in_review', 'warner', 'Warner', ?, NULL),
              ('m9', ?, 'organic', 'in_review', 'oasis-ai', 'OASIS AI', 'x', NULL)`,
        args: [OASIS, CC.email, OASIS, CC.email, OASIS, CC.email, daysAgo(1), OASIS, CC.email, OTHER],
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

  // -- 1d. ...and so does a read that THROWS --
  // getPerformance turns a query error into the degraded state itself, but has
  // no try/catch: a dropped connection or a client that cannot be built
  // rejects. safe() gives that the same state as 1c, inside the section, and
  // logs the reason; without it the throw escapes the boundary and an error
  // page replaces the whole tab.
  await check("a read that THROWS gets the same failure state inside the numbers section, with the reason in the server log", async () => {
    const Page = freshPage("../app/founders/marketing/performance/page", {
      "../lib/founders/performance-queries": {
        getPerformance: async () => {
          throw new Error(THROWN);
        },
      },
    });
    let text = "";
    const log = await serverLog(async () => {
      text = textOf(await resolve(await Page(), false));
    });
    assert.match(text, /Back to Content/, "the frame");
    assert.match(text, /The analytics read failed/);
    assert.match(text, /Could not read the metrics/);
    assert.doesNotMatch(text, /Nothing published in the last 30 days/, "a failure is not an empty month");
    assert.ok(log.some((l) => l.includes(THROWN)), `the reason is in the server log: ${log.join(" | ")}`);
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

  // ── 4. Overview: no card waits on another tab's data ─────────────────────
  const { default: MarketingPage } = await import("../app/founders/marketing/page");
  let overview: unknown = null;
  await check("Overview resolves after the gate with no marketing read; each section and card has its own boundary; Performance renders with the frame", async () => {
    statements.length = 0;
    const el = await MarketingPage();
    overview = await resolve(el, true);
    assert.deepEqual(statements.filter((s) => /marketing_/.test(s)), [], "the frame waits on no marketing read");
    const boundaries = hosts(overview).filter((h) => h.type === "suspense");
    assert.equal(boundaries.length, 5, "subtitle, the queue, and the Library, Training and Requests cards");
    for (const b of boundaries) assert.doesNotMatch(textOf(b.props.fallback), /\d/, "no number in a placeholder");
    const frameText = textOf(overview);
    assert.match(frameText, /Content/);
    assert.match(frameText, /Performance.*Per channel, with provenance.*Views, engagement and retention/s, "the Performance card needs no read");
    assert.ok(hosts(overview).some((h) => h.type === "a" && h.props.href === "/founders/marketing/performance"), "and links to its tab");
  });

  await check("the Training card reads only the training material; the Library, Requests and queue sections read the Library's summary", async () => {
    const boundaries = hosts(overview).filter((h) => h.type === "suspense");
    const read = async (b: Host) => {
      statements.length = 0;
      const tree = await resolve(b.props.pending, false);
      const text = textOf(tree);
      const tables = [...new Set(statements.map((s) => /FROM "?(\w+)"?/.exec(s)?.[1] ?? s))].sort();
      return { tree, text, tables };
    };
    // One boundary at a time, so every statement is attributed to its boundary.
    const out: Array<{ tree: unknown; text: string; tables: string[] }> = [];
    for (const b of boundaries) out.push(await read(b));
    const training = out.find((o) => /Training material/.test(o.text));
    assert.ok(training, `a Training card: ${out.map((o) => o.text.slice(0, 40)).join(" | ")}`);
    assert.deepEqual(training!.tables, ["marketing_corpus"], "the Training card does not wait on the Library's asset read");
    assert.match(training!.text, /1 learned · 1 being read/);
    assert.deepEqual(
      hosts(training!.tree).filter((h) => h.type === "a").map((h) => h.props.href),
      ["/founders/marketing/train"],
      "the card opens the Training tab, whose words it uses",
    );
    const library = out.find((o) => /A record of what shipped/.test(o.text))!;
    assert.match(library.text, /3 assets stored\./, "OASIS's own brand, this tenant: m1-m3, not the Warner asset or another tenant's");
    assert.ok(library.tables.includes("marketing_asset"));
    const queue = out.find((o) => /Needs you/.test(o.text))!;
    assert.match(queue.text, /2 assets\s*awaiting your verdict/, "draft + in review on the OASIS tab, this tenant only");
    assert.doesNotMatch(queue.text, /Couldn't load your queue/);
  });

  await check("the summary's three counts run together after the asset read, not one after another", async () => {
    const { getMarketingSummary } = await import("../lib/founders/marketing-queries");
    let requestAsked!: () => void;
    const requestSeen = new Promise<void>((r) => (requestAsked = r));
    const fake = {
      from(table: string) {
        let head = false;
        const api: Record<string, unknown> = {
          select(_c: string, o?: { head?: boolean }) { head = Boolean(o?.head); return api; },
          eq: () => api, is: () => api, in: () => api, order: () => api, range: () => api,
          then(done: (v: unknown) => void) {
            if (table === "marketing_asset") return done({ error: null, data: [{ id: "a1", track: "organic", status: "draft" }] });
            if (table === "marketing_request") { requestAsked(); return done({ error: null, count: 0 }); }
            // The review count answers only once a request count has been asked
            // for: run one after the other, the summary would never resolve.
            if (table === "marketing_review") { void requestSeen.then(() => done({ error: null, count: 1 })); return; }
            return done(head ? { error: null, count: 0 } : { error: null, data: [] });
          },
        };
        return api;
      },
    } as unknown as Parameters<typeof getMarketingSummary>[1];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const summary = await Promise.race([
        getMarketingSummary("t", fake),
        new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(new Error("the request count waited for the review count")), 2000);
        }),
      ]);
      assert.equal(summary.open_reviews, 1);
      assert.equal(summary.degraded, false);
    } finally {
      clearTimeout(timer);
    }
  });

  await check("Requests says what a request is and who acts on it; nothing on the Overview names a persona", async () => {
    const text = textOf(await resolve(await MarketingPage(), false));
    assert.match(text, /Requests/);
    assert.match(text, /Jobs for the marketing agent, not for you/);
    assert.match(text, /A request is a job for the marketing agent, such as .make three TikTok hooks for\s+the system ad., so the agent acts on it, not you\./);
    assert.match(text, /None open\./);
    assert.match(text, /Training material.*What the marketing agent learns from/s);
    assert.doesNotMatch(text, PERSONA, `a persona name or pronoun on the Overview: ${text.match(PERSONA)?.[0]}`);
  });

  // The seed has work awaiting CC's verdict and nothing queued for the agent,
  // so two branches of the queue's copy never render above: work handed to the
  // agent ("N with the marketing agent") and nothing awaiting a verdict. A
  // failed Library read has copy of its own as well.
  await check("no persona on the Overview's other branches: work queued for the agent, nothing awaiting your verdict, a failed read", async () => {
    // An open review on OASIS's own asset and an open request for the agent;
    // the two that awaited a verdict approved, so nothing awaits CC.
    await raw.batch(
      [
        { sql: `INSERT INTO marketing_review (id, tenant_id, asset_id, acted_on_at) VALUES ('r1', ?, 'm1', NULL)`, args: [OASIS] },
        { sql: `INSERT INTO marketing_request (id, tenant_id, asset_id, status) VALUES ('q1', ?, NULL, 'open')`, args: [OASIS] },
        `UPDATE marketing_asset SET status = 'approved' WHERE id IN ('m1', 'm2')`,
      ],
      "write",
    );
    try {
      const text = textOf(await resolve(await MarketingPage(), false));
      assert.match(text, /2 with the marketing agent/, "the review and the request, queued for the agent");
      assert.match(text, /Nothing waiting on you/);
      assert.match(text, /the most useful thing you can give it\./);
      assert.match(text, /1 open\./, "the Requests card counts the open request");
      assert.doesNotMatch(text, PERSONA, `a persona name or pronoun: ${text.match(PERSONA)?.[0]}`);
    } finally {
      await raw.batch(
        [
          `DELETE FROM marketing_review WHERE id = 'r1'`,
          `DELETE FROM marketing_request WHERE id = 'q1'`,
          `UPDATE marketing_asset SET status = 'in_review' WHERE id = 'm1'`,
          `UPDATE marketing_asset SET status = 'draft' WHERE id = 'm2'`,
        ],
        "write",
      );
    }
    // A broken Library read (a table of that name without the columns the
    // readers select): the queue, the Library and Requests each say so.
    await raw.execute("ALTER TABLE marketing_asset RENAME TO marketing_asset_away");
    await raw.execute("CREATE TABLE marketing_asset (id TEXT PRIMARY KEY, tenant_id TEXT)");
    try {
      const text = textOf(await resolve(await MarketingPage(), false));
      assert.match(text, /Couldn't load your queue/);
      assert.match(text, /Couldn't read the library\./);
      assert.match(text, /Couldn't read your requests\./);
      assert.doesNotMatch(text, PERSONA, `a persona name or pronoun: ${text.match(PERSONA)?.[0]}`);
    } finally {
      await raw.execute("DROP TABLE marketing_asset");
      await raw.execute("ALTER TABLE marketing_asset_away RENAME TO marketing_asset");
    }
  });

  await check("a failed training-material read stays in the Training card; the rest of the Overview renders", async () => {
    await raw.execute("ALTER TABLE marketing_corpus RENAME TO marketing_corpus_away");
    await raw.execute("CREATE TABLE marketing_corpus (id TEXT PRIMARY KEY, tenant_id TEXT)");
    try {
      const text = textOf(await resolve(await MarketingPage(), false));
      assert.match(text, /Couldn't read the training material\./);
      assert.doesNotMatch(text, /Nothing yet\. Add links on the Training tab\./);
      // The Library's numbers do not depend on the training material at all.
      assert.doesNotMatch(text, /Couldn't load your queue|Couldn't read the library/, "the queue and the Library are unaffected");
      assert.match(text, /2 assets\s*awaiting your verdict/);
      assert.match(text, /3 assets stored\./);
    } finally {
      await raw.execute("DROP TABLE marketing_corpus");
      await raw.execute("ALTER TABLE marketing_corpus_away RENAME TO marketing_corpus");
    }
  });

  // getCorpusStats builds its client in a default parameter, outside its own
  // try/catch, so a client that cannot be built REJECTS rather than returning
  // degraded. The Training tab and the Overview's card each wrap the read in
  // safe(); this holds both.
  await check("a training-material read that THROWS says so on the Training tab and in the Overview's card; the rest renders", async () => {
    const throwing = {
      "../lib/founders/marketing-queries": {
        getCorpusStats: async () => {
          throw new Error(THROWN);
        },
      },
    };
    const Train = freshPage("../app/founders/marketing/train/page", throwing);
    const Overview = freshPage("../app/founders/marketing/page", throwing);
    let train = "";
    let overviewText = "";
    const log = await serverLog(async () => {
      train = textOf(await resolve(await Train(), false));
      overviewText = textOf(await resolve(await Overview(), false));
    });
    assert.match(train, /Couldn't read the training material/);
    assert.doesNotMatch(train, /Nothing in it yet/);
    assert.match(train, /Add examples/, "the add box still renders");
    assert.match(overviewText, /Couldn't read the training material\./);
    assert.doesNotMatch(overviewText, /Nothing yet\. Add links on the Training tab\./);
    assert.match(overviewText, /3 assets stored\./, "the Library card is unaffected");
    assert.match(overviewText, /2 assets\s*awaiting your verdict/, "and so is the queue");
    assert.ok(log.some((l) => l.includes(THROWN)), `the reason is in the server log: ${log.join(" | ")}`);
  });

  // The subtitle, the queue, and the Library and Requests cards all show the
  // Library's summary; readSummary is React cache()d, so one request reads it
  // once. The small renderer above has no request scope (cache() passes
  // straight through outside one), so this renders the Overview with React's
  // own server renderer, the one Next streams pages with.
  await check("one request reads the Library's summary once, however many sections show it", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Next's vendored renderer is a CommonJS file with no type declarations
    const { renderToPipeableStream } = require("next/dist/compiled/react-server-dom-webpack/server.node") as {
      renderToPipeableStream: (
        model: unknown,
        clientManifest: unknown,
        options: { onError: (e: unknown) => void },
      ) => { pipe: (to: Writable) => Writable };
    };
    statements.length = 0;
    let payload = "";
    await new Promise<void>((done, fail) => {
      const sink = new Writable({
        write(chunk, _encoding, next) {
          payload += String(chunk);
          next();
        },
      });
      sink.on("finish", () => done());
      sink.on("error", fail);
      renderToPipeableStream(ReactNS.createElement(MarketingPage), {}, { onError: fail }).pipe(sink);
    });
    assert.match(payload, /3 assets stored\./, "the render finished, every boundary included");
    const reviews = statements.filter((s) => /FROM "?marketing_review"?/.test(s));
    assert.equal(reviews.length, 1, `the summary ran ${reviews.length} times in one request`);
  });

  // ── 2. the budget ────────────────────────────────────────────────────────
  // `fetches` has counted since the process started, so this covers every
  // render above (frames, numbers, the failure paths) and one more full one.
  await check("no fetch() at all while Performance, Training or the Overview renders: frames, numbers and the failure paths", async () => {
    await resolve(await PerformancePage(), false);
    await resolve(await TrainPage(), false);
    await resolve(await MarketingPage(), false);
    assert.deepEqual(fetches, [], "a page render reached the network outside its database");
  });

  origLog(`\n${passed} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  origLog(e);
  process.exit(1);
});
