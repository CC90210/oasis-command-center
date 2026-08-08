import "server-only";
/**
 * Cloudflare R2 behind the shape of `supabase.storage`.
 *
 * Turso is a database, not an object store, so Supabase Storage is the last
 * runtime dependency standing between this app and cancelling the subscription.
 * There are 23 call sites across 11 files (lead-documents, chat-attachments,
 * esign, tenant logos, forms uploads, marketing media) — far too many to rewrite
 * individually without introducing bugs in each one.
 *
 * So this exposes the same surface the callers already use:
 *
 *     storage.from(bucket).upload(path, body, { contentType, upsert })
 *                         .download(path)
 *                         .createSignedUrl(path, expiresIn)
 *                         .getPublicUrl(path)
 *                         .remove([paths])
 *                         .list(prefix)
 *
 * Same `{ data, error }` returns, same non-throwing behaviour. lib/supabase-server.ts
 * swaps it in behind the existing hybrid proxy — the same way `.from()` and
 * `.rpc()` already route to Turso — so no call site changes.
 *
 * Active only when all four R2_* vars are set; otherwise the real Supabase
 * storage passes through untouched. That fallback is the rollback.
 *
 * Lead documents are merchant bank statements. Reads go through short-lived
 * presigned URLs, never a public bucket.
 *
 * SigV4 is implemented over node:crypto rather than pulling the AWS SDK into a
 * serverless bundle. Verified against AWS's published `get-vanilla` test vector
 * — see breeze-portal/scripts/verify-r2-signing.mjs, which asserts the identical
 * construction.
 */
import { createHash, createHmac } from "node:crypto";

const REGION = "auto";
const SERVICE = "s3";

/**
 * The account id goes by two names across this fleet: this adapter was written
 * against R2_ACCOUNT_ID, while etl_storage_to_r2.py and the Vercel cutover set
 * CLOUDFLARE_ACCOUNT_ID. Reading only one of them made r2Configured() return
 * false with R2 fully provisioned — so `.storage` kept falling through to
 * Supabase and looked healthy right up until the day Supabase went away.
 * Accept either; a silent false here is invisible in exactly the wrong way.
 */
function accountId(): string | undefined {
  return process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
}

/**
 * Buckets that were `public: true` in Supabase.
 *
 * This is a SECURITY BOUNDARY, not a convenience list. The /api/media route
 * signs whatever object key it is handed, so this set is the only thing
 * standing between a request for
 * `/api/media/lead-documents/<tenant>/<lead>/statement.pdf` and a working link
 * to a merchant bank statement. 4,088 of those live in the private bucket.
 *
 * It lives HERE because this file is byte-identical across four repos with a
 * drift check that fails the build (scripts/verify-r2-surface.mjs). A copy of
 * this list in each app's route would drift silently, and the failure mode of
 * drift is "one app starts serving a private bucket" — the copies would not
 * even disagree visibly, they would just diverge.
 *
 * Read from storage.buckets.public on 2026-08-07, not assumed. Anything absent
 * is PRIVATE: deny-by-default, so a bucket added later is refused until someone
 * makes an explicit decision to list it.
 */
export const PUBLIC_BUCKET_PREFIXES: ReadonlySet<string> = new Set([
  "tenant-assets",                  // bravo
  "avatars",                        // nostalgic
  "application-documents",          // propflow
  "application-screening-reports",  // propflow
  "documents",                      // propflow
  "logos",                          // propflow
  "media",                          // propflow
  "properties",                     // propflow
  "property-photos",                // propflow
]);

export function r2Configured(): boolean {
  return Boolean(
    accountId() &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  );
}

function cfg() {
  return {
    account: accountId()!,
    key: process.env.R2_ACCESS_KEY_ID!,
    secret: process.env.R2_SECRET_ACCESS_KEY!,
    bucket: process.env.R2_BUCKET!,
    publicBase: (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  };
}

const sha256Hex = (d: string | Uint8Array) =>
  createHash("sha256").update(d).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data, "utf8").digest();
const signingKey = (secret: string, date: string) =>
  hmac(hmac(hmac(hmac(`AWS4${secret}`, date), REGION), SERVICE), "aws4_request");

