/**
 * GET /api/profile     — return the authed operator's profile
 * PATCH /api/profile   — update editable fields on the authed operator's profile
 */
import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { bad } from "@/lib/api-helpers";
import { resolveActiveProfileForUser } from "@/lib/active-profile-resolver";
import { decideProfileEdit } from "@/lib/profile-edit-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return bad(401, "unauthorized");

  const resolved = await resolveActiveProfileForUser(user);
  if (resolved.error) return bad(500, resolved.error);
  if (!resolved.profile) return bad(404, "profile not found — re-run signup");

  return NextResponse.json({ ok: true, profile: resolved.profile });
}

export async function PATCH(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return bad(401, "unauthorized");

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid JSON");
  }

  const resolved = await resolveActiveProfileForUser(user);
  if (resolved.error) return bad(500, resolved.error);
  if (!resolved.profile) return bad(404, "profile not found");
  const currentProfile = resolved.profile;
  const decision = decideProfileEdit(body, {
    teamRole: currentProfile.team_role,
    isOwner: currentProfile.is_owner === true,
    adminAccess: currentProfile.admin_access === true,
  });
  if (!decision.ok) return bad(decision.status, decision.error);
  const update = decision.update;
  const db = getServiceSupabase();

  // 2026-06-06 — custom_fields is a shared JSONB blob (timezone,
  // briefing_channel, photo_url, quick_facts, plan_template_id, etc.).
  // A naked .update({ custom_fields: { quick_facts: "..." } }) replaces
  // the ENTIRE blob, silently wiping the other keys. The Known-facts editor
  // (removed 2026-08-17) did its own read-modify-write, but other writers may
  // not, and CC reported having to re-enter Known Facts repeatedly — likely from
  // a different code path overwriting his blob without RMW. The hazard outlives
  // that editor: `custom_fields` is still a shared blob. The safest
  // fix is server-side merge: when custom_fields is being patched, read
  // the existing value and shallow-merge.
  if (update.custom_fields && typeof update.custom_fields === "object" && !Array.isArray(update.custom_fields)) {
    const prev = currentProfile.custom_fields ?? {};
    update.custom_fields = { ...prev, ...(update.custom_fields as Record<string, unknown>) };
  }

  const r = await db
    .from("user_profiles")
    .update(update)
    .eq("id", currentProfile.id)
    .select("*")
    .maybeSingle();
  if (r.error) return bad(500, r.error.message);
  if (!r.data) return bad(404, "profile not found");

  return NextResponse.json({ ok: true, profile: r.data });
}
