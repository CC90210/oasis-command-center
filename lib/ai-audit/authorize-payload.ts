/**
 * lib/ai-audit/authorize-payload.ts — what CC's authorization (Gate 1,
 * approval kind "authorize_ai_audit") binds to.
 *
 * CC's brief: "The audit-generation workflow must not begin until I explicitly
 * authorize the transcript and associated client information for processing."
 * The card names the exact discovery profile, transcripts and call notes by
 * their hashes, the business it is about, the client's consent and who
 * attested it, which AI engine will process the information, and what happens
 * next. The executor (lib/ai-audit/authorize.ts) re-reads all of it
 * and refuses if anything changed, so a "yes" is to this information and no
 * other.
 *
 * PURE: lib/os/approvals/rules.ts validates payloads with it, and that module
 * is shared with the browser.
 */
import { BUSINESS_TYPES, type BusinessType } from "@/lib/ai-audit/rules";

export const AUTHORIZE_AI_AUDIT_KIND = "authorize_ai_audit" as const;

/** Who processes the client's information after Gate 1. "none": the client said no to AI analysis. */
export const AI_ENGINES = ["mac_claude", "cloud_workspace", "none"] as const;
export type AiEngine = (typeof AI_ENGINES)[number];
export const AI_ENGINE_LABELS: Readonly<Record<AiEngine, string>> = {
  mac_claude: "Claude on CC's Mac, through his own Claude subscription",
  cloud_workspace: "The workspace's cloud AI account",
  none: "No AI: the client did not agree to AI analysis, so CC writes the audit himself",
};

export type AuthorizeAiAuditPayload = {
  engagement_id: string;
  lead_id: string;
  business_name: string;
  /** Picks the research and the questions; part of what is authorized. */
  business_type: BusinessType | null;
  profile_version_id: string;
  profile_version_no: number;
  profile_sha256: string;
  field_count: number;
  /** Essential profile fields still empty: shown, never a blocker (a gap is a finding). */
  gap_count: number;
  transcripts_sha256: string | null;
  transcript_count: number;
  /** CC's notes from the call, which the AI may read too. */
  notes_sha256: string | null;
  note_count: number;
  /** Pieces taken out of the transcripts as possible passwords or account details. */
  redaction_count: number;
  /** A founder other than the owner attested a transcript's consent. */
  founder_attested: boolean;
  consent_ai: boolean;
  engine: AiEngine;
  /** What happens after approval, in plain words. */
  plan: string[];
};

type Valid<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

function count(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null;
}

