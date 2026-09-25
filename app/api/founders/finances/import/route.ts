/**
 * POST /api/founders/finances/import — statement upload (multipart).
 * Fields: file, entity, account_id, currency, date_order?, mode=preview|commit.
 * Preview shows what would be added; commit re-parses the file server-side and
 * inserts with dedupe (re-importing the same file adds nothing).
 */
import { NextResponse } from "next/server";
import { methodNotHere } from "@/lib/founders/method-guard";
import { resolveFinanceViewer } from "@/lib/founders-finances/access-io";
import { financeErrorResponse } from "@/lib/founders-finances/http";
import { commitImport, previewImport } from "@/lib/founders-finances/transactions-io";
import { MAX_IMPORT_BYTES, type DateOrder } from "@/lib/founders-finances/import-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "invalid_input", message: "attach a statement file" }, { status: 400 });
  if (file.size > MAX_IMPORT_BYTES) return NextResponse.json({ ok: false, error: "invalid_input", message: "file is larger than 5 MB" }, { status: 413 });
  const text = await file.text();
  const dateOrderRaw = String(form.get("date_order") || "");
  const args = {
    accountId: String(form.get("account_id") || ""),
    filename: file.name || "statement",
    text,
    currency: String(form.get("currency") || "CAD"),
    dateOrder: (["mdy", "dmy", "ymd"].includes(dateOrderRaw) ? dateOrderRaw : undefined) as DateOrder | undefined,
  };
  const entity = String(form.get("entity") || "");
  try {
    if (String(form.get("mode")) === "commit") {
      return NextResponse.json({ ok: true, result: await commitImport(viewer, entity, args) });
    }
    return NextResponse.json({ ok: true, preview: await previewImport(viewer, entity, args) });
  } catch (e) {
    return financeErrorResponse(e, "import");
  }
}

export const GET = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
