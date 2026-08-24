/**
 * POST /api/web-leads/claim    — take leads into the caller's own book
 * POST /api/web-leads/claim?release=1 — put them back in the pool
 *
 * SELF-SERVICE ON PURPOSE. Any signed-in member of this tenant may claim a
 * lead for THEMSELVES. There is no `userId` in the request body and no way to
 * claim on someone else's behalf through this route -- the owner is always the
 * resolved session. Admin bulk-assignment to a named rep is a separate,
 * admin-gated route; keeping the two apart means a compromised or
 * misunderstood client cannot quietly move leads between reps' books.
 *
 * Auth, in the same order every other route in this feature uses: unresolved
 * caller -> 401 before any read. Caller in a different tenant -> 403. libSQL
 * has no row-level security, so this route IS the authorization boundary.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { claimLeads, releaseLeads } from "@/lib/web-leads/claim-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hard ceiling on one request. Well above a rep's cap so it never binds in
 *  normal use; it exists so a malformed or hostile client cannot ask us to read
 *  and write an unbounded id list in one shot. */
const MAX_IDS_PER_REQUEST = 500;

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  }
  if (session.tenantId !== WEBDEV_TENANT_ID) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const raw = (body as { leadIds?: unknown })?.leadIds;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ ok: false, error: "leadIds_required" }, { status: 400 });
  }
  // Deduplicated: the same id twice in one batch would otherwise consume two
  // slots against the rep's cap for one lead.
  const leadIds = Array.from(
    new Set(raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())),
  );
  if (leadIds.length === 0) {
    return NextResponse.json({ ok: false, error: "leadIds_required" }, { status: 400 });
  }
  if (leadIds.length > MAX_IDS_PER_REQUEST) {
    return NextResponse.json(
      { ok: false, error: `too_many_ids: ${leadIds.length} > ${MAX_IDS_PER_REQUEST}` },
      { status: 400 },
    );
  }

  try {
    if (req.nextUrl.searchParams.get("release") === "1") {
      const result = await releaseLeads(session.userId, session.isAdmin, leadIds);
      return NextResponse.json({ ok: true, ...result });
    }
    // One clock for the whole request: the expiry rules must not see time move
    // between deciding a lead is claimable and writing the claim.
    const result = await claimLeads(session.userId, leadIds, Date.now());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "claim_failed" },
      { status: 500 },
    );
  }
}
