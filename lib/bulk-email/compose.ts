/**
 * lib/bulk-email/compose.ts — the operator-authored ("write your own") bulk
 * message: validation + per-recipient rendering.
 *
 * Until now the bulk path could only send a template from
 * lib/sunbiz-templates-library.ts. An operator who wanted to say something the
 * library doesn't cover had no batch option at all, so they either sent nothing
 * or opened leads one at a time (Adon, 2026-08-20).
 *
 * PURE by design (no `server-only`, no DB) so the same functions run in the
 * composer's live preview AND on the server before queueing. The preview an
 * operator approves is therefore rendered by the identical code that renders
 * the message a merchant receives — a preview that can drift from the send is
 * worse than no preview, because it manufactures false confidence.
 *
 * NOT a safety boundary. Lender-name + direct-funder positioning enforcement
 * lives in lib/integrations/blast-safety.ts (DB-backed, fail-closed) and is
 * applied by the route BEFORE anything is queued. This module only rejects
 * malformed copy that would reach a merchant looking broken.
 */

/**
 * The merge tokens an operator may use. Anything else inside {{...}} is a typo
 * that would otherwise be delivered LITERALLY ("Hi {{name}},") to a real
 * merchant, so an unknown token is a hard validation failure rather than a
 * silent pass-through.
 */
export const MERGE_FIELDS = [
  { token: "{{first_name}}", label: "First name", sample: "Dave" },
  { token: "{{business_name}}", label: "Business name", sample: "Dave's Auto Repair" },
] as const;

const ALLOWED_TOKENS = new Set(MERGE_FIELDS.map((f) => f.token));

/** Matches any {{ token }} with flexible inner whitespace. */
const TOKEN_RE = /\{\{\s*([a-z0-9_]*)\s*\}\}/gi;

export const MAX_SUBJECT = 200;
export const MAX_BODY = 10_000;
/** Below this a "body" is almost certainly an accidental send, not a message. */
export const MIN_BODY = 20;

export type CustomMessage = { subject: string; body: string };

export type CustomMessageProblem =
  | "subject_required"
  | "body_required"
  | "body_too_short"
  | "subject_too_long"
  | "body_too_long"
  | "unknown_merge_field";

export type ValidateResult =
  | { ok: true; value: CustomMessage }
  | { ok: false; problem: CustomMessageProblem; message: string; tokens?: string[] };

/** Normalize {{ First_Name }} → {{first_name}} so casing/spacing never decides
 *  whether a merchant sees their name or a raw token. */
function canonicalizeTokens(s: string): string {
  return s.replace(TOKEN_RE, (_m, name: string) => `{{${String(name).toLowerCase()}}}`);
}

/** Every {{...}} token in the text that isn't one we know how to substitute. */
export function unknownMergeFields(text: string): string[] {
  const out: string[] = [];
  for (const m of canonicalizeTokens(text || "").matchAll(TOKEN_RE)) {
    const token = `{{${String(m[1]).toLowerCase()}}}`;
    if (!ALLOWED_TOKENS.has(token as (typeof MERGE_FIELDS)[number]["token"]) && !out.includes(token)) {
      out.push(token);
    }
  }
  return out;
}

/**
 * Validate operator-authored subject + body. Returns the canonicalized message
 * on success so the caller stores exactly what the renderer will consume.
 */
export function validateCustomMessage(input: {
  subject?: unknown;
  body?: unknown;
}): ValidateResult {
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";

  if (!subject) {
    return { ok: false, problem: "subject_required", message: "Add a subject line." };
  }
  if (subject.length > MAX_SUBJECT) {
    return {
      ok: false,
      problem: "subject_too_long",
      message: `Subject is ${subject.length} characters. Keep it under ${MAX_SUBJECT}.`,
    };
  }
  if (!body) {
    return { ok: false, problem: "body_required", message: "Write a message." };
  }
  if (body.length < MIN_BODY) {
    return {
      ok: false,
      problem: "body_too_short",
      message: `That message is ${body.length} characters. Write at least ${MIN_BODY} before sending it to a batch.`,
    };
  }
  if (body.length > MAX_BODY) {
    return {
      ok: false,
      problem: "body_too_long",
      message: `Message is ${body.length} characters. Keep it under ${MAX_BODY}.`,
    };
  }

  const bad = [...new Set([...unknownMergeFields(subject), ...unknownMergeFields(body)])];
  if (bad.length > 0) {
    return {
      ok: false,
      problem: "unknown_merge_field",
      message: `${bad.join(", ")} ${bad.length > 1 ? "aren't" : "isn't"} a field we can fill in, so ${bad.length > 1 ? "they'd" : "it'd"} send exactly like that. Use ${MERGE_FIELDS.map((f) => f.token).join(" or ")}, or delete it.`,
      tokens: bad,
    };
  }

  return {
    ok: true,
    value: { subject: canonicalizeTokens(subject), body: canonicalizeTokens(body) },
  };
}

/**
 * Substitute the merge tokens for one recipient. Blank values fall back to
 * friendly defaults, matching renderSunbizTemplate, so a thin lead never
 * receives "Hi ," or "...for ." — the failure mode that makes a batch read as
 * machine-generated.
 */
export function renderCustomMessage(
  msg: CustomMessage,
  vars: { firstName?: string | null; businessName?: string | null },
): CustomMessage {
  const firstName = (vars.firstName || "").trim().split(/\s+/)[0] || "there";
  const businessName = (vars.businessName || "").trim() || "your business";
  const sub = (s: string) =>
    canonicalizeTokens(s)
      .replace(/\{\{first_name\}\}/g, firstName)
      .replace(/\{\{business_name\}\}/g, businessName);
  return { subject: sub(msg.subject), body: sub(msg.body) };
}
