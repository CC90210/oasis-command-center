/**
 * Receipts.
 *   POST (multipart: file, owner_type=bill|transaction, owner_id) — store in
 *        the private 'finance-receipts' bucket (R2 via getServiceSupabase()).
 *   GET ?id=<attachment id> — 302 to a 5-minute signed URL.
 * Both gated by the finance viewer AND the owning row's entity.
 */
import { NextResponse } from "next/server";
import { methodNotHere } from "@/lib/founders/method-guard";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { financeErrorResponse } from "@/lib/founders-finances/http";
import { attachReceipt, MAX_RECEIPT_BYTES, receiptUrl } from "@/lib/founders-finances/bills-io";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const viewer = await resolveFinanceViewer().catch(() => null);
  if (!viewer) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_form" }, { status: 400 });
  }
  const file = form.get("file");
  const ownerType = String(form.get("owner_type") || "");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "invalid_input", message: "attach a file" }, { status: 400 });
  if (ownerType !== "bill" && ownerType !== "transaction") return NextResponse.json({ ok: false, error: "invalid_input", message: "owner_type must be bill or transaction" }, { status: 400 });
  if (file.size > MAX_RECEIPT_BYTES) return NextResponse.json({ ok: false, error: "invalid_input", message: "receipt must be 10 MB or smaller" }, { status: 413 });
  try {
    const id = await attachReceipt(viewer, {
      ownerType,
      ownerId: String(form.get("owner_id") || ""),
      filename: file.name || "receipt",
      contentType: file.type || "application/octet-stream",
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    return financeErrorResponse(e, "attachments:upload");
  }
}

export async function GET(req: Request) {
  const viewer = await resolveFinanceViewer().catch(() => null);
  if (!viewer) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const id = new URL(req.url).searchParams.get("id") || "";
  try {
    return NextResponse.redirect(await receiptUrl(viewer, id), 302);
  } catch (e) {
    return financeErrorResponse(e, "attachments:read");
  }
}

export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
