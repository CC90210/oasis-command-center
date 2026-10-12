/**
 * lib/offer-pages/upload.ts - the write side of an offer page's own video
 * (slice V3, design section 4.1 note "for other workspaces, use slice V3").
 *
 * No new table. The object itself, in the private offer-page-uploads prefix
 * (one physical R2 bucket; lib/r2-storage.ts), IS the record: its path encodes
 * the tenant and the kind, and the real HEAD (size, content-type) is read back
 * every time trust in it matters - at confirm, and again whenever a NEW path
 * is saved into a draft (app/api/forms/[id]/offer/route.ts). An object that is
 * later deleted simply stops playing, the same as a dead third-party link.
 *
 *   mintOfferUpload     an owner/admin asks for a presigned PUT to one new,
 *                       random object under THEIR tenant (never the body's),
 *                       for a kind (video, poster, caption) whose declared
 *                       type and size already pass that kind's cap. Returns a
 *                       short-lived HMAC token naming exactly that object: not
 *                       a trust decision (the real check is the HEAD below),
 *                       just this feature's OWN expiry, independent of
 *                       whatever window R2's presigned PUT itself carries.
 *   confirmOfferUpload  verifies the token (tenant AND form bound, so a token
 *                       minted under one workspace's session can never be
 *                       redeemed by another's), then calls verifyUploadObject.
 *   verifyUploadObject  trusts NOTHING the caller says about the object:
 *                       re-parses the path's shape and tenant ownership, HEADs
 *                       the real object, and refuses on a missing object, a
 *                       real size over that kind's cap, or (when R2 reports
 *                       one) a content-type outside that kind's allowed set.
 *                       Called again, with no token, for every path in a PUT
 *                       save that was not already known from the draft or
 *                       the published copy - the confirm step attaches
 *                       nothing on its own; the ordinary draft save does, and
 *                       re-asserts this same rule so a tampered PUT can never
 *                       attach an object outside this tenant or one that
 *                       never actually landed.
 *
 * Every check fails CLOSED: a storage error, a malformed token, an expired
 * one, or a cross-tenant/cross-form token is the same refusal as "not found".
 */
import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { r2Configured, r2StorageSurface } from "@/lib/r2-storage";
import { pathBelongsToTenant } from "@/lib/storage-helpers";
import {
  MAX_UPLOAD_BYTES,
  OFFER_UPLOAD_BUCKET,
  UPLOAD_MIME,
  uploadPathKind,
  uploadSubdirOf,
  type UploadKind,
} from "./types";

export { OFFER_UPLOAD_BUCKET };

/** The app-level token's own lifetime: independent of, and longer than, R2's own presigned-PUT window, so a slow phone upload is never the thing that expires first. */
export const UPLOAD_TOKEN_TTL_SEC = 20 * 60;

export type OfferUploadStorage = {
  createSignedUploadUrl(path: string): Promise<{ signedUrl: string }>;
  /** null: no such object. Throws when the store could not be asked. */
  info(path: string): Promise<{ size: number; contentType: string | null } | null>;
};

export function offerUploadStorageConfigured(): boolean {
  return r2Configured();
}

/** The real adapter: null when R2 is not configured (every caller treats that as "unavailable", never a silent pass). */
export function offerUploadStorage(): OfferUploadStorage | null {
  if (!r2Configured()) return null;
  const bucket = r2StorageSurface().from(OFFER_UPLOAD_BUCKET);
  return {
    async createSignedUploadUrl(path) {
      const r = await bucket.createSignedUploadUrl(path, { upsert: false });
      if (r.error || !r.data?.signedUrl) throw new Error(r.error?.message || "no signed URL");
      return { signedUrl: r.data.signedUrl };
    },
    async info(path) {
      const r = await bucket.info(path);
      if (r.error) {
        if (r.error.status === 404) return null;
        throw new Error(r.error.message);
      }
      return r.data ? { size: Number(r.data.size), contentType: r.data.contentType ?? null } : null;
    },
  };
}

/** `<tenant>/offer-pages/<video|poster|captions>/<uuid>.<ext>` - the one shape mintOfferUpload ever writes. */
export function uploadPathFor(tenantId: string, kind: UploadKind, ext: string): string {
  return `${tenantId}/offer-pages/${uploadSubdirOf(kind)}/${randomUUID()}.${ext}`;
}

// ---------------------------------------------------------------------------
// The HMAC token: names one object, for one tenant and one form, briefly.
// ---------------------------------------------------------------------------

type UploadTokenPayload = { v: 1; exp: number; nonce: string; tenant_id: string; form_id: string; path: string };

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The same secret family chat-attachments.ts uses, so no NEW required Worker
 * secret: OFFER_UPLOAD_HMAC_KEY is preferred if it is ever added, but the
 * fallbacks are already live wherever chat attachments work today.
 */
function uploadSigningKey(): string {
  const key =
    process.env.OFFER_UPLOAD_HMAC_KEY ||
    process.env.CHAT_ATTACHMENT_HMAC_KEY ||
    process.env.OASIS_OUTBOUND_HMAC_SECRET ||
    process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("offer_upload_signing_key_missing");
  return key;
}

function isUploadTokenPayload(v: unknown): v is UploadTokenPayload {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.exp === "number" &&
    typeof o.nonce === "string" &&
    typeof o.tenant_id === "string" &&
    typeof o.form_id === "string" &&
    typeof o.path === "string"
  );
}

