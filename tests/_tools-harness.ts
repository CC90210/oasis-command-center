/**
 * Shared harness for tests/tools-*.test.ts: the Toolkit against a throwaway
 * local libSQL file.
 *
 * Built on tests/_delivery-harness.ts (the env, the next/headers stand-in, a
 * signed session, real user_profiles: CC and Adon in OASIS, a sales rep, and
 * client owners), plus:
 *   - the REAL migration under test, bravo__206_tool_jobs.sql, whole
 *     (executeMultiple: its triggers carry their own ";");
 *   - the REAL AI usage ledger, bravo__192, so a model call's row is checked;
 *   - the Library and training tables a tool writes, in their live shapes
 *     (read from sqlite_master on 2026-10-09: the CHECKs, the generated track,
 *     the unique (tenant_id, source) index, the media path index, the corpus
 *     in-flight index).
 *
 * The runner's requests are signed HERE with node:crypto, the way the runner
 * signs them (HMAC-SHA256 over "<ts>." + raw body, the trimmed secret as text):
 * nothing from the code under test signs, so a broken verifier cannot agree
 * with itself. Storage is a fake that records every call; nothing reaches R2,
 * a model or the network.
 *
 * IMPORT THIS FIRST (it imports the delivery harness, which sets the env).
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { CLIENT_A, OASIS, setupDatabase } from "./_delivery-harness";
import type { ToolStorage } from "../lib/tools/runner-handlers";

export * from "./_delivery-harness";

// Never let a test reach a real secret, bucket or model, whatever the shell holds.
for (const k of ["TOOLS_RUNNER_SECRET_BEA", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "OPERATOR_EMAIL_FALLBACK_ENABLED"]) {
  delete process.env[k];
}
// Two founders workspaces, so isolation between two allowed workspaces is tested,
// not only the gate.
process.env.FOUNDERS_TENANT_IDS = `${OASIS},${CLIENT_A}`;

export const WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d";
export const SECRET = "tools-runner-test-secret-0123456789abcdef";
export const ENV = { TOOLS_RUNNER_SECRET_BEA: `  ${SECRET}\n` };

const ROOT = join(__dirname, "..");
export const TOOLS_MIGRATION_PATH = join(ROOT, "database", "turso", "bravo__206_tool_jobs.sql");
const AI_USAGE_MIGRATION = join(ROOT, "database", "turso", "bravo__192_ai_usage.sql");

const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const UUID_SQL =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random())%4+1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))";

/** The live shapes of the three tables a tool writes into (not owned by this migration). */
const LIBRARY_TABLES = `
  CREATE TABLE marketing_asset (
    id TEXT NOT NULL DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL, title TEXT NOT NULL, channel TEXT NOT NULL,
    track TEXT GENERATED ALWAYS AS (CASE channel WHEN 'organic-instagram' THEN 'organic' WHEN 'organic-facebook' THEN 'organic'
      WHEN 'organic-tiktok' THEN 'organic' WHEN 'organic-youtube' THEN 'organic' WHEN 'paid-meta' THEN 'paid'
      WHEN 'paid-google' THEN 'paid' WHEN 'seo-article' THEN 'seo' WHEN 'seo-landing' THEN 'seo' WHEN 'email' THEN 'email'
      ELSE NULL END) STORED,
    format TEXT NOT NULL, aspect TEXT, status TEXT NOT NULL DEFAULT 'draft', hook TEXT, body TEXT, cta TEXT, landing_url TEXT,
    campaign TEXT, duration_s TEXT, author_agent TEXT NOT NULL DEFAULT 'human', source TEXT, scheduled_for TEXT,
    published_at TEXT, external_id TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW_SQL}, updated_at TEXT NOT NULL DEFAULT ${NOW_SQL},
    meta TEXT NOT NULL DEFAULT '{}', brand_slug TEXT NOT NULL DEFAULT 'oasis-ai', brand_name TEXT NOT NULL DEFAULT 'OASIS AI',
    platforms TEXT NOT NULL DEFAULT '[]', asset_type TEXT NOT NULL DEFAULT 'single_image', media_urls TEXT NOT NULL DEFAULT '[]',
    slide_count INTEGER NOT NULL DEFAULT 1, author_email TEXT NOT NULL DEFAULT 'conaugh@oasisai.work',
    PRIMARY KEY (id),
    CONSTRAINT marketing_asset_channel_check CHECK ((channel IN ('organic-instagram', 'organic-facebook', 'organic-tiktok',
      'organic-youtube', 'paid-meta', 'paid-google', 'seo-article', 'seo-landing', 'email'))),
    CONSTRAINT marketing_asset_format_check CHECK ((format IN ('video', 'image', 'carousel', 'html', 'article', 'copy', 'audio'))),
    CONSTRAINT marketing_asset_status_check CHECK ((status IN ('draft', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'archived'))),
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE);
  CREATE UNIQUE INDEX marketing_asset_tenant_id_key ON marketing_asset (tenant_id, id);
  CREATE UNIQUE INDEX marketing_asset_tenant_source_unique_idx ON marketing_asset (tenant_id, source) WHERE (source IS NOT NULL);
  CREATE TABLE marketing_asset_media (
    id TEXT NOT NULL DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, kind TEXT NOT NULL,
    storage_bucket TEXT NOT NULL DEFAULT 'marketing-media', storage_path TEXT NOT NULL, mime TEXT, bytes INTEGER,
    width INTEGER, height INTEGER, label TEXT, created_at TEXT NOT NULL DEFAULT ${NOW_SQL},
    PRIMARY KEY (id),
    FOREIGN KEY (tenant_id, asset_id) REFERENCES marketing_asset (tenant_id, id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE);
  CREATE UNIQUE INDEX marketing_asset_media_tenant_id_storage_bucket_storage_path_key
    ON marketing_asset_media (tenant_id, storage_bucket, storage_path);
  CREATE TABLE marketing_corpus (
    id TEXT NOT NULL DEFAULT ${UUID_SQL}, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'exemplar',
    title TEXT, source_url TEXT, storage_bucket TEXT, storage_path TEXT, asset_id TEXT, transcript TEXT,
    extraction TEXT NOT NULL DEFAULT '{}', search_text TEXT, state TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, contributed_by TEXT NOT NULL DEFAULT 'adon',
    created_at TEXT NOT NULL DEFAULT ${NOW_SQL}, updated_at TEXT NOT NULL DEFAULT ${NOW_SQL}, indexed_at TEXT,
    PRIMARY KEY (id),
    FOREIGN KEY (tenant_id, asset_id) REFERENCES marketing_asset (tenant_id, id) ON DELETE SET NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE);
  CREATE UNIQUE INDEX marketing_corpus_one_in_flight_url_idx ON marketing_corpus (tenant_id, source_url)
    WHERE ((source_url IS NOT NULL) AND (state IN ('queued', 'extracting')));
`;

