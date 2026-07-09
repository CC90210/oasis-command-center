/**
 * lib/esign/db.ts — envelope/signer/field/event CRUD.
 *
 * ALL access goes through getServiceSupabase() (lib/supabase-server.ts:20)
 * — esign_* tables have RLS FORCED with no policies (database/112_esign.sql),
 * so the anon/authenticated Supabase roles can never touch them directly.
 * Every function that takes a tenantId scopes its query by it; the two
 * public-token lookups (getSignerByTokenHash, getEnvelopeForSigner) are the
 * only exceptions — there the sha256(token) match on a UNIQUE index IS the
 * auth boundary (mirrors lib/forms/public-resolver.ts's model), and callers
 * (app/api/sign/[token]) re-derive tenant_id from the returned row rather
 * than trusting anything client-supplied.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";

export type EnvelopeStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "partially_signed"
  | "completed"
  | "voided"
  | "declined"
  | "expired";

export type SignerStatus = "pending" | "viewed" | "signed" | "declined";

export type EsignEnvelopeRow = {
  id: string;
  tenant_id: string;
  created_by: string;
  title: string;
  status: EnvelopeStatus;
  source_storage_key: string;
  source_document_id: string | null;
  source_pdf_sha256: string;
  signed_storage_key: string | null;
  signed_document_id: string | null;
  signed_pdf_sha256: string | null;
  lead_id: string | null;
  application_id: string | null;
  consent_disclosure_version: string;
  message: string | null;
  expires_at: string | null;
  completed_at: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type EsignSignerRow = {
  id: string;
  envelope_id: string;
  tenant_id: string;
  email: string;
  name: string;
  sign_order: number;
  status: SignerStatus;
  token_sha256: string;
  expires_at: string;
  viewed_at: string | null;
  signed_at: string | null;
  signed_ip: string | null;
  signed_user_agent: string | null;
  consented: boolean;
  decline_reason: string | null;
  created_at: string;
};

export type EsignEventRow = {
  id: string;
  envelope_id: string;
  signer_id: string | null;
  tenant_id: string;
  event: string;
  actor: string | null;
  at: string;
  ip: string | null;
  user_agent: string | null;
  meta: Record<string, unknown>;
};

const ENVELOPE_COLS =
  "id, tenant_id, created_by, title, status, source_storage_key, source_document_id, source_pdf_sha256, signed_storage_key, signed_document_id, signed_pdf_sha256, lead_id, application_id, consent_disclosure_version, message, expires_at, completed_at, void_reason, created_at, updated_at";
const SIGNER_COLS =
  "id, envelope_id, tenant_id, email, name, sign_order, status, token_sha256, expires_at, viewed_at, signed_at, signed_ip, signed_user_agent, consented, decline_reason, created_at";
const EVENT_COLS = "id, envelope_id, signer_id, tenant_id, event, actor, at, ip, user_agent, meta";

/** Append-only. The app NEVER issues an UPDATE/DELETE against esign_events —
 *  this is the sole write path, and it is always an INSERT. */
export async function logEvent(input: {
  envelopeId: string;
  signerId?: string | null;
  tenantId: string;
  event: string;
  actor?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const ins = await db.from("esign_events").insert({
    envelope_id: input.envelopeId,
    signer_id: input.signerId ?? null,
    tenant_id: input.tenantId,
    event: input.event,
    actor: input.actor ?? null,
    ip: input.ip ?? null,
    user_agent: input.userAgent ?? null,
    meta: input.meta ?? {},
  });
  if (ins.error) return { ok: false, error: ins.error.message };
  return { ok: true };
}

export async function createEnvelope(input: {
  id: string;
  tenantId: string;
  createdBy: string;
  title: string;
  sourceStorageKey: string;
  sourceDocumentId?: string | null;
  sourcePdfSha256: string;
  leadId?: string | null;
  applicationId?: string | null;
  consentDisclosureVersion?: string;
  message?: string | null;
  expiresAt?: string | null;
}): Promise<{ ok: true; envelope: EsignEnvelopeRow } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const ins = await db
    .from("esign_envelopes")
    .insert({
      id: input.id,
      tenant_id: input.tenantId,
      created_by: input.createdBy,
      title: input.title,
      status: "draft",
      source_storage_key: input.sourceStorageKey,
      source_document_id: input.sourceDocumentId ?? null,
      source_pdf_sha256: input.sourcePdfSha256,
      lead_id: input.leadId ?? null,
      application_id: input.applicationId ?? null,
      consent_disclosure_version: input.consentDisclosureVersion || "v1",
      message: input.message ?? null,
      expires_at: input.expiresAt ?? null,
    })
    .select(ENVELOPE_COLS)
    .single();
  if (ins.error) return { ok: false, error: ins.error.message };
  return { ok: true, envelope: ins.data as EsignEnvelopeRow };
}

