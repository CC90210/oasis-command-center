/**
 * lib/esign/resolve-signing-session.ts — shared token→session resolver used
 * by BOTH the SSR page (app/sign/[token]/page.tsx, so the first paint has
 * the source PDF without a self-fetch round trip — mirrors the /f/ public-
 * form page's loadAndVerify() pattern) and the public GET /api/sign/[token]
 * route (kept as a real endpoint the signing page's client JS can re-hit,
 * e.g. after a decline/back action, without a full page reload).
 *
 * Fail-closed + no-enumeration by construction: returns a single
 * `{ ok: false }` for every unusable-token reason (not found / expired /
 * already signed or declined / envelope closed) — callers must not add
 * per-reason branching on top of this.
 */

import "server-only";
import { hashIncomingToken } from "./tokens";
import { getSignerByTokenHash, markSignerViewed, updateEnvelopeStatus, logEvent, type EsignSignerRow, type EsignEnvelopeRow } from "./db";
import { downloadEsignPdf } from "./storage";

export type SigningSession = {
  envelope: { id: string; title: string; message: string | null };
  signer: { id: string; name: string; email: string };
  consentDisclosureVersion: string;
  sourcePdfBase64: string;
};

function isUsable(signer: EsignSignerRow, envelope: EsignEnvelopeRow): boolean {
  if (signer.status === "signed" || signer.status === "declined") return false;
  if (new Date(signer.expires_at).getTime() < Date.now()) return false;
  if (!["sent", "viewed", "partially_signed"].includes(envelope.status)) return false;
  return true;
}

/**
 * Resolve a raw token to a usable signing session, recording the 'viewed'
 * side effects (signer.status -> viewed, envelope sent -> viewed, an
 * append-only esign_events row) exactly once per call. Callers that only
 * need a read-only check without side effects should NOT exist — every
 * consumer of this token IS a real page/API view, so the side effects are
 * always correct to apply.
 */
export async function resolveSigningSession(
  rawToken: string,
  ctx: { ip: string; userAgent: string },
): Promise<{ ok: true; session: SigningSession } | { ok: false }> {
  const tokenHash = hashIncomingToken(rawToken);
  const lookup = await getSignerByTokenHash(tokenHash);
  if (!lookup.ok) return { ok: false };
  const { signer, envelope } = lookup;
  if (!isUsable(signer, envelope)) return { ok: false };

  const source = await downloadEsignPdf(envelope.source_storage_key);
  if (!source.ok) return { ok: false };

  if (signer.status === "pending") {
    await markSignerViewed(signer.id);
  }
  if (envelope.status === "sent") {
    await updateEnvelopeStatus(envelope.tenant_id, envelope.id, "viewed");
  }
  await logEvent({
    envelopeId: envelope.id,
    signerId: signer.id,
    tenantId: envelope.tenant_id,
    event: "viewed",
    actor: `signer:${signer.id}`,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return {
    ok: true,
    session: {
      envelope: { id: envelope.id, title: envelope.title, message: envelope.message },
      signer: { id: signer.id, name: signer.name, email: signer.email },
      consentDisclosureVersion: envelope.consent_disclosure_version,
      sourcePdfBase64: source.bytes.toString("base64"),
    },
  };
}
