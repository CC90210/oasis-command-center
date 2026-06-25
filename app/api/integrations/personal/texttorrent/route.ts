/**
 * /api/integrations/personal/texttorrent — per-employee TextTorrent overrides.
 *
 * Per-agent SMS (2026-06-24), extended 2026-06-25 with a per-rep act-as email.
 * SunBiz reps share ONE tenant TextTorrent API key but each sends as their OWN
 * sub-account, from their OWN number. Two independent overrides per employee:
 *   - texttorrent_from_number — "send my SMS from THIS number" (my own DID);
 *     falls back to the tenant "Default Business Number" when unset.
 *   - texttorrent_act_as_email — "send UNDER my own TextTorrent account" (the
 *     X-ACT-AS-USER sub-account email); falls back to the tenant master identity
 *     when unset. This is what makes a blast go out on the rep's own account +
 *     daily limit + inbox. Direct analogue of Kixie's kixie_agent_email.
 *
 * GET    — returns the user's current texttorrent_from_number + texttorrent_act_as_email
 * POST   — { texttorrent_from_number?: string, texttorrent_act_as_email?: string }
 *          set/update whichever field(s) are present
 * DELETE — ?field=texttorrent_from_number | texttorrent_act_as_email clears one;
 *          no ?field clears the from-number (legacy default)
 *
 * Stored encrypted in user_integration_credentials, per-tenant per-user.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { normalizePhoneE164 } from "@/lib/lead-interactions-queries";
import {
  getUserIntegrationValue,
  setUserIntegrationValue,
  clearUserIntegrationField,
} from "@/lib/user-integration-store";
import {
  TEXTTORRENT_FROM_NUMBER_FIELD,
  TEXTTORRENT_ACT_AS_EMAIL_FIELD,
} from "@/lib/integrations/texttorrent-sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TT_FIELDS = [TEXTTORRENT_FROM_NUMBER_FIELD, TEXTTORRENT_ACT_AS_EMAIL_FIELD] as const;

async function resolveTenantId(userId: string): Promise<string | null> {
  const db = getServiceSupabase();
  const r = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  return (r.data as { tenant_id?: string | null } | null)?.tenant_id ?? null;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveTenantId(user.id);
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  const [fromNumber, actAsEmail] = await Promise.all([
    getUserIntegrationValue(tenantId, user.id, "texttorrent", TEXTTORRENT_FROM_NUMBER_FIELD),
    getUserIntegrationValue(tenantId, user.id, "texttorrent", TEXTTORRENT_ACT_AS_EMAIL_FIELD),
  ]);
  return NextResponse.json({
    ok: true,
    texttorrent_from_number: fromNumber || null,
    texttorrent_act_as_email: actAsEmail || null,
  });
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveTenantId(user.id);
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  let body: { texttorrent_from_number?: unknown; texttorrent_act_as_email?: unknown };
  try {
    body = (await req.json()) as { texttorrent_from_number?: unknown; texttorrent_act_as_email?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const hasFrom = typeof body.texttorrent_from_number === "string";
  const hasEmail = typeof body.texttorrent_act_as_email === "string";
  if (!hasFrom && !hasEmail) {
    return NextResponse.json(
      {
        ok: false,
        error: "nothing_to_update",
        message: "Provide texttorrent_from_number and/or texttorrent_act_as_email.",
      },
      { status: 400 },
    );
  }

  const out: { texttorrent_from_number?: string; texttorrent_act_as_email?: string } = {};

  if (hasFrom) {
    // normalizePhoneE164 is lenient (digit-only, assumes +1 for 10 digits).
    // Require a strict E.164 result so a typo'd number is rejected at save time
    // instead of failing later as a TT send error.
    const normalized = normalizePhoneE164((body.texttorrent_from_number as string).trim());
    if (!normalized || !/^\+[1-9]\d{7,14}$/.test(normalized)) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_from_number",
          message: "Provide a valid number in E.164 format, e.g. +17542127833.",
        },
        { status: 400 },
      );
    }
    const result = await setUserIntegrationValue(
      tenantId,
      user.id,
      "texttorrent",
      TEXTTORRENT_FROM_NUMBER_FIELD,
      normalized,
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: "save_failed", message: result.error }, { status: 500 });
    }
    out.texttorrent_from_number = normalized;
  }

  if (hasEmail) {
    const email = (body.texttorrent_act_as_email as string).trim();
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_act_as_email",
          message: "Provide a valid TextTorrent account email, e.g. alex@sunbizfunding.com.",
        },
        { status: 400 },
      );
    }
    const result = await setUserIntegrationValue(
      tenantId,
      user.id,
      "texttorrent",
      TEXTTORRENT_ACT_AS_EMAIL_FIELD,
      email,
    );
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: "save_failed", message: result.error }, { status: 500 });
    }
    out.texttorrent_act_as_email = email;
  }

  return NextResponse.json({ ok: true, ...out });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const tenantId = await resolveTenantId(user.id);
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  // ?field=<one of TT_FIELDS> clears just that override; no ?field clears the
  // from-number for symmetry with the original single-field behavior.
  const field = req.nextUrl.searchParams.get("field") || TEXTTORRENT_FROM_NUMBER_FIELD;
  if (!(TT_FIELDS as readonly string[]).includes(field)) {
    return NextResponse.json({ ok: false, error: "unknown_field" }, { status: 400 });
  }
  const result = await clearUserIntegrationField(tenantId, user.id, "texttorrent", field);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: "clear_failed", message: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, cleared: field });
}
