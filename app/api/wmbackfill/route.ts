/**
 * TEMPORARY watermark backfill — re-watermarks existing bank statements that
 * carry a stale watermark version (the v1 invisible-text mark) with the current
 * renderer, ON the Vercel runtime where watermarking is proven. Processes a
 * small batch per call (rasterizing is slow) and reports how many remain, so a
 * caller loops it to completion. Secret-gated. DELETE once existing statements
 * are migrated.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { watermarkStoredBankStatement, WATERMARK_VERSION } from "@/lib/lead-documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TOKEN = "wmbackfill-7f3a9c2e-2026-0628";
const BATCH = 5;

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const db = getServiceSupabase();

  // Stale = a bank statement whose stored watermark isn't the current version
  // (missing → never branded, or an older renderer like the v1 invisible mark).
  const res = await db
    .from("lead_documents")
    .select("id, storage_path", { count: "exact" })
    .eq("doc_type", "bank_statements_3mo")
    .is("metadata->>deleted_at", null)
    .or(`metadata->>watermark_version.is.null,metadata->>watermark_version.neq.${WATERMARK_VERSION}`)
    .limit(BATCH);
  if (res.error) {
    return NextResponse.json({ ok: false, error: res.error.message }, { status: 500 });
  }
  const rows = (res.data || []) as Array<{ storage_path: string }>;
  const totalRemaining = typeof res.count === "number" ? res.count : rows.length;

  let branded = 0;
  const failures: Array<{ path: string; reason: string }> = [];
  for (const r of rows) {
    try {
      const wm = await watermarkStoredBankStatement(r.storage_path, { force: true });
      if (wm.ok) branded += 1;
      else failures.push({ path: r.storage_path, reason: wm.error || "?" });
    } catch (e) {
      failures.push({ path: r.storage_path, reason: e instanceof Error ? e.message : "threw" });
    }
  }

  return NextResponse.json({
    ok: true,
    version: WATERMARK_VERSION,
    processed: rows.length,
    branded,
    remaining_before_this_batch: totalRemaining,
    remaining_after: Math.max(0, totalRemaining - branded),
    failures,
  });
}
