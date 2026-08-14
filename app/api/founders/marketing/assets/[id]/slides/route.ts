/**
 * PUT /api/founders/marketing/assets/[id]/slides — re-order a carousel.
 *
 * Slide order is not decoration. A carousel read out of order is a different
 * post, and the order recorded here is what scripts/marketing_publish_drain.py
 * publishes — so this endpoint decides what an audience actually sees.
 *
 * THE ONLY THING THE CLIENT MAY DO IS PERMUTE.
 * The request sends the storage paths in their new order and nothing else. The
 * server loads the asset's CURRENT media_urls and refuses anything that is not a
 * permutation of it — same multiset, same length, nothing added, nothing
 * dropped, nothing renamed.
 *
 * That check is the security boundary, not a tidiness rule. media_urls feeds
 * signMediaUrls() and the publisher, so an accepted arbitrary string would let a
 * caller point this asset at another tenant's object and have the app sign a URL
 * for it — a read of someone else's storage, laundered through our own signer.
 * Comparing against what is already stored makes that unreachable: you cannot
 * name a path the asset does not already own.
 *
 * FOUNDERS ONLY, tenant-scoped on read AND write, 404 rather than 403.
 */

import { NextResponse } from "next/server";

import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveFounder } from "@/lib/founders/gate";
import { parseSlideUrls } from "@/lib/founders-marketing-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

type Ctx = { params: Promise<{ id: string }> };

/** Same multiset, any order. Duplicates count — a slide repeated twice must stay twice. */
function isPermutation(next: string[], current: string[]): boolean {
  if (next.length !== current.length) return false;
  const tally = new Map<string, number>();
  for (const p of current) tally.set(p, (tally.get(p) ?? 0) + 1);
  for (const p of next) {
    const n = tally.get(p);
    if (!n) return false;
    tally.set(p, n - 1);
  }
  return [...tally.values()].every((n) => n === 0);
}

export async function PUT(req: Request, ctx: Ctx) {
  const founder = await resolveFounder();
  if (!founder) return notFound();
  const { id } = await ctx.params;

  let body: { slides?: unknown };
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const next = Array.isArray(body.slides) ? body.slides.map(String) : null;
  if (!next || next.length < 2) {
    return NextResponse.json(
      { ok: false, error: "slides must be an array of at least 2 storage paths" },
      { status: 400 },
    );
  }

  const db = getServiceSupabase();

  // Tenant-scoped on the way in. A uuid in the URL is not proof of ownership.
  const asset = await db
    .from("marketing_asset")
    .select("id, title, asset_type, media_urls, slide_count")
    .eq("tenant_id", founder.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (asset.error) {
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500 });
  }
  if (!asset.data) return notFound();
  if (asset.data.asset_type !== "carousel") {
    return NextResponse.json(
      { ok: false, error: "not_a_carousel", detail: `asset_type is ${asset.data.asset_type}` },
      { status: 400 },
    );
  }

  const current = parseSlideUrls(asset.data.media_urls);
  if (current.length < 2) {
    return NextResponse.json(
      { ok: false, error: "no_recorded_order", detail: "this carousel has no slide order to change" },
      { status: 409 },
    );
  }

  if (!isPermutation(next, current)) {
    // Deliberately specific: this is the difference between "you reordered
    // wrongly" and "you tried to name a path this asset does not own".
    return NextResponse.json(
      {
        ok: false,
        error: "not_a_permutation",
        detail:
          "the new order must contain exactly the slides this asset already has — " +
          "no additions, removals or renames",
        expected_count: current.length,
        received_count: next.length,
      },
      { status: 400 },
    );
  }

  const unchanged = next.every((p, i) => p === current[i]);
  if (unchanged) {
    return NextResponse.json({ ok: true, unchanged: true, slides: current });
  }

  const updated = await db
    .from("marketing_asset")
    .update({
      media_urls: JSON.stringify(next),
      // slide_count is unchanged by a permutation, but stamping it keeps the two
      // columns from drifting if a future edit ever changes length.
      slide_count: next.length,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", founder.tenantId)
    .eq("id", id)
    .select("id, media_urls, slide_count")
    .maybeSingle();

  if (updated.error || !updated.data) {
    // Carry the driver's reason. A bare "failed" is the shape that hid a NOT
    // NULL violation behind "invite_create_failed" for months.
    const detail = updated.error?.message || "update returned no row";
    return NextResponse.json({ ok: false, error: `reorder_failed: ${detail}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    slides: parseSlideUrls(updated.data.media_urls),
    slide_count: updated.data.slide_count,
  });
}
