/**
 * POST /api/founders/marketing/assets/[id]/publish — put one asset on channels.
 *
 * CC, 2026-08-14: *"I should be able to click on one of these videos and then
 * manually post it to all the social media channels via our API key that we have
 * connected."*
 *
 * WHY THIS RECORDS INTENT INSTEAD OF POSTING
 * This app runs on Vercel. The only sanctioned publisher is
 * CMO-Agent/scripts/publishers/base.publish() — Python, runs send_gateway first
 * (killswitch, daily caps, audit trail), and needs credentials that live on the
 * operator's machine. A Vercel function cannot call it.
 *
 * The tempting shortcut is to call Zernio's HTTP API from right here. That skips
 * the killswitch, the caps and the audit row — late_adapter's own docstring calls
 * doing so a bug — and it forks the per-platform knowledge that took real
 * failures to learn: Instagram video must declare `contentType: reel`, YouTube
 * needs a <=95-char title. I tried the shortcut by hand first and Zernio answered
 * "Instagram posts require media content", which is what a second, thinner
 * publisher looks like on day one.
 *
 * So the dashboard records what the operator asked for and
 * scripts/marketing_publish_drain.py — which lives where the gateway lives —
 * performs it. The only thing that can send is still the only thing that sends.
 */

import { NextResponse } from "next/server";

import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveFounder } from "@/lib/founders/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

/**
 * Channels the drainer can actually reach — mirrors
 * CMO-Agent/scripts/schedule_posts.py ACCOUNTS.
 *
 * `googlebusiness` is connected and deliberately excluded: CC's call, 2026-07-27,
 * because local/offer posts are a different content shape. Validated here so a
 * hand-crafted request cannot queue work the drainer will only reject later.
 */
const PUBLISHABLE = new Set([
  "instagram",
  "tiktok",
  "youtube",
  "twitter",
  "threads",
  "linkedin",
]);

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const founder = await resolveFounder();
  if (!founder) return notFound();
  const { id } = await ctx.params;

  let body: { platforms?: unknown; note?: unknown };
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const asked = Array.isArray(body.platforms) ? body.platforms.map(String) : [];
  const platforms = [...new Set(asked)].filter((p) => PUBLISHABLE.has(p));
  if (!platforms.length) {
    return NextResponse.json(
      { ok: false, error: "no_publishable_platforms", publishable: [...PUBLISHABLE] },
      { status: 400 },
    );
  }
  const rejected = asked.filter((p) => !PUBLISHABLE.has(p));
  if (rejected.length) {
    // Refuse the whole request rather than quietly posting to fewer surfaces
    // than were asked for — the same rule late_adapter applies to unmapped
    // platforms. Silently dropping a channel is how you think you published.
    return NextResponse.json(
      { ok: false, error: `unsupported_platform: ${rejected.join(", ")}`, publishable: [...PUBLISHABLE] },
      { status: 400 },
    );
  }

  const db = getServiceSupabase();

  // Tenant-scoped, and own-brand only. A uuid in the URL is not proof of
  // anything: the founders portal publishes OASIS's own work, so a client
  // deliverable is a 404 here rather than something you can broadcast.
  const asset = await db
    .from("marketing_asset")
    .select("id, title, status, brand_slug, format")
    .eq("tenant_id", founder.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (asset.error) {
    return NextResponse.json({ ok: false, error: "read_failed" }, { status: 500 });
  }
  if (!asset.data) return notFound();
  if (asset.data.brand_slug !== "oasis-ai") return notFound();

  // Something has to be attached or every channel rejects it downstream. Better
  // to say so now than to queue work that cannot succeed.
  const media = await db
    .from("marketing_asset_media")
    .select("id")
    .eq("tenant_id", founder.tenantId)
    .eq("asset_id", id)
    .limit(1);
  if (!media.error && !(media.data || []).length) {
    return NextResponse.json({ ok: false, error: "no_media_attached" }, { status: 400 });
  }

  // One in flight at a time. A 10 MB reel to five networks takes over a minute,
  // and a second click during that window would publish twice — and there is no
  // unsending.
  const inflight = await db
    .from("marketing_publish_intent")
    .select("id, state")
    .eq("tenant_id", founder.tenantId)
    .eq("asset_id", id)
    .in("state", ["queued", "running"])
    .limit(1);
  // FAIL CLOSED. `!inflight.error && ...` skipped the guard on exactly the case
  // it exists for: when the read fails we do not know whether a publish is in
  // flight, and the sentence three lines up is "there is no unsending". A
  // duplicate post is unrecoverable; a 503 costs one retry.
  if (inflight.error) {
    console.warn("[founders:publish] in-flight check failed", inflight.error.message);
    return NextResponse.json(
      {
        ok: false,
        error: "inflight_check_failed",
        detail:
          "Could not confirm whether a publish is already running for this asset, so nothing was queued. Try again.",
      },
      { status: 503 },
    );
  }
  if ((inflight.data || []).length) {
    return NextResponse.json(
      { ok: false, error: "already_queued", detail: "A publish for this asset is already in flight." },
      { status: 409 },
    );
  }

  const created = await db
    .from("marketing_publish_intent")
    .insert({
      tenant_id: founder.tenantId,
      asset_id: id,
      platforms,
      requested_by: founder.displayName || "founder",
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
      state: "queued",
    })
    .select("id, state, platforms, created_at")
    .maybeSingle();

  if (created.error || !created.data) {
    // Carry the driver's reason. A bare "failed" here is exactly the shape that
    // hid a NOT NULL violation behind "invite_create_failed" for months.
    const detail = created.error?.message || "insert returned no row";
    return NextResponse.json({ ok: false, error: `queue_failed: ${detail}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    queued: true,
    intent: created.data,
    platforms,
    asset: { id: asset.data.id, title: asset.data.title },
  });
}
