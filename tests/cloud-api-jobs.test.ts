import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createClient, type Client, type InStatement } from "@libsql/client";
import { NextRequest } from "next/server";
import { cloudJobDryRun, cloudJobEnabled, OASIS_OPERATOR_TENANT_ID } from "../lib/cloud-jobs/control";
import {
  configuredServiceChecks,
  runServiceChecks,
  SERVICE_CHECK_NAMES,
  serviceHealthVerdict,
} from "../lib/cloud-jobs/service-checks";
import {
  parseEventTimestamp,
  runEventBusRetention,
  staleEventRows,
} from "../lib/cloud-jobs/event-bus-retention";
import {
  isZernioTracked,
  MIN_LIBRARY_HOOK,
  normalizePostText,
  planLibraryPostLinks,
  runLibraryPostLinker,
  type AnalyticsPost,
  type LibraryAsset,
} from "../lib/cloud-jobs/library-post-linker";
import {
  fetchAllZernioAnalytics,
  rowsFromZernio,
  runPostAnalyticsSync,
} from "../lib/cloud-jobs/post-analytics-sync";

const NOW = new Date("2026-10-30T01:00:00.000Z");
const HOOK = "the road they gave you ends here";

function asset(id: string, patch: Partial<LibraryAsset> = {}): LibraryAsset {
  return {
    id,
    tenant_id: OASIS_OPERATOR_TENANT_ID,
    title: "An Asset",
    hook: HOOK,
    published_at: null,
    platforms: null,
    status: "in_review",
    brand_slug: "oasis-ai",
    meta: "{}",
    ...patch,
  };
}

function post(id: string, patch: Partial<AnalyticsPost> = {}): AnalyticsPost {
  return {
    id,
    tenant_id: OASIS_OPERATOR_TENANT_ID,
    platform: "instagram",
    platform_post_id: `pp-${id}`,
    content_excerpt: HOOK,
    published_at: "2026-08-14T14:36:21Z",
    asset_id: null,
    ...patch,
  };
}

test("each migrated route reads its own off-switch before cron auth", () => {
  const routes: Array<[string, string]> = [
    ["service-checks", "SERVICE_CHECKS_ENABLED"],
    ["event-bus-retention", "EVENT_BUS_RETENTION_ENABLED"],
    ["library-post-linker", "LIBRARY_POST_LINKER_ENABLED"],
    ["post-analytics-sync", "POST_ANALYTICS_SYNC_ENABLED"],
  ];
  for (const [route, key] of routes) {
    const source = readFileSync(`app/api/cron/${route}/route.ts`, "utf8");
    const switchAt = source.indexOf(`cloudJobEnabled(\"${key}\")`);
    const authAt = source.indexOf("checkCronAuth(request)");
    assert.ok(switchAt >= 0, `${route} lost ${key}`);
    assert.ok(authAt > switchAt, `${route} must read ${key} before any auth/database/provider work`);
  }
  assert.equal(cloudJobEnabled("X", {}), false);
  assert.equal(cloudJobEnabled("X", { X: "off" }), false);
  assert.equal(cloudJobEnabled("X", { X: "on" }), true);
  assert.equal(
    cloudJobDryRun(new Request("https://example.test/job?dry_run=1"), "X_DRY", {}),
    true,
  );

  const deploy = readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8");
  const bindings = [
    ...routes.map(([, key]) => key),
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "HOSTINGER_API_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "FIRECRAWL_API_KEY",
    "WISE_API_TOKEN",
    "LATE_API_KEY",
  ];
  for (const key of bindings) {
    assert.match(
      deploy,
      new RegExp(`^\\s+${key}: \\$\\{\\{ secrets\\.${key} \\}\\}$`, "m"),
      `Cloudflare deploy workflow lost the ${key} binding`,
    );
  }
});

