/**
 * lib/ai-audit/follow-up-payload.ts — what CC's approval of a follow-up email
 * (approval kind "follow_up_ai_audit", phase 5) binds to.
 *
 * When a delivered audit stalls (not opened in 3 days, or opened but unpaid
 * for 7: lib/ai-audit/rules.ts stallReason), the tick drafts one short
 * follow-up and files it here for CC's one tap. Nothing is sent without it.
 * The email carries the client's private link again; the link is never
 * stored, so the body holds {{audit_link}} and the executor
 * (lib/ai-audit/follow-up.ts) re-derives the same link at send time.
 *
 * PURE: lib/os/approvals/rules.ts validates payloads with it, and that module
 * is shared with the browser.
 */
export const FOLLOW_UP_AI_AUDIT_KIND = "follow_up_ai_audit" as const;
export const FOLLOW_UP_REASONS = ["not_opened", "not_paid"] as const;
export type FollowUpReason = (typeof FOLLOW_UP_REASONS)[number];
export const FOLLOW_UP_LINK_PLACEHOLDER = "{{audit_link}}";

export type FollowUpAiAuditPayload = {
  engagement_id: string;
  lead_id: string;
  business_name: string;
  share_link_id: string;
  reason: FollowUpReason;
  to: string;
  subject: string;
  body: string;
};

type Valid<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export function validateFollowUpAiAuditPayload(raw: unknown): Valid<FollowUpAiAuditPayload> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "payload_invalid" };
  const r = raw as Record<string, unknown>;
  for (const k of ["engagement_id", "lead_id", "share_link_id"] as const) {
    if (typeof r[k] !== "string" || !ID_RE.test(r[k] as string)) return { ok: false, error: `${k}_invalid`, field: k };
  }
  if (!(FOLLOW_UP_REASONS as readonly unknown[]).includes(r.reason)) return { ok: false, error: "reason_invalid", field: "reason" };
  const to = typeof r.to === "string" ? r.to.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(to) || to.length > 254) return { ok: false, error: "to_invalid", field: "to" };
  const subject = typeof r.subject === "string" ? r.subject.trim() : "";
  if (!subject || subject.length > 200 || /[\r\n]/.test(subject)) return { ok: false, error: "subject_invalid", field: "subject" };
  const body = typeof r.body === "string" ? r.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body || body.length > 5_000) return { ok: false, error: "body_invalid", field: "body" };
  if (body.split(FOLLOW_UP_LINK_PLACEHOLDER).length !== 2) return { ok: false, error: "body_needs_one_link", field: "body" };
  const name = typeof r.business_name === "string" ? r.business_name.trim() : "";
  if (!name || name.length > 200) return { ok: false, error: "business_name_invalid", field: "business_name" };
  return {
    ok: true,
    value: {
      engagement_id: r.engagement_id as string,
      lead_id: r.lead_id as string,
      business_name: name,
      share_link_id: r.share_link_id as string,
      reason: r.reason as FollowUpReason,
      to,
      subject,
      body,
    },
  };
}

/** The card's one line before anyone opens it. */
export function followUpAiAuditPreview(payload: Record<string, unknown>): string {
  const v = validateFollowUpAiAuditPayload(payload);
  if (!v.ok) return "";
  const why = v.value.reason === "not_opened" ? "has not opened the audit" : "opened the audit but has not paid";
  return `A follow-up to ${v.value.to} for ${v.value.business_name}, who ${why}. It resends the same private link; nothing goes out until you approve.`;
}
