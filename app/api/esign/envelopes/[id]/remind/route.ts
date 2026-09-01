/**
 * /api/esign/envelopes/[id]/remind — resend the signing link to every
 * not-yet-signed signer. Same token-rotation model as .../send (a fresh
 * token is minted per reminder, invalidating any prior link for that
 * signer) so a reminder can't be used to "top up" a leaked old link.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getEnvelopeById, getPendingSigners, rotateSignerToken, logEvent } from "@/lib/esign/db";
import { mintSigningToken } from "@/lib/esign/tokens";
import { sendSigningLinkEmail } from "@/lib/esign/email";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNER_TOKEN_TTL_DAYS = 30;

function appBaseUrl(): string {
  return (process.env.PUBLIC_APP_URL || "https://oasisai.work").replace(/\/+$/, "");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });

  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  if (!(await canAccessSharedTenantResource(sess))) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const envRes = await getEnvelopeById(sess.tenantId, id);
  if (!envRes.ok) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const envelope = envRes.envelope;
  if (!["sent", "viewed", "partially_signed"].includes(envelope.status)) {
    return NextResponse.json({ ok: false, error: `cannot_remind_envelope_status_${envelope.status}` }, { status: 409 });
  }

  const signersRes = await getPendingSigners(sess.tenantId, id);
  if (!signersRes.ok) return NextResponse.json({ ok: false, error: "signer_lookup_failed" }, { status: 500 });
  if (signersRes.signers.length === 0) {
    return NextResponse.json({ ok: false, error: "no_pending_signers" }, { status: 400 });
  }

  const expiresAt = new Date(Date.now() + SIGNER_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const results = await Promise.all(
    signersRes.signers.map(async (signer) => {
      const token = mintSigningToken();
      const rotated = await rotateSignerToken(signer.id, token.sha256, expiresAt);
      if (!rotated.ok) return { signerId: signer.id, ok: false as const };

      const url = `${appBaseUrl()}/sign/${token.raw}`;
      const sendRes = await sendSigningLinkEmail({
        tenantId: sess.tenantId,
        to: signer.email,
        signerName: signer.name,
        envelopeTitle: envelope.title,
        url,
        message: envelope.message,
      });
      await logEvent({
        envelopeId: id,
        signerId: signer.id,
        tenantId: sess.tenantId,
        event: sendRes.ok ? "reminded" : "failed",
        actor: `operator:${sess.userId}`,
        meta: sendRes.ok ? {} : { reason: "remind_send_failed" },
      });
      return { signerId: signer.id, ok: sendRes.ok };
    }),
  );

  return NextResponse.json({ ok: results.some((r) => r.ok), results });
}
