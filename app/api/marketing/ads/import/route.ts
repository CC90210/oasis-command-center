import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isPlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { importMetaDelivery } from "@/lib/marketing/meta-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers });
  if (!(await isPlatformOperatorForAuthUser(sess.userId, sess.email))) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403, headers });
  // No tenant, account or credential may be supplied by the browser.
  if (req.nextUrl.search || (req.headers.get("origin") && req.headers.get("origin") !== req.nextUrl.origin)) return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400, headers });
  const body = await req.text();
  if (body.trim() && body.trim() !== "{}") return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400, headers });
  const result = await importMetaDelivery(sess.tenantId);
  return NextResponse.json(result, { status: result.ok ? 200 : ["not_configured", "no_linked_ads", "mapping_conflict", "report_context_conflict"].includes(result.error) ? 409 : 502, headers });
}