test("library linker route makes unresolved conflicts visible to cron health", () => {
  const source = readFileSync("app/api/cron/library-post-linker/route.ts", "utf8");
  assert.match(source, /result\.conflicts\.length > 0/);
  assert.match(source, /error: "library_post_linker_conflicts"/);
  assert.match(source, /status: 409/);
});

test("service checks preserve provider verdicts and config-only test mode performs no I/O", async () => {
  assert.deepEqual(serviceHealthVerdict(200), { status: "healthy", error: null });
  assert.equal(serviceHealthVerdict(401).status, "down");
  assert.deepEqual(serviceHealthVerdict(503), {
    status: "degraded",
    error: "the service answered HTTP 503",
  });
  assert.deepEqual(serviceHealthVerdict(0), {
    status: "degraded",
    error: "the service could not be reached",
  });
  const env = {
    CLOUDFLARE_API_TOKEN: "cf-test",
    CLOUDFLARE_ACCOUNT_ID: "account-test",
    HOSTINGER_API_TOKEN: "host-test",
    GITHUB_PERSONAL_ACCESS_TOKEN: "github-test",
    FIRECRAWL_API_KEY: "firecrawl-test",
    WISE_API_TOKEN: "wise-test",
  };
  assert.deepEqual(configuredServiceChecks(env), {
    cloudflare: true,
    hostinger: true,
    github: true,
    firecrawl: true,
    wise: true,
  });
  let touched = false;
  const dry = await runServiceChecks({
    env,
    dryRun: true,
    db: { execute: async () => { touched = true; throw new Error("db touched"); } } as unknown as Pick<Client, "execute">,
    fetchImpl: async () => { touched = true; throw new Error("network touched"); },
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.dry_run_scope, "config_only");
  assert.equal(touched, false, "service-check test mode must make no DB or provider call");
});

test("service checks authenticate read-only calls and write only the scoped OASIS health row", async () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "cf-secret",
    HOSTINGER_API_TOKEN: "host-secret",
    GITHUB_TOKEN: "github-secret",
    FIRECRAWL_API_KEY: "fire-secret",
    WISE_API_TOKEN: "wise-secret",
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const writes: InStatement[] = [];
  const db = {
    async execute(statement: string | InStatement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.includes("FROM user_profiles")) {
        return { rows: [{ id: "profile-cc", tenant_id: OASIS_OPERATOR_TENANT_ID }], rowsAffected: 0 };
      }
      writes.push(statement as InStatement);
      return { rows: [], rowsAffected: 1 };
    },
  } as unknown as Pick<Client, "execute">;
  const result = await runServiceChecks({
    db,
    env,
    dryRun: false,
    now: () => NOW,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.dry_run_scope, "live");
  assert.equal(calls.length, 5);
  assert.equal(writes.length, 5);
  for (const write of writes) {
    assert.match(write.sql, /WHERE integrations_health\.tenant_id = excluded\.tenant_id/);
    assert.equal(write.args?.[0], OASIS_OPERATOR_TENANT_ID);
  }
  for (const call of calls) {
    assert.ok(!Object.values(env).some((secret) => call.url.includes(secret)), "a key leaked into a URL");
    const headers = new Headers(call.init?.headers);
    assert.match(headers.get("authorization") || "", /^Bearer /);
  }
});

