/**
 * /api/esign/envelopes/[id] — envelope detail (signers + audit events) for
 * the console's detail drawer. Session-authed, tenant-scoped.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getEnvelopeDetail } from "@/lib/esign/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });

  const res = await getEnvelopeDetail(sess.tenantId, id);
  if (!res.ok) {
    const status = res.error === "not_found" ? 404 : 500;
    return NextResponse.json({ ok: false, error: res.error }, { status });
  }
  return NextResponse.json({ ok: true, envelope: res.envelope, signers: res.signers, events: res.events });
}
