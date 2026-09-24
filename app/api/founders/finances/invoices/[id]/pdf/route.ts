/** GET /api/founders/finances/invoices/[id]/pdf — the invoice PDF, same bytes that get emailed. */
import { NextResponse } from "next/server";
import { methodNotHere } from "@/lib/founders/method-guard";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { financeErrorResponse } from "@/lib/founders-finances/http";
import { invoicePdfBytes } from "@/lib/founders-finances/invoices-io";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const viewer = await resolveFinanceViewer().catch(() => null);
  if (!viewer) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const { id } = await ctx.params;
  try {
    const { bytes, filename } = await invoicePdfBytes(viewer, id);
    return new NextResponse(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return financeErrorResponse(e, "invoice:pdf");
  }
}

export const POST = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