test("service checks map cross-runtime fetch transport failures to status zero", async () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "cf-test",
    HOSTINGER_API_TOKEN: "host-test",
    GITHUB_PERSONAL_ACCESS_TOKEN: "github-test",
    FIRECRAWL_API_KEY: "firecrawl-test",
    WISE_API_TOKEN: "wise-test",
  };
  const writes: InStatement[] = [];
  const db = {
    async execute(statement: string | InStatement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.includes("FROM user_profiles")) {
        return { rows: [{ id: "profile-cc", tenant_id: OASIS_OPERATOR_TENANT_ID }], rowsAffected: 0 };
      }
      writes.push(statement as InStatement);
      return { rows: [], rowsAffected: 1 };
    },
  } as unknown as Pick<Client, "execute">;
  const result = await runServiceChecks({
    db,
    env,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("cloudflare.com")) throw new TypeError("fetch failed");
      if (url.includes("hostinger.com")) {
        throw Object.assign(new Error("the deadline elapsed"), { name: "TimeoutError" });
      }
      if (url.includes("github.com")) {
        throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
      }
      if (url.includes("firecrawl.dev")) throw new TypeError("NetworkError when attempting to fetch resource.");
      throw Object.assign(new Error("wrapped transport failure"), {
        cause: Object.assign(new Error("connect deadline"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      });
    },
  });
  assert.deepEqual(result.results.map(({ http, status }) => ({ http, status })),
    SERVICE_CHECK_NAMES.map(() => ({ http: 0, status: "degraded" })));
  assert.equal(writes.length, SERVICE_CHECK_NAMES.length);
  assert.ok(writes.every((write) => JSON.parse(String(write.args?.[6])).http === 0));
});

test("service checks let unexpected adapter defects reach the route's logged 500", async () => {
  const prior = {
    CRON_SECRET: process.env.CRON_SECRET,
    SERVICE_CHECKS_ENABLED: process.env.SERVICE_CHECKS_ENABLED,
    TURSO_DB_PATH: process.env.TURSO_DB_PATH,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    HOSTINGER_API_TOKEN: process.env.HOSTINGER_API_TOKEN,
    GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
    WISE_API_TOKEN: process.env.WISE_API_TOKEN,
  };
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const logged: unknown[][] = [];
  try {
    Object.assign(process.env, {
      CRON_SECRET: "cron-test",
      SERVICE_CHECKS_ENABLED: "on",
      TURSO_DB_PATH: ":memory:",
      CLOUDFLARE_API_TOKEN: "cf-test",
      HOSTINGER_API_TOKEN: "host-test",
      GITHUB_PERSONAL_ACCESS_TOKEN: "github-test",
      FIRECRAWL_API_KEY: "firecrawl-test",
      WISE_API_TOKEN: "wise-test",
    });
    globalThis.fetch = async () => {
      throw new TypeError("adapter accessed an undefined response field");
    };
    console.error = (...args: unknown[]) => { logged.push(args); };
    const { GET } = await import("../app/api/cron/service-checks/route");
    const response = await GET(new NextRequest("https://example.test/api/cron/service-checks", {
      headers: { authorization: "Bearer cron-test", "x-vercel-cron": "1" },
    }));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, error: "service_checks_failed" });
    assert.equal(logged.length, 1);
    assert.equal(logged[0][0], "[cron.service-checks]");
    assert.match(String(logged[0][1]), /adapter accessed an undefined response field/);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("event retention leaves current/undateable rows alone and scopes every write to selected pending ids", async () => {
  assert.equal(parseEventTimestamp("2026-08-28 04:07:44")?.toISOString(), "2026-08-28T04:07:44.000Z");
  assert.equal(parseEventTimestamp("not-a-date"), null);
  const selected = [
    { id: "old", event_type: "X", published_at: "2026-08-01T00:00:00Z", created_at: null },
    { id: "new", event_type: "Y", published_at: "2026-10-20T00:00:00Z", created_at: null },
    { id: "unknown", event_type: "Z", published_at: null, created_at: null },
  ];
  assert.deepEqual(staleEventRows(selected, new Date("2026-09-30T00:00:00Z")).map((row) => row.id), ["old"]);
  const writes: InStatement[] = [];
  const db = {
    async execute(statement: string | InStatement) {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.includes("SELECT id")) return { rows: selected, rowsAffected: 0 };
      writes.push(statement as InStatement);
      return { rows: [], rowsAffected: 1 };
    },
  } as unknown as Pick<Client, "execute">;
  const dry = await runEventBusRetention({ db, dryRun: true, now: NOW });
  assert.equal(dry.stale_found, 1);
  assert.equal(dry.dry_run_scope, "database_read_only");
  assert.equal(writes.length, 0);
  const live = await runEventBusRetention({ db, dryRun: false, now: NOW });
  assert.equal(live.dry_run_scope, "live");
  assert.equal(live.marked, 1);
  assert.equal(live.failed, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /WHERE status = 'pending' AND id IN/);
  assert.ok(writes[0].args?.includes("old"));
  assert.ok(!writes[0].args?.includes("new"));
});

