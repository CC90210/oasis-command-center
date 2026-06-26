/**
 * /api/integrations/personal/nurture — per-rep AI nurture mode.
 *
 * Each rep chooses their OWN mode for their OWN account:
 *   off  — no auto-replies / follow-ups
 *   semi — answers the clear stuff + follow-ups, escalates objection/call/hot/
 *          uncertain to the rep (notify) for manual intervention
 *   full — hands-off auto-replies + follow-ups
 *
 * Writes the plaintext settings + the rep's STAMPED Text Torrent identity
 * (from_number / act_as_email / name) into agent_nurture_settings on the Bravo
 * project, which the JARVIS apex-sms-nurture worker reads (it can't decrypt the
 * per-user credential store, so identity is stamped here — same pattern as the
 * blaster campaign). Setting mode != off requires the rep to have BOTH their TT
 * number and account email set (fail-closed).
 *
 * GET  — returns { mode, notify_channel }
 * POST — { mode: 'off'|'semi'|'full', notify_channel?: 'telegram'|'email' }
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import {
  resolveTextTorrentSenderId,
  resolveTextTorrentActAsEmail,
} from "@/lib/integrations/texttorrent-sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES = ["off", "semi", "full"] as const;
const NOTIFY = ["telegram", "email"] as const;

type Profile = { tenant_id: string | null; display_name: string | null; full_name: string | null; email: string | null };

async function resolveProfile(userId: string): Promise<Profile | null> {
  const db = getServiceSupabase();
  const r = await db
    .from("user_profiles")
    .select("tenant_id, display_name, full_name, email")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return (r.data as Profile | null) ?? null;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const profile = await resolveProfile(user.id);
  if (!profile?.tenant_id) return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });

  const db = getServiceSupabase();
  const r = await db
    .from("agent_nurture_settings")
    .select("mode, notify_channel")
    .eq("tenant_id", profile.tenant_id)
    .eq("user_id", user.id)
    .maybeSingle();
  const row = (r.data as { mode?: string; notify_channel?: string } | null) ?? null;
  return NextResponse.json({
    ok: true,
    mode: row?.mode ?? "off",
    notify_channel: row?.notify_channel ?? "telegram",
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const profile = await resolveProfile(user.id);
  if (!profile?.tenant_id) return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  const tenantId = profile.tenant_id;

  let body: { mode?: unknown; notify_channel?: unknown };
  try {
    body = (await req.json()) as { mode?: unknown; notify_channel?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const mode = typeof body.mode === "string" ? body.mode : "";
  if (!(MODES as readonly string[]).includes(mode)) {
    return NextResponse.json({ ok: false, error: "invalid_mode", allowed: MODES }, { status: 400 });
  }
  const notify =
    typeof body.notify_channel === "string" && (NOTIFY as readonly string[]).includes(body.notify_channel)
      ? body.notify_channel
      : "telegram";

  // Resolve the rep's TT identity to stamp. Required to turn nurture on.
  const fromNumber = (await resolveTextTorrentSenderId({ tenantId, userId: user.id })) ?? null;
  const actAsEmail = (await resolveTextTorrentActAsEmail({ tenantId, userId: user.id })) ?? null;
  if (mode !== "off" && (!fromNumber || !actAsEmail)) {
    return NextResponse.json(
      {
        ok: false,
        error: "tt_identity_required",
        message:
          "Set your Text Torrent number AND account email in Settings → Personal Integrations before turning the AI on.",
      },
      { status: 400 },
    );
  }

  const db = getServiceSupabase();
  const { error } = await db.from("agent_nurture_settings").upsert(
    {
      tenant_id: tenantId,
      user_id: user.id,
      mode,
      notify_channel: notify,
      from_number: fromNumber,
      act_as_email: actAsEmail,
      rep_name: profile.display_name || profile.full_name || null,
      rep_email: actAsEmail, // the rep's SunBiz email merchants send docs to
      rep_phone: fromNumber, // the rep's number merchants call
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,user_id" },
  );
  if (error) {
    return NextResponse.json({ ok: false, error: "save_failed", detail: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, mode, notify_channel: notify });
}
