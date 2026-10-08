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

/** The JSON body under MAX_BODY_BYTES: 413 when larger (declared or actual), 400 when not a JSON object. */
export async function readBoundedJson(req: Request): Promise<{ ok: true; body: unknown } | Denied> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return { ok: false, response: json({ ok: false, error: "too_large" }, 413) };
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: json({ ok: false, error: "too_large" }, 413) };
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return { ok: true, body: v };
  } catch {
    return { ok: false, response: json({ ok: false, error: "bad_json" }, 400) };
  }
}