export async function createSigners(
  envelopeId: string,
  tenantId: string,
  signers: Array<{ email: string; name: string; signOrder: number; tokenSha256: string; expiresAt: string }>,
): Promise<{ ok: true; signers: EsignSignerRow[] } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const ins = await db
    .from("esign_signers")
    .insert(
      signers.map((s) => ({
        envelope_id: envelopeId,
        tenant_id: tenantId,
        email: s.email,
        name: s.name,
        sign_order: s.signOrder,
        status: "pending",
        token_sha256: s.tokenSha256,
        expires_at: s.expiresAt,
      })),
    )
    .select(SIGNER_COLS);
  if (ins.error) return { ok: false, error: ins.error.message };
  return { ok: true, signers: ins.data as EsignSignerRow[] };
}

export async function listEnvelopes(
  tenantId: string,
): Promise<{ ok: true; envelopes: Array<EsignEnvelopeRow & { signers: EsignSignerRow[] }> } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const res = await db
    .from("esign_envelopes")
    .select(`${ENVELOPE_COLS}, esign_signers(${SIGNER_COLS})`)
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (res.error) return { ok: false, error: res.error.message };
  const rows = (res.data || []) as Array<EsignEnvelopeRow & { esign_signers: EsignSignerRow[] }>;
  return {
    ok: true,
    envelopes: rows.map((r) => ({ ...r, signers: r.esign_signers || [] })),
  };
}

export async function getEnvelopeDetail(
  tenantId: string,
  envelopeId: string,
): Promise<
  | { ok: true; envelope: EsignEnvelopeRow; signers: EsignSignerRow[]; events: EsignEventRow[] }
  | { ok: false; error: string }
> {
  const db = getServiceSupabase();
  const envRes = await db
    .from("esign_envelopes")
    .select(ENVELOPE_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", envelopeId)
    .maybeSingle();
  if (envRes.error) return { ok: false, error: envRes.error.message };
  if (!envRes.data) return { ok: false, error: "not_found" };

  const [signersRes, eventsRes] = await Promise.all([
    db.from("esign_signers").select(SIGNER_COLS).eq("tenant_id", tenantId).eq("envelope_id", envelopeId).order("sign_order"),
    db.from("esign_events").select(EVENT_COLS).eq("tenant_id", tenantId).eq("envelope_id", envelopeId).order("at", { ascending: true }),
  ]);
  if (signersRes.error) return { ok: false, error: signersRes.error.message };
  if (eventsRes.error) return { ok: false, error: eventsRes.error.message };

  return {
    ok: true,
    envelope: envRes.data as EsignEnvelopeRow,
    signers: (signersRes.data || []) as EsignSignerRow[],
    events: (eventsRes.data || []) as EsignEventRow[],
  };
}

export async function updateEnvelopeStatus(
  tenantId: string,
  envelopeId: string,
  status: EnvelopeStatus,
  extra?: Record<string, unknown>,
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  let q = db
    .from("esign_envelopes")
    .update({ status, updated_at: new Date().toISOString(), ...(extra || {}) })
    .eq("tenant_id", tenantId)
    .eq("id", envelopeId);
  // Idempotent completion: only the FIRST write that flips the envelope to
  // 'completed' returns a row — a concurrent/duplicate completion (e.g. the
  // last two signers racing) finds status already 'completed' → 0 rows, so
  // the caller can guard the one-time side effects (signed-PDF assembly,
  // creator notification) on `changed`.
  if (status === "completed") q = q.not("status", "eq", "completed");
  const upd = await q.select("id");
  if (upd.error) return { ok: false, error: upd.error.message };
  return { ok: true, changed: (upd.data?.length ?? 0) > 0 };
}

export async function getEnvelopeById(
  tenantId: string,
  envelopeId: string,
): Promise<{ ok: true; envelope: EsignEnvelopeRow } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const res = await db.from("esign_envelopes").select(ENVELOPE_COLS).eq("tenant_id", tenantId).eq("id", envelopeId).maybeSingle();
  if (res.error) return { ok: false, error: res.error.message };
  if (!res.data) return { ok: false, error: "not_found" };
  return { ok: true, envelope: res.data as EsignEnvelopeRow };
}

export async function getPendingSigners(
  tenantId: string,
  envelopeId: string,
): Promise<{ ok: true; signers: EsignSignerRow[] } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const res = await db
    .from("esign_signers")
    .select(SIGNER_COLS)
    .eq("tenant_id", tenantId)
    .eq("envelope_id", envelopeId)
    .in("status", ["pending", "viewed"]);
  if (res.error) return { ok: false, error: res.error.message };
  return { ok: true, signers: (res.data || []) as EsignSignerRow[] };
}

export async function getAllSignersForEnvelope(
  envelopeId: string,
): Promise<{ ok: true; signers: EsignSignerRow[] } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const res = await db.from("esign_signers").select(SIGNER_COLS).eq("envelope_id", envelopeId).order("sign_order");
  if (res.error) return { ok: false, error: res.error.message };
  return { ok: true, signers: (res.data || []) as EsignSignerRow[] };
}

