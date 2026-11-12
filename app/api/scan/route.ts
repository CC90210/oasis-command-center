/**
 * POST /api/scan — start (or reuse) a free scan of a public website.
 *
 * Public: a visitor has no session. Guards, in order: same origin, 5 scans per hour per address,
 * a honeypot a script fills, a body under 4 KB, and the audit's own address rules (public names
 * only; a social profile is told so). The response is immediate; Tier 0 runs after it returns and
 * the page watches GET /api/scan/:id.
 */
import { NextResponse, after } from "next/server";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { clientIpFromHeaders, sha256 } from "@/lib/api-helpers";
import { HONEYPOT_BODY_KEY, isHoneypotFilled } from "@/lib/forms/honeypot";
import { readCappedJson, sameOrigin } from "@/lib/offer-pages/public-http";
import { rateLimit } from "@/lib/rate-limit";
import { siteTarget } from "@/lib/ai-audit/site-url";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { claimKeyFor } from "@/lib/site-scan/claim";
import { closeCrashedTier0, runTier0 } from "@/lib/site-scan/run";
import { findReusableScan, insertScan, scanKeyOf, siteScanTablesInstalled } from "@/lib/site-scan/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

export const SCANS_PER_HOUR = 5;

export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return json(403, { ok: false, error: "forbidden" });
  const ip = clientIpFromHeaders(req.headers);
  const limit = rateLimit({ key: `site-scan:create:${ip === "unknown" ? "no-ip" : ip}`, capacity: SCANS_PER_HOUR, refillPerSec: SCANS_PER_HOUR / 3600 });
  if (!limit.allowed) return json(429, { ok: false, error: "rate_limited", retry_in_sec: limit.resetIn });
  const body = await readCappedJson(req, 4_096);
  if (!body) return json(400, { ok: false, error: "bad_body" });
  if (isHoneypotFilled(body[HONEYPOT_BODY_KEY])) {
    console.warn("[site-scan.create] honeypot filled; request dropped");
    return json(200, { ok: true, trapped: true });
  }
  const raw = typeof body.website === "string" ? body.website.trim().slice(0, 500) : "";
  if (!raw) return json(422, { ok: false, error: "website_required" });
  const target = siteTarget(raw);
  if (target.kind === "social") return json(422, { ok: false, error: "social_profile", platform: target.platform });
  if (target.kind !== "site") return json(422, { ok: false, error: "not_a_website", reason: target.reason });
  if (!tursoConfigured()) return json(503, { ok: false, error: "not_installed" });

  const db = getTursoClient();
  if (!(await siteScanTablesInstalled(db))) return json(503, { ok: false, error: "not_installed" });
  const now = new Date();
  const domain = scanKeyOf(target);
  // The claim key goes only to a browser that asked for this scan (lib/site-scan/claim.ts). A
  // visitor re-scanning the same domain gets it too: they could have started the scan themselves.
  const existing = await findReusableScan(db, AI_AUDIT_TENANT_ID, domain, now);
  if (existing) return json(200, { ok: true, scan_id: existing.id, reused: true, claim_key: claimKeyFor(existing.id) });

  const ipHash = ip === "unknown" ? null : sha256(`site-scan:${ip}`).slice(0, 32);
  const { row, started } = await insertScan(db, { tenantId: AI_AUDIT_TENANT_ID, domain, url: target.start, ipHash, now });
  if (started) {
    after(async () => {
      try {
        await runTier0(db, { tenantId: AI_AUDIT_TENANT_ID, scanId: row.id });
      } catch (err) {
        console.error("[site-scan.create] tier 0 crashed", { scanId: row.id, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
        // Never leave the row looking busy: a later visitor would be handed it instead of a new read.
        await closeCrashedTier0(db, { tenantId: AI_AUDIT_TENANT_ID, scanId: row.id, now: new Date() }).catch((closeErr: unknown) => {
          console.error("[site-scan.create] crashed scan not closed", { scanId: row.id, error: closeErr instanceof Error ? closeErr.message : String(closeErr) });
        });
      }
    });
  }
  return json(started ? 201 : 200, { ok: true, scan_id: row.id, reused: !started, claim_key: claimKeyFor(row.id) });
}
