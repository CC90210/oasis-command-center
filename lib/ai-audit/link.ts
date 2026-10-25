/**
 * lib/ai-audit/link.ts — the client's private audit link, and the signed
 * address the Mac uses to print the PDF.
 *
 * THE TOKEN is 32 bytes: HMAC-SHA256 of AI_AUDIT_LINK_SECRET over the delivery
 * approval's idempotency key. Deriving it (rather than drawing it at random)
 * means a retried send after a crash re-creates the SAME link, so an email
 * already in the client's inbox keeps working. Only its sha256 is stored; the
 * token itself exists in the email and nowhere else.
 *
 * THE LOOKUP is the one query in this feature not filtered by tenant: the
 * token is the client's only credential (the /sign/<token> and /meet/<code>
 * pattern). Everything after it uses the link row's own tenant_id. A missing,
 * expired or revoked link gets the same answer, so the page reveals nothing
 * about which it was.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Client, Row } from "@libsql/client";
import { newId, sha256Hex } from "@/lib/ai-audit/hash";
import { SHARE_LINK_TTL_DAYS } from "@/lib/ai-audit/rules";
import { int, requireTenant, text } from "@/lib/ai-audit/store";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function mintLinkToken(secret: string, idempotencyKey: string): string {
  return createHmac("sha256", secret).update(`ai-audit-link:${idempotencyKey}`, "utf8").digest("base64url");
}

export function isPlausibleToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export function tokenHash(token: string): string {
  return sha256Hex(`ai-audit-link-token:${token}`);
}

export type ShareLink = {
  id: string;
  tenant_id: string;
  engagement_id: string;
  audit_version_id: string;
  proposal_version_id: string;
  approval_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
};

const COLUMNS =
  "id, tenant_id, engagement_id, audit_version_id, proposal_version_id, approval_id, created_at, expires_at, revoked_at, revoked_reason, first_viewed_at, last_viewed_at, view_count";

function mapLink(r: Row): ShareLink {
  return {
    id: String(r.id),
    tenant_id: String(r.tenant_id),
    engagement_id: String(r.engagement_id),
    audit_version_id: String(r.audit_version_id),
    proposal_version_id: String(r.proposal_version_id),
    approval_id: String(r.approval_id),
    created_at: String(r.created_at),
    expires_at: String(r.expires_at),
    revoked_at: text(r.revoked_at),
    revoked_reason: text(r.revoked_reason),
    first_viewed_at: text(r.first_viewed_at),
    last_viewed_at: text(r.last_viewed_at),
    view_count: int(r.view_count),
  };
}

/**
 * The link for an approval, created once. A second call for the same approval
 * (a retried delivery) returns the row the first one made. Revokes any other
 * live link of the engagement first, so the newest delivery is the only link.
 */
export async function createShareLink(
  db: Client,
  input: { tenantId: string; engagementId: string; auditVersionId: string; proposalVersionId: string; approvalId: string; token: string; now: Date },
): Promise<ShareLink> {
  const t = requireTenant(input.tenantId);
  const at = input.now.toISOString();
  const expires = new Date(input.now.getTime() + SHARE_LINK_TTL_DAYS * 86_400_000).toISOString();
  await db.batch(
    [
      {
        sql: `UPDATE ai_audit_share_links SET revoked_at = ?, revoked_reason = 'replaced'
              WHERE tenant_id = ? AND engagement_id = ? AND revoked_at IS NULL AND approval_id <> ?`,
        args: [at, t, input.engagementId, input.approvalId],
      },
      {
        sql: `INSERT INTO ai_audit_share_links (id, tenant_id, engagement_id, audit_version_id, proposal_version_id, approval_id, token_sha256, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (tenant_id, approval_id) DO NOTHING`,
        args: [newId(), t, input.engagementId, input.auditVersionId, input.proposalVersionId, input.approvalId, tokenHash(input.token), at, expires],
      },
    ],
    "write",
  );
  const row = (await db.execute({ sql: `SELECT ${COLUMNS} FROM ai_audit_share_links WHERE tenant_id = ? AND approval_id = ? LIMIT 1`, args: [t, input.approvalId] })).rows[0];
  if (!row) throw new Error("ai-audit.link: created a link but cannot read it back");
  return mapLink(row);
}

