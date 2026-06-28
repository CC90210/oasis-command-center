/**
 * TEMPORARY watermark diagnostic — verifies the watermark pipeline in the REAL
 * Vercel runtime (2026-06-28). Downloads ONE known bank statement, watermarks
 * it, and either returns the watermarked PDF (?pdf=1, to render-verify the logo
 * + font actually show on Vercel) or a JSON summary.
 *
 * Secret-gated, hardcoded storage path. DELETE THIS ROUTE once confirmed.
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
  const canvasMod = await import("@napi-rs/canvas");
  const cm = (canvasMod as { default?: Record<string, unknown> }).default ?? {};
  const ns = canvasMod as unknown as Record<string, unknown>;
  const GlobalFonts = (ns.GlobalFonts ?? cm.GlobalFonts) as { families?: unknown[] } | undefined;
  const diag = {
    fontFamiliesBefore: Array.isArray(GlobalFonts?.families) ? GlobalFonts!.families!.length : "n/a",
    hasLoadImage: typeof (ns.loadImage ?? cm.loadImage),
  };

  try {
    const db = getServiceSupabase();
    const dl = await db.storage.from("lead-documents").download(TEST_PATH);
    if (dl.error || !dl.data) {
      return NextResponse.json({ diag, result: { ok: false, error: `download_failed: ${dl.error?.message}` } });
    }
    const bytes = Buffer.from(await dl.data.arrayBuffer());
    const wm = await watermarkBankStatement({
      bytes,
      mimeType: "application/pdf",
      provenance: { businessName: "Home Renovation Tampa Bay LLC", leadId: "8861162d", date: "2026-06-28" },
    });
    if (wm.ok && req.nextUrl.searchParams.get("pdf") === "1") {
      return new NextResponse(new Uint8Array(wm.bytes), {
        status: 200,
        headers: { "content-type": "application/pdf", "cache-control": "no-store" },
      });
    }
    return NextResponse.json({
      diag,
      result: wm.ok ? { ok: true, pages: wm.pages, outBytes: wm.bytes.length } : { ok: false, error: wm.error },
    });
  } catch (e) {
    return NextResponse.json({ diag, result: { ok: false, error: "threw:" + (e instanceof Error ? e.message : String(e)) } });
  }
}