test("library linker preserves the Python precision rules", () => {
  assert.equal(normalizePostText("It’s — done"), normalizePostText("It's - done"));
  assert.ok("join the waitlist".length < MIN_LIBRARY_HOOK);
  assert.equal(planLibraryPostLinks([asset("a", { hook: "join the waitlist" })], [post("p")]).skipped_short_hook, 1);
  assert.equal(
    planLibraryPostLinks([asset("a")], [post("p", { tenant_id: "another-tenant" })]).linkable_assets,
    0,
  );
  const ambiguous = planLibraryPostLinks([asset("a"), asset("b")], [post("p")]);
  assert.equal(ambiguous.ambiguous_posts, 1);
  assert.equal(ambiguous.linkable_assets, 0);
  const conflict = planLibraryPostLinks([asset("a")], [post("p", { asset_id: "someone-elses-asset" })]);
  assert.equal(conflict.linkable_assets, 0);
  assert.deepEqual(conflict.conflicts, [{
    post_id: "p",
    planned_asset_id: "a",
    existing_asset_id: "someone-elses-asset",
    reason: "already_linked",
  }]);
  const repost = planLibraryPostLinks(
    [asset("a", { title: "Tick Tax" })],
    [
      post("p1", { published_at: "2026-08-04T12:00:00Z" }),
      post("p2", { published_at: "2026-08-05T12:00:00Z", platform: "threads" }),
    ],
  );
  assert.equal(repost.plan[0].published_at, "2026-08-04T12:00:00Z");
  assert.deepEqual(repost.reposts[0].days, ["2026-08-04", "2026-08-05"]);
  assert.equal(isZernioTracked(asset("a", { meta: '{"zernio":{"outcome":"published"}}' })), true);
  assert.equal(isZernioTracked(asset("a", { meta: "{bad" })), false);
});

test("library linker dry-run reads the database but writes nothing; live writes are guarded and tenant-scoped", async () => {
  const batches: InStatement[][] = [];
  let reads = 0;
  const db = {
    async execute(statement: InStatement) {
      reads += 1;
      if (statement.sql.includes("FROM marketing_asset")) return { rows: [asset("a")], rowsAffected: 0 };
      return { rows: [post("p")], rowsAffected: 0 };
    },
    async batch(statements: InStatement[]) {
      batches.push(statements);
      return statements.map(() => ({ rows: [], rowsAffected: 1 }));
    },
  } as unknown as Pick<Client, "execute" | "batch">;
  const dry = await runLibraryPostLinker({ db, dryRun: true });
  assert.equal(dry.linkable_assets, 1);
  assert.equal(reads, 2, "dry-run must inspect current rows to produce a truthful plan");
  assert.equal(batches.length, 0);
  const live = await runLibraryPostLinker({ db, dryRun: false });
  assert.equal(live.executed, true);
  assert.equal(live.written_posts, 1);
  assert.equal(batches.length, 2, "post links are guarded before asset metadata is changed");
  assert.match(batches[0][0].sql, /asset_id IS NULL OR asset_id = \?/);
  assert.ok(batches.flat().every((statement) => /tenant_id = \?/.test(statement.sql)));
  assert.ok(batches.flat().every((statement) => statement.args?.includes(OASIS_OPERATOR_TENANT_ID)));
});