function signUploadToken(payload: Omit<UploadTokenPayload, "v" | "exp" | "nonce">): string {
  const full: UploadTokenPayload = { v: 1, exp: Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_TTL_SEC, nonce: randomUUID(), ...payload };
  const body = base64UrlEncode(JSON.stringify(full));
  const sig = createHmac("sha256", uploadSigningKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

type VerifiedToken = { ok: true; payload: UploadTokenPayload } | { ok: false; error: "invalid_token" | "token_expired" };

function verifyUploadToken(token: unknown): VerifiedToken {
  if (typeof token !== "string" || !token) return { ok: false, error: "invalid_token" };
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, error: "invalid_token" };
  let expected: string;
  try {
    expected = createHmac("sha256", uploadSigningKey()).update(body).digest("base64url");
  } catch {
    return { ok: false, error: "invalid_token" };
  }
  if (!safeEqual(sig, expected)) return { ok: false, error: "invalid_token" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "invalid_token" };
  }
  if (!isUploadTokenPayload(parsed)) return { ok: false, error: "invalid_token" };
  if (parsed.exp < Math.floor(Date.now() / 1000)) return { ok: false, error: "token_expired" };
  return { ok: true, payload: parsed };
}

// ---------------------------------------------------------------------------
// Mint, verify, confirm
// ---------------------------------------------------------------------------

export type MintResult =
  | { ok: true; storagePath: string; signedUrl: string; uploadToken: string; expiresIn: number }
  | { ok: false; error: "unsupported_type" | "too_large" | "storage_unavailable" };

/**
 * A presigned PUT for one new object, under this caller's own tenant, for
 * `kind`. `mimeType` and `sizeBytes` are the browser's DECLARED values - the
 * first line of defense (and the only reason a bad type never even gets a
 * signed URL) - never trusted again after this: `verifyUploadObject` re-reads
 * the real object at confirm, and once more at save if it is new.
 */
export async function mintOfferUpload(input: {
  tenantId: string;
  formId: string;
  kind: UploadKind;
  mimeType: string;
  sizeBytes: number;
  storage: OfferUploadStorage | null;
}): Promise<MintResult> {
  const ext = UPLOAD_MIME[input.kind][input.mimeType];
  if (!ext) return { ok: false, error: "unsupported_type" };
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_UPLOAD_BYTES[input.kind]) {
    return { ok: false, error: "too_large" };
  }
  if (!input.storage) return { ok: false, error: "storage_unavailable" };
  const storagePath = uploadPathFor(input.tenantId, input.kind, ext);
  const { signedUrl } = await input.storage.createSignedUploadUrl(storagePath);
  const uploadToken = signUploadToken({ tenant_id: input.tenantId, form_id: input.formId, path: storagePath });
  return { ok: true, storagePath, signedUrl, uploadToken, expiresIn: UPLOAD_TOKEN_TTL_SEC };
}

export type ConfirmedUpload = { kind: UploadKind; path: string; bytes: number; mime: string | null };
export type VerifyResult = { ok: true; upload: ConfirmedUpload } | { ok: false; error: "invalid_path" | "not_found" | "too_large" | "wrong_type" | "storage_unavailable" };

/**
 * Trust nothing but the path's own shape and the REAL object: this is the one
 * place that ever decides an uploaded object is this workspace's to show.
 * Called by confirmOfferUpload (token-gated, fresh upload) AND directly by the
 * offer PUT route (no token; a path already in the draft or published copy is
 * re-verified the same way whenever it is new to this save).
 */
export async function verifyUploadObject(input: { tenantId: string; path: unknown; storage: OfferUploadStorage | null }): Promise<VerifyResult> {
  if (typeof input.path !== "string" || !input.path) return { ok: false, error: "invalid_path" };
  const kind = uploadPathKind(input.path);
  if (!kind) return { ok: false, error: "invalid_path" };
  if (!pathBelongsToTenant(input.tenantId, input.path)) return { ok: false, error: "not_found" };
  if (!input.storage) return { ok: false, error: "storage_unavailable" };
  let head: { size: number; contentType: string | null } | null;
  try {
    head = await input.storage.info(input.path);
  } catch {
    return { ok: false, error: "storage_unavailable" };
  }
  if (!head) return { ok: false, error: "not_found" };
  if (!Number.isFinite(head.size) || head.size <= 0 || head.size > MAX_UPLOAD_BYTES[kind]) {
    return { ok: false, error: "too_large" };
  }
  const mime = (head.contentType || "").split(";")[0].trim().toLowerCase();
  if (mime && mime !== "application/octet-stream" && !(mime in UPLOAD_MIME[kind])) {
    return { ok: false, error: "wrong_type" };
  }
  return { ok: true, upload: { kind, path: input.path, bytes: head.size, mime: mime || null } };
}

export type ConfirmResult = VerifyResult | { ok: false; error: "invalid_token" | "token_expired" };

/** The token-gated confirm step (design: "verifies the object exists, matches declared type and size, belongs to the caller's tenant prefix"). Never trusts the token's own claims about size or type: those come only from the real HEAD inside verifyUploadObject. */
export async function confirmOfferUpload(input: {
  tenantId: string;
  formId: string;
  uploadToken: unknown;
  storage: OfferUploadStorage | null;
}): Promise<ConfirmResult> {
  const verified = verifyUploadToken(input.uploadToken);
  if (!verified.ok) return verified;
  if (verified.payload.tenant_id !== input.tenantId || verified.payload.form_id !== input.formId) {
    return { ok: false, error: "not_found" };
  }
  return verifyUploadObject({ tenantId: input.tenantId, path: verified.payload.path, storage: input.storage });
}
