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
    // The lib throws PostgREST/Turso error OBJECTS (`if (result.error) throw
    // result.error`) — plain shapes like {message, details, code}, NOT
    // instanceof Error. So every real failure here reported detail:
    // "unknown_error", and this route 500'd hourly for days with its cause
    // discarded at the one place that knew it. Serialize whatever was thrown;
    // an ugly detail string beats a mute one.
    const detail =
      cause instanceof Error
        ? cause.message
        : (() => {
            try {
              return JSON.stringify(cause)?.slice(0, 300) || String(cause);
            } catch {
              return String(cause);
            }
          })();
    return NextResponse.json(
      { ok: false, error: "drip_telemetry_reconciliation_failed", detail },
      { status: 500 },
    );
  }
}
