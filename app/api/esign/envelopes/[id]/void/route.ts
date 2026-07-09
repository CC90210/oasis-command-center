/**
 * /api/esign/envelopes/[id]/void — admin/creator-only. Marks the envelope
 * voided (terminal) with a required reason and logs the event. Voiding
 * does NOT invalidate already-signed signer rows retroactively (the audit
 * trail is append-only/immutable), it just prevents further signing —
 * the public /api/sign/[token] route rejects any token on a non-{sent,
 * viewed,partially_signed} envelope.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getEnvelopeById, updateEnvelopeStatus, logEvent } from "@/lib/esign/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });

  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });

  const envRes = await getEnvelopeById(sess.tenantId, id);
  if (!envRes.ok) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const envelope = envRes.envelope;

  // Creator-or-admin only.
  if (!sess.isAdmin && envelope.created_by !== sess.userId) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (envelope.status === "voided" || envelope.status === "completed") {
    return NextResponse.json({ ok: false, error: `envelope_already_${envelope.status}` }, { status: 409 });
  }

  let reason = "";
  try {
    const body = await req.json();
    reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  } catch {
    /* body optional-ish, but require a reason below */
  }
  if (!reason) return NextResponse.json({ ok: false, error: "reason_required" }, { status: 400 });

  const upd = await updateEnvelopeStatus(sess.tenantId, id, "voided", { void_reason: reason });
  if (!upd.ok) return NextResponse.json({ ok: false, error: "void_failed" }, { status: 500 });

  await logEvent({
    envelopeId: id,
    tenantId: sess.tenantId,
    event: "voided",
    actor: `operator:${sess.userId}`,
    meta: { reason },
  });

  return NextResponse.json({ ok: true });
}
