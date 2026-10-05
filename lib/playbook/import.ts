/**
 * lib/playbook/import.ts - the rules for POST /api/internal/playbook/import,
 * the harness's way to copy an allowlisted document's text into OASIS's hub.
 *
 * WHO. The harness authenticates with the OASIS operator proxy bearer: the
 * Worker secret BRIDGE_BEARER_TOKEN_OASIS_AI_CC, the same bearer OCC's bridge
 * proxy sends for the OASIS workspace (the harness stores it as
 * OASIS_COMMAND_CENTER__BRIDGE_BEARER_TOKEN_OASIS_AI_CC). Unset or short:
 * every call is 503, never "open". Compared in constant time over SHA-256
 * digests.
 *
 * WHERE. The tenant is forced to OASIS's documents tenant. The body names no
 * tenant, and one it does name is ignored.
 *
 * WHAT. Only catalog documents whose source is "stored" (never a live page,
 * never a slug the catalog does not know). A link-only document (a signed
 * agreement kept where it was signed) carries a source_url and no text. Text
 * that looks like a credential is refused outright: a private key block, a
 * Stripe secret or restricted key, an OpenAI/Anthropic-style `sk-` key, a
 * Slack or GitHub token, an AWS access key id. The same hash as the stored
 * text is a no-op.
 *
 * WHEN. Only after CC consents to copying document text into Turso (US
 * region). Until then the hub works from the catalog, the live documents and
 * in-app drafts; the harness script ships in a paired BEA PR.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { catalogDoc, type CatalogDoc } from "./catalog";

export const IMPORT_BEARER_ENV = "BRIDGE_BEARER_TOKEN_OASIS_AI_CC";
export const IMPORT_MAX_DOCS = 50;
export const IMPORT_MAX_BODY_CHARS = 200_000;

/** Each pattern names a credential shape. The name is reported; the match never is. */
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private_key_block", /-----BEGIN [A-Z0-9 ]*(PRIVATE KEY|CERTIFICATE)-----|-----BEGIN/],
  ["stripe_secret_key", /(^|[^A-Za-z0-9])(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/],
  ["stripe_webhook_secret", /(^|[^A-Za-z0-9])whsec_[A-Za-z0-9]{16,}/],
  ["api_key_sk", /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/],
  ["slack_token", /(^|[^A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/],
  ["github_token", /(^|[^A-Za-z0-9])(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/],
  ["aws_access_key_id", /(^|[^A-Z0-9])AKIA[0-9A-Z]{16}/],
];

/** The first credential shape found in `text`, or null. */
export function findSecret(text: string | null | undefined): string | null {
  const t = text || "";
  for (const [name, re] of SECRET_PATTERNS) if (re.test(t)) return name;
  return null;
}

export function importBearerOk(header: string | null, expected: string): boolean {
  const given = (header || "").startsWith("Bearer ") ? (header as string).slice(7) : "";
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return given.length > 0 && timingSafeEqual(a, b);
}

export type ImportItem = {
  doc: CatalogDoc;
  body: string | null;
  sourceRef: string;
  sourceUrl: string | null;
  sourceUpdatedAt: string | null;
};

export type ImportRejection = { index: number; slug: string | null; error: string };

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null;
}

/** Validate one item of the request. */
export function parseImportItem(raw: unknown, index: number): { ok: true; item: ImportItem } | { ok: false; rejection: ImportRejection } {
  const bad = (slug: string | null, error: string) => ({ ok: false as const, rejection: { index, slug, error } });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad(null, "not_an_object");
  const o = raw as Record<string, unknown>;
  const slug = str(o.slug, 120);
  const doc = catalogDoc(slug);
  if (!doc) return bad(slug, "unknown_slug");
  if (doc.source.kind !== "stored") return bad(slug, "live_document");
  const sourceRef = str(o.source_ref, 500);
  if (!sourceRef) return bad(slug, "source_ref_required");
  const body = typeof o.body_md === "string" && o.body_md.trim() ? o.body_md.replace(/\r\n?/g, "\n") : null;
  if (body && body.length > IMPORT_MAX_BODY_CHARS) return bad(slug, "body_too_long");
  let sourceUrl: string | null = null;
  if (o.source_url !== undefined && o.source_url !== null && o.source_url !== "") {
    const u = str(o.source_url, 2000);
    if (!u || !/^https:\/\//.test(u)) return bad(slug, "source_url_must_be_https");
    sourceUrl = u;
  }
  if (!body && !sourceUrl) return bad(slug, "body_or_source_url_required");
  let sourceUpdatedAt: string | null = null;
  if (o.source_updated_at !== undefined && o.source_updated_at !== null && o.source_updated_at !== "") {
    const d = str(o.source_updated_at, 40);
    if (!d || !Number.isFinite(Date.parse(d))) return bad(slug, "source_updated_at_invalid");
    sourceUpdatedAt = d;
  }
  const secret = findSecret(body) ?? findSecret(sourceRef) ?? findSecret(sourceUrl);
  if (secret) return bad(slug, `refused_secret:${secret}`);
  return { ok: true, item: { doc, body, sourceRef, sourceUrl, sourceUpdatedAt } };
}
