/**
 * lib/offer-pages/upload.ts - the write side of an offer page's own video
 * (slice V3, design section 4.1 note "for other workspaces, use slice V3").
 *
 * No new table. The FINAL object's own path IS the record: its shape encodes
 * the tenant and the kind (lib/offer-pages/types.ts uploadPathKind), and the
 * real HEAD (size, content-type) is read back whenever trust in it matters.
 *
 * TWO NAMESPACES, so a verified object can never be swapped afterward
 * (TOCTOU, Codex security review 2026-10-12, with a race-condition follow-up
 * on 2026-10-12's own first fix):
 *   STAGING  <tenant>/offer-pages/_staging/<kind>/<uuid>.<ext>  a presigned
 *            PUT is minted here, and ONLY here. Content-Length and
 *            Content-Type are SIGNED into that PUT (lib/r2-storage.ts
 *            createSignedUploadUrlConstrained), so R2 itself refuses a body
 *            of a different size or a different declared type - the cap
 *            holds even against a client that ignores it, not only a
 *            server-side check after the fact. The presign is short-lived
 *            (OFFER_UPLOAD_PUT_TTL_SEC, minutes). NEVER deleted by confirm
 *            (see below); belongs under an R2 lifecycle rule to expire it
 *            after a short TTL - not configured here, no live R2 in this
 *            sandbox to apply it against.
 *   FINAL    <tenant>/offer-pages/<kind-subdir>/<form id>/<uuid>.<ext>  the
 *            ONLY shape ever named in a page doc or served to a visitor. No
 *            presigned PUT is EVER minted for a final key: the only way one
 *            is written is the server-side conditional copy below, and its
 *            <uuid> is a FRESH crypto.randomUUID() generated AT CONFIRM TIME
 *            (finalPathFor) - never derived from the token, the staging
 *            path, or anything else a caller could cause to repeat.
 *            uploadPathKind's regex (types.ts) cannot even match a staging
 *            path, so the parser refuses one on sight if it ever reached a
 *            request body.
 *
 *   mintOfferUpload     an owner/admin asks for a presigned, SIZE-AND-TYPE-
 *                       CONSTRAINED PUT to one new, random STAGING object
 *                       under THEIR tenant (never the body's). Returns a
 *                       short-lived HMAC token naming exactly that object -
 *                       not a trust decision (the real check is the HEAD and
 *                       the conditional copy below), just this feature's own
 *                       expiry.
 *   confirmOfferUpload  verifies the token (tenant AND form bound), HEADs the
 *                       staging object, re-checks its REAL size and type
 *                       against the kind's cap (never the declared ones),
 *                       then COPIES it to a FRESH, call-specific FINAL key
 *                       (finalPathFor) conditional on the ETag just read
 *                       (x-amz-copy-source-if-match): if the staging object
 *                       changed in between (a swap), R2 refuses the copy
 *                       instead of promoting different bytes. The FINAL
 *                       object's own size/type are checked again straight
 *                       after the copy, independent of whether R2 actually
 *                       enforced the condition - belt and suspenders.
 *
 *                       EVERY confirm call for the same token - a sequential
 *                       replay, or two truly concurrent requests - mints its
 *                       OWN final key here, so none of them can ever target
 *                       the one another has already written (or will write):
 *                       the race is removed by construction, not by a "does
 *                       it already exist" check (which itself races: two
 *                       concurrent HEADs can both see "no" before either
 *                       copies, and R2's if-none-match on a CopyObject
 *                       request is unverified in this sandbox - kept as a
 *                       harmless extra condition on the copy, never relied
 *                       on alone). A replay or a race can at most leave an
 *                       extra, never-referenced object behind; the one a
 *                       draft save or a published page already points at
 *                       can never change without a new save and publish
 *                       (its own rights-tick gate).
 *   verifyUploadObject  (lib/offer-pages/video.ts, not here - see that
 *                       module's header) the read-only check for an
 *                       UNTRUSTED final path from a request body or a
 *                       published doc about to be served.
 *
 * Every check fails CLOSED: a storage error, a malformed or expired token, a
 * cross-tenant/cross-form token, a missing signing key, or an object outside
 * its kind's cap or type is the same refusal as "not found" or 503.
 */