async function linkerDb(): Promise<Client> {
  const db = createClient({ url: "file::memory:" });
  await db.batch([
    `CREATE TABLE marketing_asset (
       id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, hook TEXT,
       published_at TEXT, platforms TEXT, status TEXT, brand_slug TEXT, meta TEXT)`,
    `CREATE TABLE post_analytics (
       id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, platform TEXT NOT NULL,
       platform_post_id TEXT NOT NULL, content_excerpt TEXT, published_at TEXT, asset_id TEXT)`,
    {
      sql: `INSERT INTO marketing_asset
              (id, tenant_id, title, hook, published_at, platforms, status, brand_slug, meta)
            VALUES ('a', ?, 'An Asset', ?, NULL, NULL, 'in_review', 'oasis-ai', '{}')`,
      args: [OASIS_OPERATOR_TENANT_ID, HOOK],
    },
    {
      sql: `INSERT INTO post_analytics
              (id, tenant_id, platform, platform_post_id, content_excerpt, published_at, asset_id)
            VALUES ('p', ?, 'instagram', 'pp-p', ?, '2026-08-14T14:36:21Z', NULL)`,
      args: [OASIS_OPERATOR_TENANT_ID, HOOK],
    },
  ], "write");
  return db;
}

test("library linker reports a concurrent conflicting link and never overwrites it", async () => {
  const client = await linkerDb();
  let raced = false;
  const db = {
    execute: client.execute.bind(client),
    async batch(statements: InStatement[]) {
      if (!raced && statements[0]?.sql.includes("UPDATE post_analytics")) {
        raced = true;
        await client.execute({
          sql: "UPDATE post_analytics SET asset_id = 'other-asset' WHERE id = 'p'",
          args: [],
        });
      }
      return client.batch(statements, "write");
    },
  } as unknown as Pick<Client, "execute" | "batch">;
  const result = await runLibraryPostLinker({ db, dryRun: false });
  assert.equal(result.executed, false);
  assert.equal(result.written_posts, 0);
  assert.deepEqual(result.conflicts, [{
    post_id: "p",
    planned_asset_id: "a",
    existing_asset_id: "other-asset",
    reason: "concurrent_change",
  }]);
  const linked = (await client.execute("SELECT asset_id FROM post_analytics WHERE id = 'p'")).rows[0];
  const library = (await client.execute("SELECT published_at FROM marketing_asset WHERE id = 'a'")).rows[0];
  assert.equal(linked.asset_id, "other-asset");
  assert.equal(library.published_at, null, "a losing race must not mark the planned asset published");
  client.close();
});

test("library linker accepts a concurrent same-asset replay as idempotent success", async () => {
  const client = await linkerDb();
  let raced = false;
  const db = {
    execute: client.execute.bind(client),
    async batch(statements: InStatement[]) {
      if (!raced && statements[0]?.sql.includes("UPDATE post_analytics")) {
        raced = true;
        await client.execute("UPDATE post_analytics SET asset_id = 'a' WHERE id = 'p'");
      }
      return client.batch(statements, "write");
    },
  } as unknown as Pick<Client, "execute" | "batch">;
  const result = await runLibraryPostLinker({ db, dryRun: false });
  assert.equal(result.executed, true);
  assert.equal(result.written_posts, 1);
  assert.deepEqual(result.conflicts, []);
  assert.equal((await client.execute("SELECT asset_id FROM post_analytics WHERE id = 'p'")).rows[0].asset_id, "a");
  client.close();
});

