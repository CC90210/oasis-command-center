/**
 * POST /api/your-audit/<token>/viewed — the private page's visibility beacon
 * (components/ai-audit/doc/ViewBeacon.tsx), sent only after the page has been
 * visible for a few seconds. The first counted view moves the engagement to
 * "Proposal Under Review". Same-origin, rate-capped, always 204.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { sameOrigin } from "@/lib/offer-pages/public-http";
import { loadPublicAudit, publicLimited } from "@/lib/ai-audit/public";
import { recordLinkView } from "@/lib/ai-audit/link";
import { advanceEngagement } from "@/lib/ai-audit/lifecycle";
import { recordEvent } from "@/lib/ai-audit/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };
const done = () => new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;
  if (!sameOrigin(req) || publicLimited(req, "viewed") || !tursoConfigured()) return done();
  try {
    const db = getTursoClient();
    const now = new Date();
    const data = await loadPublicAudit(db, token, now);
    if (!data) return done();
    const first = await recordLinkView(db, data.link, now);
    if (first) {
      await recordEvent(db, { tenantId: data.link.tenant_id, engagementId: data.engagement.id, event: "client_viewed", actor: { type: "client", id: null }, now, refType: "share_link", refId: data.link.id });
      if (data.engagement.stage === "delivered") {
        await advanceEngagement(db, { tenantId: data.link.tenant_id, engagementId: data.engagement.id, to: "proposal_review", actor: { type: "client", id: null }, now, event: "client_opened_audit", patch: data.engagement.health === "stalled" ? { health: "ok", health_reason: null } : undefined });
      }
    }
  } catch (err) {
    console.error("[your-audit.viewed] failed", err instanceof Error ? err.message : err);
  }
  return done();
}