/** The delivery harness's database, plus the Library, the training corpus, the AI ledger and (unless told not to) bravo__206. */
export async function setupToolsDatabase(): Promise<Client> {
  const db = await setupDatabase();
  await db.execute({ sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-webdev', 'OASIS Web Dev')", args: [WEBDEV] });
  await db.executeMultiple(LIBRARY_TABLES);
  await db.executeMultiple(readFileSync(AI_USAGE_MIGRATION, "utf8"));
  await db.executeMultiple(readFileSync(TOOLS_MIGRATION_PATH, "utf8"));
  return db;
}

/** A second, empty database: the Toolkit's tables are not installed in it. */
export function emptyDatabase(): Client {
  return createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "tools-empty-")), "empty.db")}` });
}

/** The runner's signature: lowercase hex HMAC-SHA256 over "<ts>." + raw body, the trimmed secret as text. */
export function sign(secret: string, ts: number, raw: string): string {
  return createHmac("sha256", secret.trim()).update(`${ts}.${raw}`, "utf8").digest("hex");
}

export type SignOptions = { ts?: number; secret?: string; signature?: string; producer?: string | null; raw?: string };

/** A signed POST to one runner route, exactly as the runner builds it (compact ASCII JSON). */
export function signedRequest(route: string, body: unknown, now: Date, o: SignOptions = {}): Request {
  const raw = o.raw ?? JSON.stringify(body);
  const ts = o.ts ?? Math.floor(now.getTime() / 1000);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "bravo-tools-runner/1.0",
    "x-tools-timestamp": String(ts),
    "x-tools-signature": o.signature ?? sign(o.secret ?? SECRET, ts, raw),
    ...(o.producer === null ? {} : { "x-tools-producer": o.producer ?? "bea" }),
  };
  return new Request(`https://oasisai.work/api/internal/tools/${route}`, { method: "POST", headers, body: raw });
}

