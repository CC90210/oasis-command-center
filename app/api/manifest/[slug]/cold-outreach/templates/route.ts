/**
 * GET /api/manifest/<slug>/cold-outreach/templates
 *
 * HTML email template catalog for the Cold Outreach composer. The
 * templates are the SunBiz marketing library (SunBiz-Agent/docs/*.html)
 * vendored into lib/cold-outreach/templates/ and compiled into a
 * generated module — see scripts/generate-cold-outreach-templates.mjs.
 *
 * Without ?key: { ok: true, templates: [{ key, name, subject, size_bytes }] }
 *   (metadata only — the full set is ~340KB of HTML, no point shipping
 *   it all to the picker)
 * With ?key=<key>: { ok: true, template: { key, name, subject, html } }
 *
 * Auth: session required + caller must own this slug — same gate as the
 * sibling campaigns route.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { manifestExists } from "@/lib/manifest/loader";
import { COLD_OUTREACH_TEMPLATES } from "@/lib/cold-outreach/templates.generated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ ok: false, error: "invalid_slug" }, { status: 400 });
  }
  if (!(await manifestExists(slug))) {
    return NextResponse.json({ ok: false, error: "unknown_tenant" }, { status: 404 });
  }

  const db = getServiceSupabase();
  const profileRes = await db
    .from("user_profiles")
    .select("tenant_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const userTenantId =
    (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  const dataTenantId = await resolveDataTenant(slug, userTenantId);
  if (!dataTenantId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const key = req.nextUrl.searchParams.get("key");
  if (key) {
    const t = COLD_OUTREACH_TEMPLATES.find((x) => x.key === key);
    if (!t) {
      return NextResponse.json({ ok: false, error: "unknown_template" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      template: { key: t.key, name: t.name, subject: t.subject, html: t.html },
    });
  }

  return NextResponse.json({
    ok: true,
    templates: COLD_OUTREACH_TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      subject: t.subject,
      size_bytes: t.html.length,
    })),
  });
}