import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { r2Configured, r2StorageSurface } from "@/lib/r2-storage";
import { DERIVED_KEY_LABELS, deriveKey } from "@/lib/crypto/derived-keys";
import { MAX_UPLOAD_BYTES, OFFER_UPLOAD_BUCKET, UPLOAD_MIME, uploadSubdirOf, type UploadKind } from "./types";
// verifyUploadObject and OfferUploadStorage live in ./video, NOT here: video.ts
// carries no "server-only" (by design - lib/offer-pages/render.ts's render
// path runs in a child process that strips the react-server condition for
// react-dom/server, and "server-only" throws there on sight). This module
// stays the one with real side effects (R2 writes, HMAC signing); the
// read-only verify check belongs with the rest of the resolve/serve logic.
import { normalizedMime, type OfferUploadStorage, type VerifyResult } from "./video";

export { OFFER_UPLOAD_BUCKET };

/** The staging PUT's own window: short, so a leaked signed URL (browser history, a proxy log) is not a standing write grant for long. */
export const OFFER_UPLOAD_PUT_TTL_SEC = 5 * 60;
/** This feature's own token lifetime: independent of, and a little longer than, the PUT window, so a slow upload still has time to be confirmed. */
export const UPLOAD_TOKEN_TTL_SEC = 10 * 60;

const STAGING_SEGMENT = "_staging";

/** `<tenant>/offer-pages/_staging/<kind-subdir>/<uuid>.<ext>` - the ONLY path a presigned PUT is ever minted for. */
function stagingPathFor(tenantId: string, kind: UploadKind, ext: string): string {
  return `${tenantId}/offer-pages/${STAGING_SEGMENT}/${uploadSubdirOf(kind)}/${randomUUID()}.${ext}`;
}

/**
 * The FINAL key THIS CONFIRM CALL promotes to: the staging path's own
 * tenant/kind/extension, the token's own form id, and a FRESH
 * crypto.randomUUID() generated right here, at confirm time - never derived
 * from anything in the token itself.
 *
 * Codex security review of e99e9a90's fix (deterministic-from-nonce) still
 * had a TOCTOU window: two concurrent replays of one token could both pass
 * a "does the final key already exist" HEAD check before either copied, and
 * R2's if-none-match on a CopyObject request is unverified, so the shared
 * destination could still be written twice. This removes the race BY
 * CONSTRUCTION instead of checking for it: every confirm call - a
 * legitimate one, a sequential replay, or two truly concurrent ones - gets
 * its OWN final key, so no two confirmations can ever target the same one,
 * and the HEAD "already exists" pre-check this replaced is no longer
 * meaningful (a freshly random key is never already in storage) and has
 * been dropped. A replay or a race can at most create an extra, never-
 * referenced object; the one a draft save or a published page already
 * points at can never be overwritten. Changing the video still requires a
 * new draft save and publish (its own rights-tick gate).
 */
function finalPathFor(stagingPath: string, formId: string): string {
  const m = /^(.+\/offer-pages\/)_staging\/([^/]+)\/[0-9a-f-]+(\.[a-z0-9]+)$/.exec(stagingPath);
  if (!m) throw new Error("not a staging path"); // stagingPath is always ours (stagingPathFor); never attacker input.
  return `${m[1]}${m[2]}/${formId}/${randomUUID()}${m[3]}`;
}

export function offerUploadStorageConfigured(): boolean {
  return r2Configured();
}

/** The real adapter: null when R2 is not configured (every caller treats that as "unavailable", never a silent pass). */
export function offerUploadStorage(): OfferUploadStorage | null {
  if (!r2Configured()) return null;
  const bucket = r2StorageSurface().from(OFFER_UPLOAD_BUCKET);
  return {
    async createSignedUploadUrl(path, opts) {
      const r = await bucket.createSignedUploadUrlConstrained(path, opts);
      if (r.error || !r.data?.signedUrl) throw new Error(r.error?.message || "no signed URL");
      return { signedUrl: r.data.signedUrl };
    },
    async info(path) {
      const r = await bucket.info(path);
      if (r.error) {
        if (r.error.status === 404) return null;
        throw new Error(r.error.message);
      }
      return r.data ? { size: Number(r.data.size), contentType: r.data.contentType ?? null, etag: r.data.etag ?? null } : null;
    },
    async copyIfMatch(sourcePath, destPath, etag) {
      const r = await bucket.copyIfMatch(sourcePath, destPath, etag);
      if (r.error) return { ok: false, error: r.error.status === 412 || r.error.status === 409 ? "precondition_failed" : "failed" };
      return { ok: true };
    },
    async remove(path) {
      await bucket.remove([path]);
    },
  };
}

