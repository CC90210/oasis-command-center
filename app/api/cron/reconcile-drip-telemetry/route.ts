import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { reconcileDripEmailTelemetry } from "@/lib/drips/reconcile-email-telemetry";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authError = checkCronAuth(req);
  if (authError) return authError;

  try {
    const result = await reconcileDripEmailTelemetry(getServiceSupabase());
    return NextResponse.json({ ok: true, ...result, reconciled_at: new Date().toISOString() });
  } catch (cause) {
    console.error("[reconcile-drip-telemetry] failed", cause);
    return NextResponse.json(
      {
        ok: false,
        error: "drip_telemetry_reconciliation_failed",
        detail: cause instanceof Error ? cause.message : "unknown_error",
      },
      { status: 500 },
    );
  }
}
