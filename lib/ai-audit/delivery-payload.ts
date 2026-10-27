/**
 * lib/ai-audit/delivery-payload.ts — what CC's final approval (Gate 2,
 * approval kind "deliver_ai_audit") binds to.
 *
 * The approval card hashes this payload (lib/os/approvals/rules.ts
 * canonicalJson + payload_hash). It names the exact audit version, proposal
 * version and PDF by their content hashes, and the exact email, so a "yes" is
 * to these bytes and nothing else. The executor (delivery.ts) re-reads every
 * one of them and refuses if any changed.
 *
 * PURE: lib/os/approvals/rules.ts validates payloads with it, and that module
 * is shared with the browser.
 */
/** The audit email's own live switch (LIVE_SEND_AI_AUDIT, lib/integrations/send-mode.ts). */
export const AUDIT_EMAIL_CHANNEL = "ai_audit_delivery";

export const DELIVER_AI_AUDIT_KIND = "deliver_ai_audit" as const;

export type DeliverAiAuditPayload = {
  engagement_id: string;
  lead_id: string;
  business_name: string;
  audit_version_id: string;
  audit_sha256: string;
  proposal_version_id: string;
  proposal_sha256: string;
  pdf_sha256: string;
  to: string;
  subject: string;
  body: string;
  currency: "CAD" | "USD";
  total_cents: number;
  due_now_cents: number;
};

type Valid<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
/** An email address as an approval or a proposal may carry it. Shared with the follow-up's payload and the proposal. */
export const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export function validateDeliverAiAuditPayload(raw: unknown): Valid<DeliverAiAuditPayload> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "payload_invalid" };
  const r = raw as Record<string, unknown>;
  for (const k of ["engagement_id", "lead_id", "audit_version_id", "proposal_version_id"] as const) {
    if (typeof r[k] !== "string" || !ID_RE.test(r[k] as string)) return { ok: false, error: `${k}_invalid`, field: k };
  }
  for (const k of ["audit_sha256", "proposal_sha256", "pdf_sha256"] as const) {
    if (typeof r[k] !== "string" || !SHA_RE.test(r[k] as string)) return { ok: false, error: `${k}_invalid`, field: k };
  }
  const to = typeof r.to === "string" ? r.to.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(to) || to.length > 254) return { ok: false, error: "to_invalid", field: "to" };
  const subject = typeof r.subject === "string" ? r.subject.trim() : "";
  if (!subject || subject.length > 200 || /[\r\n]/.test(subject)) return { ok: false, error: "subject_invalid", field: "subject" };
  const body = typeof r.body === "string" ? r.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body || body.length > 10_000) return { ok: false, error: "body_invalid", field: "body" };
  if (body.split("{{audit_link}}").length !== 2) return { ok: false, error: "body_needs_one_link", field: "body" };
  const name = typeof r.business_name === "string" ? r.business_name.trim() : "";
  if (!name || name.length > 200) return { ok: false, error: "business_name_invalid", field: "business_name" };
  if (r.currency !== "CAD" && r.currency !== "USD") return { ok: false, error: "currency_invalid", field: "currency" };
  for (const k of ["total_cents", "due_now_cents"] as const) {
    const n = r[k];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) return { ok: false, error: `${k}_invalid`, field: k };
  }
  return {
    ok: true,
    value: {
      engagement_id: r.engagement_id as string,
      lead_id: r.lead_id as string,
      business_name: name,
      audit_version_id: r.audit_version_id as string,
      audit_sha256: r.audit_sha256 as string,
      proposal_version_id: r.proposal_version_id as string,
      proposal_sha256: r.proposal_sha256 as string,
      pdf_sha256: r.pdf_sha256 as string,
      to,
      subject,
      body,
      currency: r.currency,
      total_cents: r.total_cents as number,
      due_now_cents: r.due_now_cents as number,
    },
  };
}

function money(cents: number, currency: "CAD" | "USD"): string {
  return new Intl.NumberFormat(currency === "USD" ? "en-US" : "en-CA", { style: "currency", currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

/** The card's one-line preview. */
export function deliverAiAuditPreview(payload: Record<string, unknown>): string {
  const name = typeof payload.business_name === "string" ? payload.business_name : "the client";
  const to = typeof payload.to === "string" ? payload.to : "";
  const cur = payload.currency === "USD" ? "USD" : "CAD";
  const total = typeof payload.total_cents === "number" ? money(payload.total_cents, cur) : "";
  const due = typeof payload.due_now_cents === "number" ? money(payload.due_now_cents, cur) : "";
  return `Send ${name} their Free AI Audit, PDF and proposal (${total}${due && due !== total ? `, ${due} due now` : ""}) to ${to}.`;
}