export function validateAuthorizeAiAuditPayload(raw: unknown): Valid<AuthorizeAiAuditPayload> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "payload_invalid" };
  const r = raw as Record<string, unknown>;
  for (const k of ["engagement_id", "lead_id", "profile_version_id"] as const) {
    if (typeof r[k] !== "string" || !ID_RE.test(r[k] as string)) return { ok: false, error: `${k}_invalid`, field: k };
  }
  if (typeof r.profile_sha256 !== "string" || !SHA_RE.test(r.profile_sha256)) return { ok: false, error: "profile_sha256_invalid", field: "profile_sha256" };
  const transcripts = r.transcripts_sha256 === null ? null : typeof r.transcripts_sha256 === "string" && SHA_RE.test(r.transcripts_sha256) ? r.transcripts_sha256 : undefined;
  if (transcripts === undefined) return { ok: false, error: "transcripts_sha256_invalid", field: "transcripts_sha256" };
  const name = typeof r.business_name === "string" ? r.business_name.trim() : "";
  if (!name || name.length > 200) return { ok: false, error: "business_name_invalid", field: "business_name" };
  const businessType = r.business_type === null || r.business_type === undefined ? null : typeof r.business_type === "string" && (BUSINESS_TYPES as readonly string[]).includes(r.business_type) ? (r.business_type as BusinessType) : undefined;
  if (businessType === undefined) return { ok: false, error: "business_type_invalid", field: "business_type" };
  const notes = r.notes_sha256 === null ? null : typeof r.notes_sha256 === "string" && SHA_RE.test(r.notes_sha256) ? r.notes_sha256 : undefined;
  if (notes === undefined) return { ok: false, error: "notes_sha256_invalid", field: "notes_sha256" };
  const noteCount = count(r.note_count, 500);
  if (noteCount === null || (noteCount === 0) !== (notes === null)) return { ok: false, error: "note_count_invalid", field: "note_count" };
  const redactions = count(r.redaction_count, 1_000_000);
  if (redactions === null) return { ok: false, error: "redaction_count_invalid", field: "redaction_count" };
  if (typeof r.founder_attested !== "boolean") return { ok: false, error: "founder_attested_invalid", field: "founder_attested" };
  const versionNo = count(r.profile_version_no, 10_000);
  const fields = count(r.field_count, 500);
  const gaps = count(r.gap_count, 500);
  const transcriptCount = count(r.transcript_count, 50);
  if (!versionNo) return { ok: false, error: "profile_version_no_invalid", field: "profile_version_no" };
  if (fields === null || fields === 0) return { ok: false, error: "field_count_invalid", field: "field_count" };
  if (gaps === null) return { ok: false, error: "gap_count_invalid", field: "gap_count" };
  if (transcriptCount === null || (transcriptCount === 0) !== (transcripts === null)) return { ok: false, error: "transcript_count_invalid", field: "transcript_count" };
  if (typeof r.consent_ai !== "boolean") return { ok: false, error: "consent_ai_invalid", field: "consent_ai" };
  if (typeof r.engine !== "string" || !(AI_ENGINES as readonly string[]).includes(r.engine)) return { ok: false, error: "engine_invalid", field: "engine" };
  const engine = r.engine as AiEngine;
  // No AI without the client's yes, ever. The executor checks it again against the stored consent.
  if (!r.consent_ai && engine !== "none") return { ok: false, error: "engine_without_consent", field: "engine" };
  if (!Array.isArray(r.plan) || !r.plan.length || r.plan.length > 12) return { ok: false, error: "plan_invalid", field: "plan" };
  const plan: string[] = [];
  for (const line of r.plan) {
    if (typeof line !== "string" || !line.trim() || line.length > 300) return { ok: false, error: "plan_invalid", field: "plan" };
    plan.push(line.trim());
  }
  return {
    ok: true,
    value: {
      engagement_id: r.engagement_id as string,
      lead_id: r.lead_id as string,
      business_name: name,
      business_type: businessType,
      profile_version_id: r.profile_version_id as string,
      profile_version_no: versionNo,
      profile_sha256: r.profile_sha256,
      field_count: fields,
      gap_count: gaps,
      transcripts_sha256: transcripts,
      transcript_count: transcriptCount,
      notes_sha256: notes,
      note_count: noteCount,
      redaction_count: redactions,
      founder_attested: r.founder_attested,
      consent_ai: r.consent_ai,
      engine,
      plan,
    },
  };
}

/** The card's one-line preview. */
export function authorizeAiAuditPreview(payload: Record<string, unknown>): string {
  const name = typeof payload.business_name === "string" ? payload.business_name : "this client";
  const fields = typeof payload.field_count === "number" ? payload.field_count : 0;
  const transcripts = typeof payload.transcript_count === "number" ? payload.transcript_count : 0;
  const engine = typeof payload.engine === "string" && (AI_ENGINES as readonly string[]).includes(payload.engine) ? AI_ENGINE_LABELS[payload.engine as AiEngine] : "an unknown engine";
  const notes = typeof payload.note_count === "number" ? payload.note_count : 0;
  const parts = [`${fields} profile facts`, transcripts ? (transcripts === 1 ? "1 call transcript" : `${transcripts} call transcripts`) : "no transcript", ...(notes ? [notes === 1 ? "1 call note" : `${notes} call notes`] : [])];
  const what = parts.length > 2 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join(" and ");
  const checks: string[] = [];
  if (typeof payload.redaction_count === "number" && payload.redaction_count > 0) {
    checks.push(`${payload.redaction_count === 1 ? "1 possible password or account detail was" : `${payload.redaction_count} possible passwords or account details were`} taken out of the transcripts`);
  }
  if (payload.founder_attested === true) checks.push("the client's consent was attested by a founder other than you");
  const read = transcripts ? " Read the stored lines on the engagement's Call and transcripts tab before you approve." : "";
  return `Authorize ${name}'s ${what} for their Free AI Audit. Processed by: ${engine}.${checks.length ? ` Note: ${checks.join("; ")}.` : ""}${read}`;
}