test("library linker preserves Zernio metadata that becomes authoritative mid-run", async () => {
  const client = await linkerDb();
  const trackerMeta = '{"zernio":{"outcome":"published"}}';
  const trackerPublishedAt = "2026-08-14T14:35:00Z";
  const trackerPlatforms = JSON.stringify(["instagram", "linkedin"]);
  let raced = false;
  const db = {
    execute: client.execute.bind(client),
    async batch(statements: InStatement[]) {
      if (!raced && statements[0]?.sql.includes("UPDATE marketing_asset")) {
        raced = true;
        await client.execute({
          sql: `UPDATE marketing_asset
                SET meta = ?, published_at = ?, platforms = ?
                WHERE tenant_id = ? AND id = 'a'`,
          args: [trackerMeta, trackerPublishedAt, trackerPlatforms, OASIS_OPERATOR_TENANT_ID],
        });
      }
      return client.batch(statements, "write");
    },
  } as unknown as Pick<Client, "execute" | "batch">;

  const result = await runLibraryPostLinker({ db, dryRun: false });
  assert.equal(result.executed, true);
  assert.equal(result.plan[0].zernio_tracked, true);
  assert.deepEqual(result.conflicts, []);
  const current = (await client.execute(
    "SELECT meta, published_at, platforms FROM marketing_asset WHERE id = 'a'",
  )).rows[0];
  assert.equal(current.meta, trackerMeta);
  assert.equal(current.published_at, trackerPublishedAt);
  assert.equal(current.platforms, trackerPlatforms);
  client.close();
});

function analyticsResponse(posts: unknown[], pagination: Record<string, unknown> = { pages: 1, total: posts.length }): Response {
  return Response.json({ posts, pagination, overview: { publishedPosts: posts.length, totalPosts: posts.length } });
}

test("Zernio analytics follows every advertised page and refuses a short read", async () => {
  const paths: string[] = [];
  const complete = await fetchAllZernioAnalytics("late-test", async (input) => {
    paths.push(String(input));
    return paths.length === 1
      ? analyticsResponse([{ _id: "one" }], { pages: 2, total: 2 })
      : analyticsResponse([{ _id: "two" }]);
  });
  assert.equal(complete.posts?.length, 2);
  assert.match(paths[1], /page=2/);
  await assert.rejects(
    () => fetchAllZernioAnalytics("late-test", async () => analyticsResponse([], { pages: 1, total: 2 })),
    /zernio_incomplete/,
  );
  let duplicateCalls = 0;
  await assert.rejects(
    () => fetchAllZernioAnalytics("late-test", async () => {
      duplicateCalls += 1;
      return duplicateCalls === 1
        ? analyticsResponse([{ _id: "post-A" }], { pages: 2, total: 2 })
        : analyticsResponse([{ _id: "post-A" }]);
    }),
    /zernio_post_duplicate:2:post-A/,
  );
  assert.equal(duplicateCalls, 2);
});

test("analytics access loss fails before any database write", async () => {
  const client = await analyticsDb();
  let writes = 0;
  const db = {
    execute: client.execute.bind(client),
    async batch(statements: InStatement[]) {
      writes += statements.length;
      return client.batch(statements, "write");
    },
  } as unknown as Pick<Client, "execute" | "batch">;
  await assert.rejects(
    () => runPostAnalyticsSync({
      db,
      dryRun: false,
      env: { LATE_API_KEY: "late-test" },
      fetchImpl: async () => Response.json({
        hasAnalyticsAccess: false,
        posts: [],
        pagination: { pages: 1, total: 0 },
      }),
      now: () => NOW,
    }),
    /zernio_analytics_access_denied/,
  );
  assert.equal(writes, 0);
  assert.equal(Number((await client.execute(
    "SELECT views FROM post_analytics WHERE id = 'row-1'",
  )).rows[0].views), 99);
  client.close();
});

test("analytics transform is one row per platform and skips rows with no stable platform id", () => {
  const transformed = rowsFromZernio(
    {
      posts: [{
        _id: "z-1",
        content: "caption",
        publishedAt: "2026-10-15T13:00:00Z",
        platforms: [
          { platform: "instagram", platformPostId: "ig-1", analytics: { views: 10, likes: 2 } },
          { platform: "threads" },
        ],
      }],
    },
    new Map([["z-1", "asset-1"]]),
    () => NOW,
  );
  assert.equal(transformed.rows.length, 1);
  assert.equal(transformed.skipped_no_platform_id, 1);
  assert.equal(transformed.rows[0].asset_id, "asset-1");
  assert.equal(transformed.rows[0].views, 10);
  assert.equal(transformed.rows[0].measured_at, NOW.toISOString());
});