/** The live link a token opens, or null for every kind of "no". */
export async function findLiveLink(db: Client, token: unknown, now: Date): Promise<ShareLink | null> {
  if (!isPlausibleToken(token)) return null;
  const row = (await db.execute({ sql: `SELECT ${COLUMNS} FROM ai_audit_share_links WHERE token_sha256 = ? LIMIT 1`, args: [tokenHash(token)] })).rows[0];
  if (!row) return null;
  const link = mapLink(row);
  if (link.revoked_at) return null;
  if (Date.parse(link.expires_at) <= now.getTime()) return null;
  return link;
}

export async function getShareLink(db: Client, tenantId: string, id: string): Promise<ShareLink | null> {
  const row = (await db.execute({ sql: `SELECT ${COLUMNS} FROM ai_audit_share_links WHERE tenant_id = ? AND id = ? LIMIT 1`, args: [requireTenant(tenantId), id] })).rows[0];
  return row ? mapLink(row) : null;
}

export async function revokeShareLink(db: Client, tenantId: string, id: string, reason: string, now: Date): Promise<boolean> {
  const r = await db.execute({
    sql: "UPDATE ai_audit_share_links SET revoked_at = ?, revoked_reason = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL",
    args: [now.toISOString(), reason.slice(0, 64), requireTenant(tenantId), id],
  });
  return r.rowsAffected === 1;
}

/** A counted view (from the page's own visibility signal). True the first time. */
export async function recordLinkView(db: Client, link: ShareLink, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const r = await db.execute({
    sql: `UPDATE ai_audit_share_links SET view_count = view_count + 1, last_viewed_at = ?, first_viewed_at = COALESCE(first_viewed_at, ?)
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
    args: [at, at, link.tenant_id, link.id],
  });
  return r.rowsAffected === 1 && !link.first_viewed_at;
}

// ---------------------------------------------------------------------------
// The PDF render address (the Mac runner opens it; nobody else can)
// ---------------------------------------------------------------------------

export const RENDER_URL_TTL_SECONDS = 15 * 60;

function renderMac(secret: string, tenantId: string, versionId: string, exp: number): Buffer {
  return createHmac("sha256", secret).update(`ai-audit-render:${tenantId}:${versionId}:${exp}`, "utf8").digest();
}

export function signRenderPath(secret: string, tenantId: string, versionId: string, now: Date): string {
  const exp = Math.floor(now.getTime() / 1000) + RENDER_URL_TTL_SECONDS;
  const sig = renderMac(secret, tenantId, versionId, exp).toString("base64url");
  const q = new URLSearchParams({ t: tenantId, exp: String(exp), sig });
  return `/audit-print/${encodeURIComponent(versionId)}?${q.toString()}`;
}

export function verifyRenderSignature(secret: string, input: { tenantId: unknown; versionId: unknown; exp: unknown; sig: unknown }, now: Date): boolean {
  if (typeof input.tenantId !== "string" || typeof input.versionId !== "string" || typeof input.sig !== "string") return false;
  const exp = Number(input.exp);
  if (!Number.isSafeInteger(exp) || exp * 1000 < now.getTime()) return false;
  if (exp * 1000 > now.getTime() + (RENDER_URL_TTL_SECONDS + 60) * 1000) return false;
  let given: Buffer;
  try {
    given = Buffer.from(input.sig, "base64url");
  } catch {
    return false;
  }
  const want = renderMac(secret, input.tenantId, input.versionId, exp);
  return given.length === want.length && timingSafeEqual(given, want);
}