function host(): string {
  return `${cfg().account}.r2.cloudflarestorage.com`;
}

/** RFC3986 per segment so "/" separators survive. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) =>
      encodeURIComponent(s).replace(
        /[!'()*]/g,
        (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
      ),
    )
    .join("/");
}

function stamps() {
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: now, date: now.slice(0, 8) };
}

/**
 * Supabase namespaces objects per bucket; this account uses ONE R2 bucket, so
 * the Supabase bucket name becomes the key prefix. That is the same convention
 * etl_storage_to_r2.py uploads with, so a migrated object and a newly-written
 * one land at the same key.
 */
function objectKey(bucket: string, path: string): string {
  return `${bucket}/${path.replace(/^\/+/, "")}`;
}

/**
 * Query-signed URL for one object.
 *
 * PUT is not a variation for completeness: the browser upload paths hand a
 * signed URL straight to the client and never proxy the bytes through the
 * server, so without a signed PUT there is no way to upload at all once
 * `.storage` points at R2.
 */
function presign(
  method: "GET" | "PUT",
  bucket: string,
  path: string,
  expiresInSec: number,
): string {
  const { key, secret, bucket: r2Bucket } = cfg();
  const { amz, date } = stamps();
  const canonicalUri = `/${r2Bucket}/${encodePath(objectKey(bucket, path))}`;
  const q = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${key}/${date}/${REGION}/${SERVICE}/aws4_request`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(expiresInSec),
    "X-Amz-SignedHeaders": "host",
  });
  const canonicalQuery = [...q.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, `host:${host()}\n`, "host", "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256", amz, `${date}/${REGION}/${SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const sig = createHmac("sha256", signingKey(secret, date))
    .update(stringToSign, "utf8").digest("hex");
  return `https://${host()}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${sig}`;
}

function presignGet(bucket: string, path: string, expiresInSec: number): string {
  return presign("GET", bucket, path, expiresInSec);
}

/**
 * How long a direct-upload URL stays valid. Long enough for a prospect on a
 * phone to finish a multi-megabyte bank statement, short enough that a URL
 * leaked from a browser history is not a standing write grant.
 */
const SIGNED_UPLOAD_TTL_SEC = 900;

async function signedFetch(
  method: "PUT" | "GET" | "DELETE" | "HEAD",
  bucket: string,
  path: string,
  body?: Uint8Array,
  contentType?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const { key, secret, bucket: r2Bucket } = cfg();
  const { amz, date } = stamps();
  const canonicalUri = `/${r2Bucket}/${encodePath(objectKey(bucket, path))}`;
  const payloadHash = body ? sha256Hex(body) : sha256Hex("");

  const headers: Record<string, string> = {
    host: host(),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
    ...extraHeaders,
  };
  if (contentType) headers["content-type"] = contentType;

  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders =
    Object.keys(headers).sort().map((h) => `${h}:${headers[h]}`).join("\n") + "\n";
  const canonicalRequest = [
    method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256", amz, `${date}/${REGION}/${SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const sig = createHmac("sha256", signingKey(secret, date))
    .update(stringToSign, "utf8").digest("hex");

  return fetch(`https://${host()}${canonicalUri}`, {
    method,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${key}/${date}/${REGION}/${SERVICE}/aws4_request, ` +
        `SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
    body: body as unknown as BodyInit | undefined,
  });
}

/**
 * Signed request against the BUCKET root with a query string — ListObjectsV2.
 * Separate from signedFetch because the canonical request signs the query, and
 * the resource is the bucket rather than an object key.
 */
async function signedFetchQuery(
  method: "GET",
  params: URLSearchParams,
): Promise<Response> {
  const { key, secret, bucket: r2Bucket } = cfg();
  const { amz, date } = stamps();
  const canonicalUri = `/${r2Bucket}`;
  const payloadHash = sha256Hex("");
  const canonicalQuery = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const headers: Record<string, string> = {
    host: host(),
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders =
    Object.keys(headers).sort().map((h) => `${h}:${headers[h]}`).join("\n") + "\n";
  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256", amz, `${date}/${REGION}/${SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const sig = createHmac("sha256", signingKey(secret, date))
    .update(stringToSign, "utf8").digest("hex");

  return fetch(`https://${host()}${canonicalUri}?${canonicalQuery}`, {
    method,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${key}/${date}/${REGION}/${SERVICE}/aws4_request, ` +
        `SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
  });
}

type Err = { message: string; name?: string; status?: number };
const ok = <T,>(data: T) => ({ data, error: null as Err | null });
const fail = (message: string, status?: number) => ({
  data: null,
  error: { message, name: "StorageError", status } as Err,
});

function bucketApi(bucket: string) {
  return {
    async upload(
      path: string,
      body: ArrayBuffer | Uint8Array | Blob | Buffer | string,
      opts?: { contentType?: string; upsert?: boolean },
    ) {
      let bytes: Uint8Array;
      if (typeof body === "string") bytes = new TextEncoder().encode(body);
      else if (body instanceof Uint8Array) bytes = body;
      else if (typeof Blob !== "undefined" && body instanceof Blob)
        bytes = new Uint8Array(await body.arrayBuffer());
      else bytes = new Uint8Array(body as ArrayBuffer);

      const headers: Record<string, string> =
        opts?.upsert ? {} : { "if-none-match": "*" };
      try {
        const res = await signedFetch(
          "PUT", bucket, path, bytes,
          opts?.contentType || "application/octet-stream", headers);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          // 412 is the upsert:false collision. Supabase reported this as
          // "Duplicate", and callers branch on that word — keep it.
          return res.status === 412
            ? fail("Duplicate: object already exists", 409)
            : fail(`R2 upload failed (${res.status}): ${text.slice(0, 200)}`, res.status);
        }
        return ok({ path, fullPath: objectKey(bucket, path) });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "R2 upload failed");
      }
    },

    async download(path: string) {
      try {
        const res = await signedFetch("GET", bucket, path);
        if (!res.ok) return fail(`R2 download failed (${res.status})`, res.status);
        const buf = await res.arrayBuffer();
        // supabase-js returns a Blob here; callers do .arrayBuffer()/.text().
        return ok(new Blob([buf]));
      } catch (e) {
        return fail(e instanceof Error ? e.message : "R2 download failed");
      }
    },

    async createSignedUrl(path: string, expiresIn: number) {
      try {
        return ok({ signedUrl: presignGet(bucket, path, expiresIn) });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "presign failed");
      }
    },

    async createSignedUrls(paths: string[], expiresIn: number) {
      try {
        return ok(paths.map((p) => ({
          path: p, signedUrl: presignGet(bucket, p, expiresIn), error: null,
        })));
      } catch (e) {
        return fail(e instanceof Error ? e.message : "presign failed");
      }
    },

    /**
     * Direct-to-storage upload URL.
     *
     * Two live paths need this and neither proxies bytes through the server:
     * the PUBLIC SunBiz lead form (a prospect uploading bank statements) and
     * chat attachments. Without it, swapping `.storage` to R2 makes
     * `createSignedUploadUrl` undefined and the upload dies as a TypeError.
     *
     * `token` mirrors supabase-js, which returns an opaque handle for
     * uploadToSignedUrl(). There is no equivalent server-side handle in S3 —
     * the signature IS the authorization — so the query string is handed back
     * as the token. Callers that only forward it (both of ours do) work
     * unchanged.
     *
     * `upsert` is accepted and ignored: R2 overwrites by default and there is
     * no single-request "fail if exists". Rejecting the option outright would
     * break the chat path, which passes `{upsert: false}` merely to express a
     * preference, and its storage keys already carry a timestamp and a UUID.
     */
    async createSignedUploadUrl(path: string, _options?: { upsert?: boolean }) {
      try {
        const signedUrl = presign("PUT", bucket, path, SIGNED_UPLOAD_TTL_SEC);
        const token = signedUrl.slice(signedUrl.indexOf("?") + 1);
        return ok({ path, signedUrl, token });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "presign upload failed");
      }
    },

    /**
     * Object metadata, used to confirm a direct upload actually landed before
     * a row is written for it. HEAD rather than GET so a large statement is not
     * pulled back through the server just to read its size.
     */
    async info(path: string) {
      try {
        const res = await signedFetch("HEAD", bucket, path);
        if (res.status === 404) return fail("object not found", 404);
        if (!res.ok) return fail(`R2 head failed (${res.status})`, res.status);
        const size = Number(res.headers.get("content-length") ?? 0);
        return ok({
          name: path.split("/").pop() ?? path,
          id: res.headers.get("etag")?.replace(/"/g, "") ?? null,
          size,
          contentLength: size,
          contentType: res.headers.get("content-type") ?? "application/octet-stream",
          mimetype: res.headers.get("content-type") ?? "application/octet-stream",
          lastModified: res.headers.get("last-modified") ?? null,
          etag: res.headers.get("etag") ?? null,
          cacheControl: res.headers.get("cache-control") ?? null,
          metadata: {},
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : "R2 head failed");
      }
    },

    /**
     * Only meaningful when R2_PUBLIC_BASE_URL is set (an r2.dev URL or custom
     * domain bound to the bucket). Returns the URL unconditionally, matching
     * supabase-js — which also hands back a URL that 404s for a private bucket
     * rather than erroring.
     */
    getPublicUrl(path: string) {
      const { publicBase } = cfg();
      return {
        data: {
          publicUrl: publicBase
            ? `${publicBase}/${objectKey(bucket, path)}`
            : presignGet(bucket, path, 3600),
        },
      };
    },

    async remove(paths: string[]) {
      const results: { name: string }[] = [];
      for (const p of paths) {
        try {
          const res = await signedFetch("DELETE", bucket, p);
          // R2 returns 204 for a delete, and 404 for an object that is already
          // gone — both mean "not there any more", which is what remove() promises.
          if (res.ok || res.status === 404) results.push({ name: p });
          else return fail(`R2 delete failed (${res.status}) for ${p}`, res.status);
        } catch (e) {
          return fail(e instanceof Error ? e.message : "R2 delete failed");
        }
      }
      return ok(results);
    },

    /**
     * List objects under a prefix. Implemented, not stubbed — lead-documents.ts
     * uses it to confirm an uploaded object exists AND to read its REAL size as
     * an anti-spoof check against the size the client claimed. Returning an
     * error (or worse, []) would silently disable a security control.
     *
     * Shaped like supabase-js: `{ name, metadata: { size } }`, where `name` is
     * relative to the listed directory.
     */
    async list(
      prefix?: string,
      opts?: { search?: string; limit?: number },
    ) {
      const dir = (prefix || "").replace(/^\/+|\/+$/g, "");
      const keyPrefix = objectKey(bucket, dir ? `${dir}/` : "");
      const params = new URLSearchParams({
        "list-type": "2",
        prefix: keyPrefix,
        "max-keys": String(Math.min(opts?.limit ?? 1000, 1000)),
      });
      try {
        const res = await signedFetchQuery("GET", params);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return fail(`R2 list failed (${res.status}): ${text.slice(0, 200)}`, res.status);
        }
        const xml = await res.text();
        const out: { name: string; id: string; metadata: { size: number } }[] = [];
        // ListObjectsV2 returns XML; each object is one <Contents> block.
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const block = m[1];
          const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? "";
          const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? "0");
          if (!key.startsWith(keyPrefix)) continue;
          const name = key.slice(keyPrefix.length);
          // Supabase's list() is not recursive; skip nested paths so a caller
          // matching on exact `name` behaves the same on both backends.
          if (name.includes("/")) continue;
          if (opts?.search && !name.includes(opts.search)) continue;
          out.push({ name, id: key, metadata: { size } });
        }
        return ok(out);
      } catch (e) {
        return fail(e instanceof Error ? e.message : "R2 list failed");
      }
    },
  };
}

/** `supabase.storage`-shaped surface backed by R2. */
export function r2StorageSurface() {
  return {
    from: (bucket: string) => bucketApi(bucket),
    listBuckets: async () =>
      fail("storage.listBuckets() is not implemented on the R2 adapter"),
  };
}
