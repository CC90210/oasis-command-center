/**
 * TEMPORARY watermark diagnostic — verifies the watermark pipeline in the REAL
 * Vercel runtime (2026-06-28). Downloads ONE known bank statement, runs the
 * watermarker, and reports the result + the @napi-rs/canvas interop probe so we
 * can confirm the DOMMatrix polyfill actually takes effect on Vercel.
 *
 * Secret-gated, hardcoded storage path (can't be pointed at arbitrary objects).
 * DELETE THIS ROUTE once the fix is confirmed.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { watermarkBankStatement } from "@/lib/forms/watermark";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TOKEN = "wmdiag-7f3a9c2e-2026-0628";
const TEST_PATH =
  "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110/8861162d-81c3-407d-9860-1806547d11f3/1782432907613_janyary_2026.pdf";

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // Interop probe — what does @napi-rs/canvas expose in THIS runtime?
  const canvasMod = await import("@napi-rs/canvas");
  const cm = (canvasMod as { default?: Record<string, unknown> }).default ?? {};
  const ns = canvasMod as unknown as Record<string, unknown>;
  const diag = {
    ns_DOMMatrix: typeof ns.DOMMatrix,
    default_DOMMatrix: typeof cm.DOMMatrix,
    ns_createCanvas: typeof ns.createCanvas,
    default_createCanvas: typeof cm.createCanvas,
    global_DOMMatrix_before: typeof (globalThis as Record<string, unknown>).DOMMatrix,
  };

  let result: Record<string, unknown>;
  try {
    const db = getServiceSupabase();
    const dl = await db.storage.from("lead-documents").download(TEST_PATH);
    if (dl.error || !dl.data) {
      result = { ok: false, error: `download_failed: ${dl.error?.message || "no_data"}` };
    } else {
      const bytes = Buffer.from(await dl.data.arrayBuffer());
      const wm = await watermarkBankStatement({
        bytes,
        mimeType: "application/pdf",
        provenance: { businessName: "Home Renovation Tampa Bay LLC", leadId: "8861162d", date: "2026-06-28" },
      });
      result = wm.ok
        ? { ok: true, pages: wm.pages, outBytes: wm.bytes.length, mimeType: wm.mimeType }
        : { ok: false, error: wm.error };
    }
  } catch (e) {
    result = { ok: false, error: "threw:" + (e instanceof Error ? e.message : String(e)) };
  }

  return NextResponse.json({ diag, result });
}
