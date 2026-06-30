/**
 * /api/campaigns/credits — the tenant's Text Torrent account credit balance.
 *
 * Powers the balance card on the Campaigns → Text Torrent tab. Reads TT's
 * /user/auth/me (meAccountInfo) which the app already exposes but never surfaced.
 * Owner-agnostic read; no send, no mutation.
 */

import { NextResponse } from "next/server";
import { resolveTenantId } from "@/lib/api-auth";
import {
  getTextTorrentCredentials,
  meAccountInfo,
  TextTorrentError,
} from "@/lib/integrations/texttorrent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ttStatus(err: TextTorrentError): number {
  return err.status === 429 ? 429 : err.code === "missing_credentials" ? 400 : 502;
}

export async function GET() {
  const tenantId = await resolveTenantId();
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const creds = await getTextTorrentCredentials(tenantId);
    const me = await meAccountInfo(creds);
    return NextResponse.json({
      ok: true,
      credits: typeof me.credits === "number" ? me.credits : null,
      plan_name: me.plan_name ?? null,
      subscription_status: me.subscription_status ?? null,
    });
  } catch (err) {
    if (err instanceof TextTorrentError) {
      return NextResponse.json(
        { ok: false, error: err.code, message: err.message },
        { status: ttStatus(err) },
      );
    }
    return NextResponse.json(
      { ok: false, error: "credits_failed", message: err instanceof Error ? err.message : "failed" },
      { status: 502 },
    );
  }
}