// ---------------------------------------------------------------------------
// The HMAC token: names one STAGING object, for one tenant and one form,
// briefly. The key is purpose-bound, derived per request - never a database
// service key, and never shared with any other token kind (Codex security
// review 2026-10-12: "never use a database service key as an HMAC key").
// ---------------------------------------------------------------------------

type UploadTokenPayload = { v: 1; exp: number; nonce: string; tenant_id: string; form_id: string; kind: UploadKind; staging_path: string };

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Thrown only by uploadSigningKey, never anything else below - so a caller can tell "the signing key itself is unavailable" apart from every other failure without sniffing message text. */
class KeyUnavailableError extends Error {}

/** HKDF-SHA256 over AUTH_SESSION_SECRET (lib/crypto/derived-keys.ts, O4's own pattern): one purpose-bound key, no new Cloudflare secret, no fallback to a key provisioned for anything else. Throws KeyUnavailableError when AUTH_SESSION_SECRET is missing or too short - every caller below turns that into a fail-closed 503 (upload_unavailable), never a silent pass. */
async function uploadSigningKey(): Promise<Buffer> {
  try {
    const hex = await deriveKey(DERIVED_KEY_LABELS.offerUpload);
    return Buffer.from(hex, "hex");
  } catch (err) {
    throw new KeyUnavailableError(err instanceof Error ? err.message : String(err));
  }
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
    (o.kind === "video" || o.kind === "poster" || o.kind === "caption") &&
    typeof o.staging_path === "string"
  );
}

