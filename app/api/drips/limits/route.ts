/**
 * GET/PATCH /api/drips/limits — the per-channel send ceilings, as a control.
 *
 * Adon, 2026-08-17: "those tabs are actually functional where if I want to
 * increase or decrease the volume, I will be able to use the rest of the
 * software."
 *
 * These ceilings were env-only, so changing one meant a Vercel write and a
 * redeploy. The per-SEQUENCE email cap was already editable; the per-CHANNEL
 * ones were not, and they are the ones that gate the day.
 *
 * Validation lives in channel-limits-core, not here and not in the form: a
 * number input in a browser is not validation, and a typo of 5000 would burn a
 * domain before anyone noticed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveTenantId } from "@/lib/api-auth";
import { getChannelLimits, saveChannelLimits } from "@/lib/drips/channel-limits";
import { LIMIT_MAX, LIMIT_KEYS, LIMIT_LABEL } from "@/lib/drips/channel-limits-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tenantId = await resolveTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const limits = await getChannelLimits(tenantId);
  // Ceilings and labels ship WITH the values so the form cannot drift from the
  // rules that will reject it.
  return NextResponse.json({ ok: true, limits, max: LIMIT_MAX, labels: LIMIT_LABEL, keys: LIMIT_KEYS });
}

export async function PATCH(req: NextRequest) {
  const tenantId = await resolveTenantId();
  if (!tenantId) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  const result = await saveChannelLimits(tenantId, body);
  if (!result.ok) {
    // Field-level problems are a 400 the form can render inline; a storage
    // failure is a 500, because retrying the same values is the right move.
    if ("problems" in result) {
      return NextResponse.json({ ok: false, problems: result.problems }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true, limits: result.limits });
}
