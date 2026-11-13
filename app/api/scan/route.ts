/**
 * POST /api/scan — start a free scan of a public website (or join the one of the same site
 * already running).
 *
 * Public: a visitor has no session. Guards, in order: same origin, 5 scans per hour per address,
 * a honeypot a script fills, a body under 4 KB, and the audit's own address rules (public names
 * only; a social profile is told so). The response is immediate; the page then opens
 * GET /api/scan/:id/stream, which runs Tier 0 live (this route's after() is the fallback). Every
 * scan a visitor starts is a real run they watch: a finished report of the same site is read
 * again, never handed back (lib/site-scan/store.ts insertScan).
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
import { defaultTier0Deps, runTier0Live } from "@/lib/site-scan/run";
import { claimTier0, insertScan, scanKeyOf, siteScanTablesInstalled } from "@/lib/site-scan/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

// Not exported: a route file may only export its handlers and route config (Next build type check).
const SCANS_PER_HOUR = 5;
/** How long POST waits for the visitor's live stream to claim Tier 0 before running it itself. */
const STREAM_CLAIM_GRACE_MS = 2_000;

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
  const ipHash = ip === "unknown" ? null : sha256(`site-scan:${ip}`).slice(0, 32);
  // The claim key goes only to a browser that asked for this scan (lib/site-scan/claim.ts). A
  // visitor joining the run of the same domain gets it too: they could have started it themselves.
  const { row, started } = await insertScan(db, { tenantId: AI_AUDIT_TENANT_ID, domain, url: target.start, ipHash, now });
  if (started) {
    // The visitor's live stream claims Tier 0 and runs it in its own connection
    // (app/api/scan/[id]/stream). This is the fallback for a browser that never opens one: after a
    // short grace, run it here only if this claim wins (or the database predates the claim). It
    // must fit the ~30 s after() gets: the read's own 25 s budget plus the grace, so the fallback
    // skips PageSpeed (up to 20 s more). A claim that errors runs nothing: the row may be a
    // stream's, and a read nobody finishes is failed by the 3-minute sweep and retried fresh.
    after(async () => {
      await new Promise((r) => setTimeout(r, STREAM_CLAIM_GRACE_MS));
      let claim: Awaited<ReturnType<typeof claimTier0>>;
      try {
        claim = await claimTier0(db, { tenantId: AI_AUDIT_TENANT_ID, id: row.id, now: new Date() });
      } catch (err) {
        console.error("[site-scan.create] tier 0 claim failed; not running it here", { scanId: row.id, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (claim === "taken") return;
      await runTier0Live(db, { tenantId: AI_AUDIT_TENANT_ID, scanId: row.id }, { ...defaultTier0Deps(), pagespeed: null });
    });
  }
  return json(started ? 201 : 200, { ok: true, scan_id: row.id, joined: !started, claim_key: claimKeyFor(row.id) });
}