async function analyticsDb(): Promise<Client> {
  const db = createClient({ url: "file::memory:" });
  await db.batch([
    `CREATE TABLE marketing_asset (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, external_id TEXT)`,
    `CREATE TABLE post_analytics (
       id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
       zernio_post_id TEXT NOT NULL, platform_post_id TEXT NOT NULL, platform TEXT NOT NULL,
       account_username TEXT, asset_id TEXT, impressions INTEGER NOT NULL DEFAULT 0,
       views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0,
       shares INTEGER NOT NULL DEFAULT 0, saves INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
       follows INTEGER NOT NULL DEFAULT 0, engagement_rate REAL NOT NULL DEFAULT 0, avg_watch_s REAL,
       duration_s REAL, content_excerpt TEXT, published_at TEXT, last_synced_at TEXT NOT NULL,
       measured_at TEXT, UNIQUE(tenant_id, platform_post_id))`,
    {
      sql: `INSERT INTO post_analytics
              (id, tenant_id, zernio_post_id, platform_post_id, platform, asset_id, views,
               content_excerpt, last_synced_at, measured_at)
            VALUES ('row-1', ?, 'z-old', 'ig-1', 'instagram', 'caption-linked-asset', 99,
                    'old', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      args: [OASIS_OPERATOR_TENANT_ID],
    },
  ], "write");
  return db;
}

test("analytics dry-run writes nothing and a thin poll preserves prior metrics and caption link", async () => {
  const db = await analyticsDb();
  const thinPost = {
    _id: "z-new",
    content: "updated caption",
    publishedAt: "2026-10-29T12:00:00Z",
    platforms: [{ platform: "instagram", platformPostId: "ig-1" }],
  };
  const fetchImpl = async () => analyticsResponse([thinPost]);
  const dry = await runPostAnalyticsSync({
    db,
    dryRun: true,
    env: { LATE_API_KEY: "late-test" },
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(dry.wrote, 0);
  assert.equal(dry.dry_run_scope, "database_and_provider_read_only");
  let row = (await db.execute("SELECT views, asset_id, content_excerpt FROM post_analytics WHERE id = 'row-1'")).rows[0];
  assert.equal(row.content_excerpt, "old");
  const live = await runPostAnalyticsSync({
    db,
    dryRun: false,
    env: { LATE_API_KEY: "late-test" },
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(live.wrote, 1);
  assert.equal(live.dry_run_scope, "live");
  assert.equal(live.kept_existing_metrics, 1);
  row = (await db.execute("SELECT views, asset_id, content_excerpt, measured_at FROM post_analytics WHERE id = 'row-1'")).rows[0];
  assert.equal(Number(row.views), 99);
  assert.equal(row.asset_id, "caption-linked-asset");
  assert.equal(row.content_excerpt, "updated caption");
  assert.equal(row.measured_at, "2026-10-01T00:00:00Z");
  db.close();
});

test("analytics refuses a platform-id collision before any write", async () => {
  const db = await analyticsDb();
  const result = runPostAnalyticsSync({
    db,
    dryRun: false,
    env: { LATE_API_KEY: "late-test" },
    fetchImpl: async () => analyticsResponse([{
      _id: "z-new",
      platforms: [{ platform: "threads", platformPostId: "ig-1", analytics: { views: 1 } }],
    }]),
    now: () => NOW,
  });
  await assert.rejects(result, /post_analytics_platform_collision/);
  const row = (await db.execute("SELECT platform, views FROM post_analytics WHERE id = 'row-1'")).rows[0];
  assert.equal(row.platform, "instagram");
  assert.equal(Number(row.views), 99);
  db.close();
});
