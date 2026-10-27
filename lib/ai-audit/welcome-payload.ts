/**
 * lib/ai-audit/welcome-payload.ts — what CC's approval of a paying client's
 * welcome email (approval kind "welcome_ai_audit") binds to.
 *
 * Once Stripe confirms an audit's payment, onboarding (lib/ai-audit/onboarding.ts)
 * writes the welcome email: the client's own signed link to the onboarding form
 * and the kickoff booking link. It goes out only on CC's one tap, and under the
 * audit's own switch (LIVE_SEND_AI_AUDIT), as the audit and its follow-ups do.
 * The executor is lib/ai-audit/welcome.ts.
 *
 * PURE: lib/os/approvals/rules.ts validates payloads with it, and that module
 * is shared with the browser.
 */
import { EMAIL_RE } from "@/lib/ai-audit/delivery-payload";

export const WELCOME_AI_AUDIT_KIND = "welcome_ai_audit" as const;

export type WelcomeAiAuditPayload = {
  engagement_id: string;
  lead_id: string;
  business_name: string;
  to: string;
  subject: string;
  body: string;
};

type Valid<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function validateWelcomeAiAuditPayload(raw: unknown): Valid<WelcomeAiAuditPayload> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "payload_invalid" };
  const r = raw as Record<string, unknown>;
  for (const k of ["engagement_id", "lead_id"] as const) {
    if (typeof r[k] !== "string" || !ID_RE.test(r[k] as string)) return { ok: false, error: `${k}_invalid`, field: k };
  }
  const to = typeof r.to === "string" ? r.to.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(to) || to.length > 254) return { ok: false, error: "to_invalid", field: "to" };
  const subject = typeof r.subject === "string" ? r.subject.trim() : "";
  if (!subject || subject.length > 200 || /[\r\n]/.test(subject)) return { ok: false, error: "subject_invalid", field: "subject" };
  const body = typeof r.body === "string" ? r.body.replace(/\r\n/g, "\n").trim() : "";
  if (!body || body.length > 5_000) return { ok: false, error: "body_invalid", field: "body" };
  const name = typeof r.business_name === "string" ? r.business_name.trim() : "";
  if (!name || name.length > 200) return { ok: false, error: "business_name_invalid", field: "business_name" };
  return {
    ok: true,
    value: { engagement_id: r.engagement_id as string, lead_id: r.lead_id as string, business_name: name, to, subject, body },
  };
}

/** The card's one line before anyone opens it. */
export function welcomeAiAuditPreview(payload: Record<string, unknown>): string {
  const v = validateWelcomeAiAuditPayload(payload);
  if (!v.ok) return "";
  return `The welcome email to ${v.value.to} for ${v.value.business_name}, who has paid: their onboarding form and a kickoff booking link. Nothing goes out until you approve.`;
}