// ── Public-token surface (app/api/sign/[token]) — the sha256(token) match
// on the UNIQUE token_sha256 index IS the auth boundary. No tenantId filter
// here by design; callers treat the returned row's tenant_id as authoritative.
export async function getSignerByTokenHash(
  tokenSha256: string,
): Promise<{ ok: true; signer: EsignSignerRow; envelope: EsignEnvelopeRow } | { ok: false }> {
  const db = getServiceSupabase();
  const signerRes = await db.from("esign_signers").select(SIGNER_COLS).eq("token_sha256", tokenSha256).maybeSingle();
  if (signerRes.error || !signerRes.data) return { ok: false };
  const signer = signerRes.data as EsignSignerRow;
  const envRes = await db.from("esign_envelopes").select(ENVELOPE_COLS).eq("id", signer.envelope_id).maybeSingle();
  if (envRes.error || !envRes.data) return { ok: false };
  return { ok: true, signer, envelope: envRes.data as EsignEnvelopeRow };
}

/**
 * Rotate a signer's token at send/remind time. Tokens are minted fresh
 * every send (never reused from `createSigners`' insert-time placeholder,
 * and never reused across a "remind") so a leaked or stale link stops
 * working the moment a new one is issued — the raw value only ever exists
 * transiently in the send route's memory and the outbound email body,
 * never in a DB row or a response payload (see lib/esign/tokens.ts).
 */
export async function rotateSignerToken(
  signerId: string,
  tokenSha256: string,
  expiresAt: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const upd = await db.from("esign_signers").update({ token_sha256: tokenSha256, expires_at: expiresAt }).eq("id", signerId);
  if (upd.error) return { ok: false, error: upd.error.message };
  return { ok: true };
}

export async function markSignerViewed(signerId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const upd = await db
    .from("esign_signers")
    .update({ status: "viewed", viewed_at: new Date().toISOString() })
    .eq("id", signerId)
    .eq("status", "pending"); // don't regress a later status (signed/declined) back to viewed
  if (upd.error) return { ok: false, error: upd.error.message };
  return { ok: true };
}

export async function markSignerSigned(
  signerId: string,
  input: { ip: string; userAgent: string; consented: boolean },
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  // CAS: only transition to 'signed' from a still-signable state. A second
  // concurrent/replayed POST for the same token finds status already 'signed'
  // (or 'declined') → 0 rows → `changed:false`, so the route short-circuits
  // before duplicating the signature field, PDF assembly, or completion email.
  const upd = await db
    .from("esign_signers")
    .update({
      status: "signed",
      signed_at: new Date().toISOString(),
      signed_ip: input.ip,
      signed_user_agent: input.userAgent,
      consented: input.consented,
    })
    .eq("id", signerId)
    .in("status", ["sent", "viewed", "pending"])
    .select("id");
  if (upd.error) return { ok: false, error: upd.error.message };
  return { ok: true, changed: (upd.data?.length ?? 0) > 0 };
}

/**
 * Persist a signer's captured signature (drawn PNG data URI in `value`, or
 * a typed-name fallback in `placeholder`) into esign_fields. The fixed
 * schema (database/112_esign.sql) has no dedicated signature-image column
 * on esign_signers, so this is what esign_fields' `value`/`placeholder`
 * columns are for in the MVP — one row per signer, type="signature" —
 * rather than the full drag-drop field-placement UI the table also backs.
 * Needed so the LAST signer's completion can assemble a certificate page
 * per EVERY signer, not just the one submitting the final request.
 */
export async function saveSignatureField(input: {
  envelopeId: string;
  signerId: string;
  tenantId: string;
  signatureDataUri?: string | null;
  typedName?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const ins = await db.from("esign_fields").insert({
    envelope_id: input.envelopeId,
    signer_id: input.signerId,
    tenant_id: input.tenantId,
    type: "signature",
    page: 1,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    required: true,
    value: input.signatureDataUri || null,
    placeholder: input.typedName || null,
  });
  if (ins.error) return { ok: false, error: ins.error.message };
  return { ok: true };
}

/** signerId -> captured signature (image data URI and/or typed name). */
export async function getSignatureFieldsForEnvelope(
  envelopeId: string,
): Promise<{ ok: true; bySignerId: Map<string, { signatureDataUri: string | null; typedName: string | null }> } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const res = await db
    .from("esign_fields")
    .select("signer_id, value, placeholder")
    .eq("envelope_id", envelopeId)
    .eq("type", "signature");
  if (res.error) return { ok: false, error: res.error.message };
  const bySignerId = new Map<string, { signatureDataUri: string | null; typedName: string | null }>();
  for (const row of (res.data || []) as Array<{ signer_id: string; value: string | null; placeholder: string | null }>) {
    bySignerId.set(row.signer_id, { signatureDataUri: row.value, typedName: row.placeholder });
  }
  return { ok: true, bySignerId };
}

export async function markSignerDeclined(
  signerId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getServiceSupabase();
  const upd = await db.from("esign_signers").update({ status: "declined", decline_reason: reason.slice(0, 500) }).eq("id", signerId);
  if (upd.error) return { ok: false, error: upd.error.message };
  return { ok: true };
}
