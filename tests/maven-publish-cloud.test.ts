/** Turso/gateway/Queue-edge proof. Local libSQL only; no production or network calls. */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { OASIS_TENANT_ID } from "../lib/marketing/maven-publish-contract";
import { CloudLatePublisher, TursoMavenPublishGateway, TursoMavenPublishStore } from "../lib/marketing/maven-publish-cloud";
import { consumeMavenPublishJobs } from "../lib/marketing/maven-publish-queue-consumer";
import {
  MAVEN_JOB_SIGNATURE_HEADER,
  MAVEN_JOB_TIMESTAMP_HEADER,
  verifyMavenPublishJob,
} from "../lib/marketing/maven-publish-job-signature";
import { routeQueueBatch } from "../lib/worker/queue-router";

async function run(): Promise<void> {
  const db = createClient({ url: ":memory:" });
  await db.executeMultiple(`
    CREATE TABLE marketing_publish_intent (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL,
      platforms TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', result TEXT NOT NULL DEFAULT '{}',
      attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT, error TEXT
    );
    CREATE TABLE marketing_asset (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT, hook TEXT, body TEXT,
      cta TEXT, landing_url TEXT, campaign TEXT, asset_type TEXT, media_urls TEXT,
      status TEXT, external_id TEXT, platforms TEXT, published_at TEXT, updated_at TEXT
    );
    CREATE TABLE marketing_asset_media (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, kind TEXT NOT NULL,
      storage_bucket TEXT, storage_path TEXT, mime TEXT, bytes INTEGER, created_at TEXT
    );
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, type TEXT, channel TEXT, direction TEXT,
      subject TEXT, content TEXT, agent_source TEXT, metadata TEXT, created_at TEXT
    );
    CREATE TABLE post_analytics (
      id TEXT PRIMARY KEY, tenant_id TEXT, asset_id TEXT, measured_at TEXT
    );
  `);
  const intentId = "10000000-0000-4000-8000-000000000001";
  const assetId = "20000000-0000-4000-8000-000000000001";
  await db.batch([
    {
      sql: `INSERT INTO marketing_publish_intent
              (id, tenant_id, asset_id, platforms, state, result, attempts, created_at)
            VALUES (?, ?, ?, ?, 'queued', '{}', 0, ?)`,
      args: [intentId, OASIS_TENANT_ID, assetId, JSON.stringify(["instagram"]), "2026-10-30T01:00:00.000Z"],
    },
    {
      sql: `INSERT INTO marketing_asset
              (id, tenant_id, title, asset_type, media_urls, status, platforms, updated_at)
            VALUES (?, ?, 'Cloud post', 'video', '[]', 'approved', '[]', ?)`,
      args: [assetId, OASIS_TENANT_ID, "2026-10-30T01:00:00.000Z"],
    },
    {
      sql: `INSERT INTO marketing_asset_media
              (id, tenant_id, asset_id, kind, storage_bucket, storage_path, mime, bytes, created_at)
            VALUES ('m1', ?, ?, 'video', 'marketing-media', 'oasis/clip.mp4', 'video/mp4', 123, ?)`,
      args: [OASIS_TENANT_ID, assetId, "2026-10-30T01:00:00.000Z"],
    },
  ], "write");

  const store = new TursoMavenPublishStore(db);
  assert.deepEqual((await store.listQueued(OASIS_TENANT_ID, 10)).map((row) => row.id), [intentId]);
  const [a, b] = await Promise.all([
    store.claim(OASIS_TENANT_ID, intentId, "claim-a", "2026-10-30T02:00:00.000Z"),
    store.claim(OASIS_TENANT_ID, intentId, "claim-b", "2026-10-30T02:00:00.000Z"),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1, "Turso CAS gives one overlapping consumer the claim");
  const token = a ? "claim-a" : "claim-b";
  assert.equal(await store.markDispatch(OASIS_TENANT_ID, intentId, "wrong", "2026-10-30T02:01:00.000Z", ["instagram"]), false);
  assert.equal(await store.markDispatch(OASIS_TENANT_ID, intentId, token, "2026-10-30T02:01:00.000Z", ["instagram"]), true);
  assert.equal(await store.finish(
    OASIS_TENANT_ID,
    intentId,
    token,
    "done",
    { instagram: { ok: true, post_id: "post-1" } },
    null,
    "2026-10-30T02:02:00.000Z",
  ), true);
  assert.equal(await store.markAssetPublished(
    OASIS_TENANT_ID,
    assetId,
    "post-1",
    ["instagram"],
    "2026-10-30T02:02:00.000Z",
  ), true);
  assert.equal(await store.markAssetPublished(
    OASIS_TENANT_ID,
    assetId,
    "post-old",
    ["linkedin"],
    "2026-10-30T02:03:00.000Z",
  ), false, "a different provider post cannot take ownership of an already-stamped asset");
  const owned = (await db.execute({
    sql: "SELECT external_id, platforms FROM marketing_asset WHERE tenant_id = ? AND id = ?",
    args: [OASIS_TENANT_ID, assetId],
  })).rows[0];
  assert.equal(owned.external_id, "post-1");
  assert.deepEqual(JSON.parse(String(owned.platforms)), ["instagram"]);
  const candidates = await store.listReconcileCandidates(
    OASIS_TENANT_ID,
    "2026-10-30T00:00:00.000Z",
    "2026-10-30T03:00:00.000Z",
  );
  assert.equal(candidates.length, 1);
  assert.equal(await store.saveReconciliation({
    intent: candidates[0],
    result: { instagram: { ok: true, post_id: "post-1", status: "published", published_at: "2026-10-30T02:03:00.000Z" } },
    state: "done",
    error: null,
    livePlatforms: ["instagram"],
    pending: false,
    expired: false,
    firstPublishedAt: "2026-10-30T02:03:00.000Z",
    at: "2026-10-30T02:30:00.000Z",
  }), "updated");
  assert.deepEqual(
    JSON.parse(String((await db.execute({ sql: "SELECT platforms FROM marketing_asset WHERE id = ?", args: [assetId] })).rows[0].platforms)),
    ["instagram"],
  );

  await db.batch([
    {
      sql: `INSERT INTO marketing_publish_intent
              (id, tenant_id, asset_id, platforms, state, result, attempts, created_at, started_at)
            VALUES ('stale-before', ?, ?, '["instagram"]', 'running', ?, 1, ?, ?)`,
      args: [OASIS_TENANT_ID, assetId, JSON.stringify({ _queue_claim_token: "old-a" }), "2026-10-29T20:00:00.000Z", "2026-10-29T20:01:00.000Z"],
    },
    {
      sql: `INSERT INTO marketing_publish_intent
              (id, tenant_id, asset_id, platforms, state, result, attempts, created_at, started_at)
            VALUES ('stale-after', ?, ?, '["instagram"]', 'running', ?, 1, ?, ?)`,
      args: [OASIS_TENANT_ID, assetId, JSON.stringify({ _queue_claim_token: "old-b", _dispatch_started_at: "2026-10-29T20:02:00.000Z" }), "2026-10-29T20:00:00.000Z", "2026-10-29T20:01:00.000Z"],
    },
  ], "write");
  assert.deepEqual(
    await store.reapStale(OASIS_TENANT_ID, "2026-10-30T02:10:00.000Z", "2026-10-30T02:30:00.000Z"),
    { requeued: 1, failed: 1 },
  );
  const stale = await db.execute("SELECT id, state, result FROM marketing_publish_intent WHERE id LIKE 'stale-%' ORDER BY id");
  assert.equal(String(stale.rows.find((row) => row.id === "stale-before")?.state), "queued");
  const after = stale.rows.find((row) => row.id === "stale-after");
  assert.equal(String(after?.state), "failed");
  assert.equal(JSON.parse(String(after?.result))._delivery_unknown, true, "post-dispatch crashes are terminal, never replayed");

  const gateway = new TursoMavenPublishGateway(db);
  const at = "2026-10-30T02:30:00.000Z";
  const reserve = (n: number) => gateway.reserve({
    idempotencyKey: `intent:group:${n}`,
    intentId,
    assetId,
    platforms: ["instagram"],
    at,
  });
  const first = await reserve(0);
  assert.equal(first.ok, true);
  const duplicate = await reserve(0);
  assert.deepEqual(duplicate, first, "a retry reuses the deterministic gateway reservation");
  for (let i = 1; i < 10; i += 1) assert.equal((await reserve(i)).ok, true);
  const capped = await reserve(10);
  assert.equal(capped.ok, false);
  if (!capped.ok) assert.match(capped.reason, /hourly cap hit: 10\/10/);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM lead_interactions")).rows[0].n), 10);
  assert.ok((await db.execute("SELECT DISTINCT tenant_id FROM lead_interactions")).rows.every((row) => row.tenant_id === OASIS_TENANT_ID));
  if (first.ok) {
    await gateway.finalize(first.reservationId, "sent");
    assert.equal(String((await db.execute({ sql: "SELECT type FROM lead_interactions WHERE id = ?", args: [first.reservationId] })).rows[0].type), "social_sent");
    const afterSent = await reserve(0);
    assert.deepEqual(afterSent, { ok: false, reason: "idempotency key was already sent" });
  }

  const priorFetch = globalThis.fetch;
  const r2Names = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
  const priorR2 = Object.fromEntries(r2Names.map((name) => [name, process.env[name]]));
  let createIdempotencyKey: string | null = null;
  try {
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-access";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret";
    process.env.R2_BUCKET = "test-bucket";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(".r2.cloudflarestorage.com/")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-length": "3", "content-type": "video/mp4" },
        });
      }
      if (url === "https://zernio.com/api/v1/media/presign") {
        return Response.json({ uploadUrl: "https://upload.test/media", publicUrl: "https://cdn.test/media.mp4" });
      }
      if (url === "https://upload.test/media") {
        assert.equal(init?.method, "PUT");
        return new Response(null, { status: 200 });
      }
      if (url === "https://zernio.com/api/v1/posts") {
        createIdempotencyKey = new Headers(init?.headers).get("idempotency-key");
        return Response.json({ _id: "late-post-1" }, { status: 201 });
      }
      throw new Error(`unexpected fetch in CloudLatePublisher test: ${url}`);
    };
    const publisher = new CloudLatePublisher("late-test-key");
    const publishResult = await publisher.publish({
      intent: {
        id: intentId,
        tenant_id: OASIS_TENANT_ID,
        asset_id: assetId,
        platforms: ["instagram"],
        state: "running",
        result: {},
        attempts: 1,
        created_at: at,
        started_at: at,
        finished_at: null,
        error: null,
      },
      asset: {
        id: assetId,
        tenant_id: OASIS_TENANT_ID,
        title: "Cloud post",
        hook: "Cloud post hook",
        body: "Cloud post body",
        cta: null,
        landing_url: null,
        campaign: null,
        asset_type: "video",
        media_urls: [],
      },
      media: [{
        tenant_id: OASIS_TENANT_ID,
        asset_id: assetId,
        kind: "video",
        storage_bucket: "marketing-media",
        storage_path: "oasis/clip.mp4",
        mime: "video/mp4",
        bytes: 3,
        mediaKind: "video",
      }],
      group: {
        id: "short",
        professional: false,
        platforms: ["instagram"],
        caption: "Cloud post hook",
        title: "Cloud post",
        idempotencyKey: "maven-publish:intent-1:short",
      },
    });
    assert.deepEqual(publishResult, { ok: true, postId: "late-post-1" });
    assert.equal(createIdempotencyKey, "maven-publish:intent-1:short", "the provider receives the durable idempotency key");
  } finally {
    globalThis.fetch = priorFetch;
    for (const name of r2Names) {
      const prior = priorR2[name];
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }

  const secret = "test-only-maven-queue-secret";
  const messages = [{
    body: { version: 1, tenantId: OASIS_TENANT_ID, intentId, enqueuedAt: at },
    acked: 0,
    retried: 0,
    ack() { this.acked += 1; },
    retry() { this.retried += 1; },
  }];
  const consumed = await consumeMavenPublishJobs(
    { queue: "oasis-maven-publish-jobs", messages },
    { OASIS_MAVEN_PUBLISH_JOB_SIGNING_SECRET: secret },
    async (request) => {
      const body = await request.text();
      assert.equal(await verifyMavenPublishJob({
        secret,
        timestamp: request.headers.get(MAVEN_JOB_TIMESTAMP_HEADER),
        signature: request.headers.get(MAVEN_JOB_SIGNATURE_HEADER),
        body,
        nowMs: Date.parse(at),
      }), true);
      return new Response("ok", { status: 200 });
    },
    () => Date.parse(at),
  );
  assert.deepEqual(consumed, { acked: 1, retried: 0 });
  assert.equal(messages[0].acked, 1);

  let mavenRouted = 0;
  let slackRouted = 0;
  await routeQueueBatch(
    { queue: "oasis-maven-publish-jobs", messages: [] },
    {},
    async () => new Response("unused"),
    {
      maven: async () => { mavenRouted += 1; return { acked: 0, retried: 0 }; },
      slack: async () => { slackRouted += 1; return { acked: 0, retried: 0 }; },
    },
  );
  assert.deepEqual({ mavenRouted, slackRouted }, { mavenRouted: 1, slackRouted: 0 });
  let unknownRetries = 0;
  await routeQueueBatch(
    { queue: "surprise-queue", messages: [{ body: {}, ack() {}, retry() { unknownRetries += 1; } }] },
    {},
    async () => new Response("unused"),
    {
      maven: async () => { mavenRouted += 1; return { acked: 0, retried: 0 }; },
      slack: async () => { slackRouted += 1; return { acked: 0, retried: 0 }; },
    },
  );
  assert.equal(unknownRetries, 1, "an unknown queue retries instead of crossing into Maven or Slack");

  console.log("maven-publish-cloud: CAS, cap, tenant lane, idempotency, and signed Queue assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
