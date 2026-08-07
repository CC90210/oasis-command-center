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

export function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  );
}

function cfg() {
  return {
    account: process.env.R2_ACCOUNT_ID!,
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

function presignGet(bucket: string, path: string, expiresInSec: number): string {
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
    "GET", canonicalUri, canonicalQuery, `host:${host()}\n`, "host", "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256", amz, `${date}/${REGION}/${SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const sig = createHmac("sha256", signingKey(secret, date))
    .update(stringToSign, "utf8").digest("hex");
  return `https://${host()}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${sig}`;
}

async function signedFetch(
  method: "PUT" | "GET" | "DELETE",
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

    async list(_prefix?: string) {
      // Deliberately unimplemented rather than silently returning []. An empty
      // list is indistinguishable from "no objects", which would make a caller
      // conclude a merchant has no documents and act on it.
      return fail(
        "storage.list() is not implemented on the R2 adapter. " +
        "Query the database for the object paths instead of listing the bucket.",
      );
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
