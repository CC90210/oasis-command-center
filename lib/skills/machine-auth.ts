/**
 * lib/skills/machine-auth.ts - who is checking in (JARVIS plan 2).
 *
 * A computer presents `Bearer skc_<computerId>_<secret>`. Only sha256(key) is stored; the stored
 * hash is compared in constant time. Rate-limited per IP BEFORE the lookup (as the bridge-token
 * routes do), and nothing here reads the body: auth always runs first. A missing, malformed,
 * wrong or revoked key is the same 401, so the answer never says which. A database error is 503
 * (fail closed), never a pass.
 */
import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import type { NextResponse } from "next/server";
import { clientIpFromHeaders, sha256 } from "@/lib/api-helpers";
import { json } from "@/lib/playbook/http";
import { rateLimit } from "@/lib/rate-limit";
import { KEY_RE, MAX_BODY_BYTES } from "./contract";

export type Computer = { id: string; owner_user_id: string; is_primary: boolean };
type Denied = { ok: false; response: NextResponse };

export async function authenticateComputer(req: Request, db: Client): Promise<{ ok: true; computer: Computer } | Denied> {
  const rl = rateLimit({ key: `skills.checkin:${clientIpFromHeaders(req.headers)}`, capacity: 30, refillPerSec: 0.5 });
  if (!rl.allowed) return { ok: false, response: json({ ok: false, error: "rate_limited" }, 429) };
  const deny: Denied = { ok: false, response: json({ ok: false, error: "unauthorized" }, 401) };
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return deny;
  const key = auth.slice(7).trim();
  const m = KEY_RE.exec(key);
  if (!m) return deny;
  try {
    const rs = await db.execute({ sql: "SELECT id, owner_user_id, is_primary, key_hash, revoked_at FROM skills_computer WHERE id = ?", args: [m[1]] });
    const row = rs.rows[0];
    if (!row || !row.key_hash || row.revoked_at) return deny;
    const want = Buffer.from(String(row.key_hash), "hex");
    const got = Buffer.from(sha256(key), "hex");
    if (want.length !== got.length || !timingSafeEqual(want, got)) return deny;
    return { ok: true, computer: { id: String(row.id), owner_user_id: String(row.owner_user_id), is_primary: Number(row.is_primary) === 1 } };
  } catch (err) {
    console.error("[skills.checkin.auth]", err);
    return { ok: false, response: json({ ok: false, error: "storage_unavailable" }, 503) };
  }
}

const TOO_LARGE: Denied = { ok: false, response: json({ ok: false, error: "too_large" }, 413) };
const BAD_JSON: Denied = { ok: false, response: json({ ok: false, error: "bad_json" }, 400) };

/**
 * The JSON body under MAX_BODY_BYTES: 413 when larger (declared or actual), 400 when not a JSON
 * object. The content-length check is a fast path only, never the enforcement: a chunked body,
 * or one sent with no content-length header at all, would otherwise be buffered in full (up to
 * the platform's own cap, tens of MB) before any size check ran. The real cap is a running BYTE
 * count read off the stream, cancelling the reader the moment it is exceeded, so an oversize body
 * is never held in memory whole. Counting `req.text()`'s result in UTF-16 *characters* (the
 * previous shape of this function) undercounts any body with multi-byte UTF-8 text — 2,000,000
 * three-byte characters is ~6 MB but only 2,000,000 JS string chars, so it passed the old check;
 * the byte count here is exact regardless of what the text contains.
 */
export async function readBoundedJson(req: Request): Promise<{ ok: true; body: unknown } | Denied> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return TOO_LARGE;
  let bytes: Uint8Array;
  if (!req.body) {
    bytes = new Uint8Array(0);
  } else {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        return TOO_LARGE;
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return { ok: true, body: v };
  } catch {
    return BAD_JSON;
  }
}