async function signUploadToken(payload: Omit<UploadTokenPayload, "v" | "exp" | "nonce">): Promise<string> {
  const full: UploadTokenPayload = { v: 1, exp: Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_TTL_SEC, nonce: randomUUID(), ...payload };
  const body = base64UrlEncode(JSON.stringify(full));
  const key = await uploadSigningKey();
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

type VerifiedToken = { ok: true; payload: UploadTokenPayload } | { ok: false; error: "invalid_token" | "token_expired" };

async function verifyUploadToken(token: unknown): Promise<VerifiedToken> {
  if (typeof token !== "string" || !token) return { ok: false, error: "invalid_token" };
  const [body, sig] = token.split(".");
  if (!body || !sig) return { ok: false, error: "invalid_token" };
  const key = await uploadSigningKey();
  const expected = createHmac("sha256", key).update(body).digest("base64url");
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
// Mint
// ---------------------------------------------------------------------------

export type MintResult =
  | { ok: true; storagePath: string; signedUrl: string; uploadToken: string; expiresIn: number }
  | { ok: false; error: "unsupported_type" | "too_large" | "storage_unavailable" | "key_unavailable" };

/**
 * A presigned, SIZE-AND-TYPE-CONSTRAINED PUT for one new STAGING object,
 * under this caller's own tenant, for `kind`. `mimeType` and `sizeBytes` are
 * the browser's declared values, BUT they are not merely a first line of
 * defense here: they are signed into the PUT's Content-Length and
 * Content-Type, so R2 itself refuses a request that does not match them
 * exactly - a client cannot upload more bytes, or claim a different type,
 * than what this call allowed. confirmOfferUpload re-reads the real object
 * anyway; nothing is ever trusted twice over for the same reason.
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
  const stagingPath = stagingPathFor(input.tenantId, input.kind, ext);
  let signedUrl: string;
  let uploadToken: string;
  try {
    ({ signedUrl } = await input.storage.createSignedUploadUrl(stagingPath, {
      contentLength: input.sizeBytes,
      contentType: input.mimeType,
      ttlSec: OFFER_UPLOAD_PUT_TTL_SEC,
    }));
    uploadToken = await signUploadToken({ tenant_id: input.tenantId, form_id: input.formId, kind: input.kind, staging_path: stagingPath });
  } catch (err) {
    if (err instanceof KeyUnavailableError) return { ok: false, error: "key_unavailable" };
    return { ok: false, error: "storage_unavailable" };
  }
  return { ok: true, storagePath: stagingPath, signedUrl, uploadToken, expiresIn: UPLOAD_TOKEN_TTL_SEC };
}

// ---------------------------------------------------------------------------
// Confirm: HEAD, cap/type check, conditional copy to the immutable FINAL key,
// re-verify the copy, remove the staging object.
// ---------------------------------------------------------------------------

export type ConfirmResult = VerifyResult | { ok: false; error: "invalid_token" | "token_expired" | "key_unavailable" };

/**
 * The token-gated confirm step. Trusts nothing about the staging object but
 * its real HEAD; closes the TOCTOU window (confirm checks the object, but the
 * presigned PUT stays valid until it expires, so the object could otherwise
 * be replaced after confirm) by copying it to a FRESH, call-specific FINAL
 * key (finalPathFor) conditional on the ETag just verified - a swap between
 * the HEAD and the copy fails the copy's own precondition instead of
 * promoting different bytes - and then re-checking the FINAL object's own
 * size and type regardless of whether R2 actually enforced that precondition.
 * The staging object is removed after (best effort); only the FINAL path is
 * ever returned, and it is the only path a page doc may ever carry.
 *
 * NO SHARED DESTINATION, SO NO RACE (Codex security review 2026-10-12,
 * confirm-replay-overwrite then its own TOCTOU follow-up): a sequential
 * replay and two truly concurrent confirms of the SAME token each mint
 * their OWN final key here, so none of them can ever land on the SAME
 * object another one (or an earlier, legitimate confirm) already wrote -
 * there is no "does it already exist" question left to race on. A replay or
 * a race can at most leave an extra, never-referenced object behind; the one
 * a draft save or a published page already points at can never change
 * without a new save and publish (its own rights-tick gate).
 */
export async function confirmOfferUpload(input: {
  tenantId: string;
  formId: string;
  uploadToken: unknown;
  storage: OfferUploadStorage | null;
}): Promise<ConfirmResult> {
  let verified: VerifiedToken;
  try {
    verified = await verifyUploadToken(input.uploadToken);
  } catch (err) {
    if (err instanceof KeyUnavailableError) return { ok: false, error: "key_unavailable" };
    return { ok: false, error: "invalid_token" };
  }
  if (!verified.ok) return verified;
  if (verified.payload.tenant_id !== input.tenantId || verified.payload.form_id !== input.formId) {
    return { ok: false, error: "not_found" };
  }
  if (!input.storage) return { ok: false, error: "storage_unavailable" };
  const { kind, staging_path: stagingPath } = verified.payload;
  const finalPath = finalPathFor(stagingPath, input.formId);

  let head: { size: number; contentType: string | null; etag: string | null } | null;
  try {
    head = await input.storage.info(stagingPath);
  } catch {
    return { ok: false, error: "storage_unavailable" };
  }
  if (!head) return { ok: false, error: "not_found" };
  if (!Number.isFinite(head.size) || head.size <= 0 || head.size > MAX_UPLOAD_BYTES[kind]) return { ok: false, error: "too_large" };
  const mime = normalizedMime(head.contentType);
  if (mime && mime !== "application/octet-stream" && !(mime in UPLOAD_MIME[kind])) return { ok: false, error: "wrong_type" };
  if (!head.etag) return { ok: false, error: "storage_unavailable" };

  const copied = await input.storage.copyIfMatch(stagingPath, finalPath, head.etag);
  if (!copied.ok) return { ok: false, error: copied.error === "precondition_failed" ? "swapped" : "storage_unavailable" };

  // Belt and suspenders: re-check the FINAL object's own properties, whether
  // or not R2 actually enforced the copy's precondition.
  let finalHead: { size: number; contentType: string | null; etag: string | null } | null;
  try {
    finalHead = await input.storage.info(finalPath);
  } catch {
    return { ok: false, error: "storage_unavailable" };
  }
  if (!finalHead || finalHead.size !== head.size) return { ok: false, error: "swapped" };
  const finalMime = normalizedMime(finalHead.contentType);
  if (finalMime && finalMime !== "application/octet-stream" && !(finalMime in UPLOAD_MIME[kind])) return { ok: false, error: "wrong_type" };

  // The staging object is deliberately NOT deleted here. Each confirm now
  // promotes to its OWN fresh final key (finalPathFor), so a second
  // confirm of the same token - sequential or truly concurrent - reads the
  // SAME still-present staging object and independently succeeds with its
  // own copy, rather than racing to delete a source the other one still
  // needs. Staging objects are ephemeral by construction (their presign and
  // this feature's own token both expire in minutes) and belong under an R2
  // lifecycle rule that expires the `_staging/` prefix after a short TTL -
  // NOT configured here; this sandbox has no live R2 to apply it against,
  // and it is called out as a NOT VERIFIED follow-up in the PR.
  return { ok: true, upload: { kind, path: finalPath, bytes: finalHead.size, mime: finalMime || null } };
}