/** Read a JSON answer, holding every answer to the contract: 2xx = {ok:true}, else {ok:false, error:<code>}. */
export async function answerOf(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (res.status >= 200 && res.status < 300) {
    if (!body || typeof body !== "object" || (body as { ok?: unknown }).ok !== true) {
      throw new Error(`a ${res.status} answer must be a JSON object with ok: true, got ${text.slice(0, 200)}`);
    }
  } else if (!body || typeof body !== "object" || (body as { ok?: unknown }).ok !== false || !/^[a-z0-9_.:-]{1,64}$/.test(String((body as { error?: unknown }).error))) {
    throw new Error(`a ${res.status} refusal must be {"ok": false, "error": "<short code>"}, got ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

export async function scalar(db: Client, sql: string, args: Array<string | number | null> = []): Promise<unknown> {
  const rs = await db.execute({ sql, args });
  const row = rs.rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

/** An object store that keeps objects in memory and records every call. */
export function fakeStorage(opts: { headThrows?: boolean; removeThrows?: boolean } = {}) {
  const objects = new Map<string, { size: number; etag: string | null }>();
  const removed: string[] = [];
  const signed: string[] = [];
  const storage: ToolStorage = {
    async createSignedUploadUrl(path) {
      signed.push(path);
      return { signedUrl: `https://acct.r2.example/bucket/marketing-media/${path}?X-Amz-Signature=fake` };
    },
    async info(path) {
      if (opts.headThrows) throw new Error("storage unreachable");
      return objects.get(path) ?? null;
    },
    async remove(path) {
      removed.push(path);
      objects.delete(path);
      if (opts.removeThrows) throw new Error("delete refused");
    },
  };
  /** What a runner's PUT leaves behind: R2 answers HEAD with the size and the MD5 as a quoted ETag. */
  const put = (path: string, size: number, md5: string) => objects.set(path, { size, etag: `"${md5}"` });
  return { storage, objects, removed, signed, put };
}

/** A runner that serves `tools`, seen at `at`, for every OASIS workspace. */
export async function seedRunner(db: Client, at: Date, tools: string[] = ["video_download"], runnerKey = "bea:ccpc"): Promise<void> {
  for (const tenant of [OASIS, WEBDEV]) {
    await db.execute({
      sql: `INSERT INTO tool_runners (tenant_id, runner_key, label, tools_json, version, last_seen_at)
            VALUES (?, ?, 'CC''s PC', ?, '1.0.0', ?)
            ON CONFLICT (tenant_id, runner_key) DO UPDATE SET tools_json = excluded.tools_json, last_seen_at = excluded.last_seen_at`,
      args: [tenant, runnerKey, JSON.stringify(tools), at.toISOString()],
    });
  }
}

let jobSeq = 0;
/** A queued video_download job, as POST /api/tools/run writes one. */
export async function queueDownload(
  db: Client,
  tenantId: string,
  at: Date,
  o: { url?: string; toolKey?: string; email?: string } = {},
): Promise<string> {
  jobSeq += 1;
  const id = `0b000000-0000-4000-8000-${String(jobSeq).padStart(12, "0")}`;
  const url = o.url ?? `https://www.instagram.com/reel/ABC${jobSeq}/`;
  await db.execute({
    sql: `INSERT INTO tool_jobs (id, tenant_id, tool_key, runs_on, status, input_json, input_hash, idempotency_key, dedupe_key,
                                 created_by, created_by_email, created_at, updated_at)
          VALUES (?, ?, ?, 'runner', 'queued', ?, ?, ?, ?, 'p-cc', ?, ?, ?)`,
    args: [
      id, tenantId, o.toolKey ?? "video_download", JSON.stringify({ url, platform: "instagram" }), `hash-${jobSeq}`,
      `idem-${jobSeq}`, `video_download:${url}`, o.email ?? "conaugh@oasisai.work", at.toISOString(), at.toISOString(),
    ],
  });
  return id;
}

export const minutes = (n: number) => n * 60_000;
export const later = (from: Date, ms: number) => new Date(from.getTime() + ms);
