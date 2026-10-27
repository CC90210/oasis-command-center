/**
 * lib/ai-audit/versions.ts — the versioned documents of an engagement:
 * discovery profile, audit, proposal.
 *
 * VERSIONING (brief section 12: "updated without overwriting previously
 * approved or delivered information"). Each kind has numbered versions. Only
 * a DRAFT is edited in place. Once submitted, a version is frozen by the
 * database (bravo__237 triggers); a change after that is a new draft version
 * that supersedes it. A delivered version is never changed again.
 *
 * PRICES on proposal lines are re-derived here from the confirmed catalogue
 * row, whatever the browser sent (normalizeProposal).
 */
import "server-only";
import type { Client, InStatement, Row } from "@libsql/client";
import { contentHash, newId } from "@/lib/ai-audit/hash";
import { validateAuditDoc, type AuditDoc } from "@/lib/ai-audit/doc";
import {
  proposalTotals,
  itemPriceIn,
  validateProposalContent,
  withConfirmedPrice,
  type FxRate,
  type ProposalContent,
  type ProposalLine,
  type TaxRule,
} from "@/lib/ai-audit/proposal";
import { profileFieldDef, type ProfileFieldInput, type ProfileValue } from "@/lib/ai-audit/profile";
import { stopEngagementRunsStatements } from "@/lib/ai-audit/extraction-stop";
import { confirmedCatalogueItem } from "@/lib/ai-audit/catalogue-store";
import {
  EVIDENCE_LABELS,
  PROFILE_EDIT_STAGES,
  VERSION_STATUSES,
  isOneOf,
  type EvidenceLabel,
  type VersionStatus,
} from "@/lib/ai-audit/rules";
import {
  engagementUpdateStatement,
  eventStatement,
  casWrite,
  getEngagement,
  int,
  parseObject,
  requireTenant,
  text,
  type Actor,
  type Engagement,
} from "@/lib/ai-audit/store";

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export type ProfileVersion = {
  id: string;
  engagement_id: string;
  version_no: number;
  status: "draft" | "frozen" | "superseded";
  source: string;
  summary: Record<string, unknown>;
  profile_sha256: string | null;
  transcript_sha256: string | null;
  created_at: string;
  frozen_at: string | null;
};

export type ProfileField = {
  id: string;
  field_key: string;
  value: ProfileValue;
  label: EvidenceLabel;
  source_type: string;
  source_ref: Record<string, unknown>;
  evidence_quote: string | null;
  owner_corrected: boolean;
  corrected_from: unknown;
  verified_note: string | null;
  updated_by: string | null;
  updated_at: string;
};

function mapProfileVersion(r: Row): ProfileVersion {
  const status = String(r.status);
  return {
    id: String(r.id),
    engagement_id: String(r.engagement_id),
    version_no: int(r.version_no, 1),
    status: status === "frozen" || status === "superseded" ? status : "draft",
    source: String(r.source ?? "manual"),
    summary: parseObject(r.summary),
    profile_sha256: text(r.profile_sha256),
    transcript_sha256: text(r.transcript_sha256),
    created_at: String(r.created_at),
    frozen_at: text(r.frozen_at),
  };
}

function parseValue(v: unknown): ProfileValue {
  if (typeof v !== "string") return "";
  try {
    return JSON.parse(v) as ProfileValue;
  } catch {
    return "";
  }
}

function mapProfileField(r: Row): ProfileField {
  const label = String(r.label);
  let correctedFrom: unknown = null;
  if (typeof r.corrected_from === "string") {
    try {
      correctedFrom = JSON.parse(r.corrected_from);
    } catch {
      correctedFrom = null;
    }
  }
  return {
    id: String(r.id),
    field_key: String(r.field_key),
    value: parseValue(r.value_json),
    label: isOneOf(EVIDENCE_LABELS, label) ? label : "hypothesis",
    source_type: String(r.source_type),
    source_ref: parseObject(r.source_ref),
    evidence_quote: text(r.evidence_quote),
    owner_corrected: int(r.owner_corrected) === 1,
    corrected_from: correctedFrom,
    verified_note: text(r.verified_note),
    updated_by: text(r.updated_by),
    updated_at: String(r.updated_at),
  };
}

const PROFILE_VERSION_COLUMNS = "id, engagement_id, version_no, status, source, summary, profile_sha256, transcript_sha256, created_at, frozen_at";
const PROFILE_FIELD_COLUMNS = "id, field_key, value_json, label, source_type, source_ref, evidence_quote, owner_corrected, corrected_from, verified_note, updated_by, updated_at";

export async function getProfileVersion(db: Client, tenantId: string, id: string): Promise<ProfileVersion | null> {
  const rs = await db.execute({ sql: `SELECT ${PROFILE_VERSION_COLUMNS} FROM ai_audit_profile_versions WHERE tenant_id = ? AND id = ? LIMIT 1`, args: [requireTenant(tenantId), id] });
  return rs.rows[0] ? mapProfileVersion(rs.rows[0]) : null;
}

export async function listProfileFields(db: Client, tenantId: string, versionId: string): Promise<ProfileField[]> {
  const rs = await db.execute({
    sql: `SELECT ${PROFILE_FIELD_COLUMNS} FROM ai_audit_profile_fields WHERE tenant_id = ? AND profile_version_id = ? ORDER BY field_key`,
    args: [requireTenant(tenantId), versionId],
  });
  return rs.rows.map(mapProfileField);
}

/**
 * The hash Gate 1 binds to: every field's key, value, label and source, its
 * quote from the call, and whether CC corrected it, in key order (plain
 * code-unit order, the same on every machine). Everything CC sees on a field
 * is in it (review of phase 2, F10).
 */
export function profileHashOf(fields: ProfileField[]): string {
  return contentHash(
    fields
      .map((f) => ({
        key: f.field_key,
        value: f.value,
        label: f.label,
        source_type: f.source_type,
        source_ref: f.source_ref,
        verified_note: f.verified_note,
        evidence_quote: f.evidence_quote ?? null,
        owner_corrected: !!f.owner_corrected,
        corrected_from: f.corrected_from ?? null,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  );
}

/**
 * The engagement's draft profile, creating one if the current version is
 * frozen or missing. A new draft copies the previous version's fields, so a
 * correction after authorization starts from what was authorized.
 */
export async function ensureDraftProfile(db: Client, tenantId: string, engagementId: string, actor: Actor, now: Date): Promise<{ engagement: Engagement; version: ProfileVersion }> {
  const t = requireTenant(tenantId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const engagement = await getEngagement(db, t, engagementId);
    if (!engagement) throw new Error("ai-audit.versions: engagement not found");
    const current = engagement.current_profile_version_id ? await getProfileVersion(db, t, engagement.current_profile_version_id) : null;
    if (current && current.status === "draft") return { engagement, version: current };
    const id = newId();
    const at = now.toISOString();
    const no = int((await db.execute({ sql: "SELECT COALESCE(MAX(version_no), 0) AS n FROM ai_audit_profile_versions WHERE tenant_id = ? AND engagement_id = ?", args: [t, engagementId] })).rows[0]?.n) + 1;
    const stmts: InStatement[] = [
      {
        sql: `INSERT INTO ai_audit_profile_versions (id, tenant_id, engagement_id, version_no, status, source, summary, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'draft', 'manual', ?, ?, ?, ?)`,
        args: [id, t, engagementId, no, current ? JSON.stringify(current.summary) : "{}", actor.id, at, at],
      },
    ];
    if (current) {
      stmts.push({
        sql: `INSERT INTO ai_audit_profile_fields (id, tenant_id, profile_version_id, field_key, value_json, label, source_type, source_ref,
                evidence_quote, confidence, owner_corrected, corrected_from, verified_note, updated_by, updated_at)
              SELECT lower(hex(randomblob(16))), tenant_id, ?, field_key, value_json, label, source_type, source_ref,
                evidence_quote, confidence, owner_corrected, corrected_from, verified_note, updated_by, updated_at
              FROM ai_audit_profile_fields WHERE tenant_id = ? AND profile_version_id = ?`,
        args: [id, t, current.id],
      });
    }
    stmts.push(eventStatement({ tenantId: t, engagementId, event: "profile_draft_created", actor, at, refType: "profile_version", refId: id, meta: { version_no: no } }));
    // Only while the engagement is still before Gate 1, checked by the write
    // itself: an edit that started before CC authorized must not open a draft
    // behind the profile he just froze (review of phase 2, F3).
    if (!PROFILE_EDIT_STAGES.includes(engagement.stage)) throw new Error("ai-audit.versions: the profile is frozen (authorized)");
    const ok = await casWrite(db, engagementUpdateStatement(t, engagementId, engagement.row_version, { current_profile_version_id: id }, at, undefined, PROFILE_EDIT_STAGES), stmts);
    if (ok) {
      const after = await getEngagement(db, t, engagementId);
      const version = await getProfileVersion(db, t, id);
      if (after && version) return { engagement: after, version };
    }
  }
  throw new Error("ai-audit.versions: could not open a draft profile (concurrent edits)");
}

/**
 * After Gate 1 the profile is what CC authorized: no edit may open a new draft
 * behind it. To change it, move the engagement back to Transcript Awaiting
 * Approval and authorize again.
 */
async function assertProfileEditable(db: Client, tenantId: string, engagementId: string): Promise<void> {
  const engagement = await getEngagement(db, tenantId, engagementId);
  if (!engagement) throw new Error("ai-audit.versions: engagement not found");
  if (!PROFILE_EDIT_STAGES.includes(engagement.stage)) throw new Error("ai-audit.versions: the profile is frozen (authorized)");
}

/** Save one profile field on the engagement's draft. CC's edit of an extracted value is recorded as a correction. */
export async function saveProfileField(
  db: Client,
  input: { tenantId: string; engagementId: string; field: ProfileFieldInput; actor: Actor; now: Date },
): Promise<ProfileField> {
  const t = requireTenant(input.tenantId);
  if (!profileFieldDef(input.field.field_key)) throw new Error("ai-audit.versions: unknown profile field");
  await assertProfileEditable(db, t, input.engagementId);
  const { version } = await ensureDraftProfile(db, t, input.engagementId, input.actor, input.now);
  const at = input.now.toISOString();
  const existing = (
    await db.execute({ sql: `SELECT ${PROFILE_FIELD_COLUMNS} FROM ai_audit_profile_fields WHERE tenant_id = ? AND profile_version_id = ? AND field_key = ? LIMIT 1`, args: [t, version.id, input.field.field_key] })
  ).rows[0];
  const valueJson = JSON.stringify(input.field.value);
  const sourceRef = JSON.stringify(input.field.source_note ? { note: input.field.source_note } : {});
  // An update merges the note into the reference the field already has: its transcript, lines and speakers
  // stay, so deleting that transcript still finds the field and its quote (review of phase 2b, F1).
  const notePatch = JSON.stringify({ note: input.field.source_note ? input.field.source_note : null });
  const prior = existing ? mapProfileField(existing) : null;
  // A correction: someone changed a value that came from the transcript, the form or research.
  const correcting = !!prior && prior.source_type !== "owner" && prior.source_type !== "call_notes" && JSON.stringify(prior.value) !== valueJson;
  await db.batch(
    [
      {
        sql: `INSERT INTO ai_audit_profile_fields (id, tenant_id, profile_version_id, field_key, value_json, label, source_type, source_ref,
                owner_corrected, corrected_from, verified_note, updated_by, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (tenant_id, profile_version_id, field_key) DO UPDATE SET
                value_json = excluded.value_json, label = excluded.label,
                source_type = CASE WHEN ? = 1 THEN ai_audit_profile_fields.source_type ELSE excluded.source_type END,
                source_ref = json_patch(COALESCE(ai_audit_profile_fields.source_ref, '{}'), ?),
                owner_corrected = CASE WHEN ? = 1 THEN 1 ELSE ai_audit_profile_fields.owner_corrected END,
                corrected_from = CASE WHEN ? = 1 THEN ai_audit_profile_fields.value_json ELSE ai_audit_profile_fields.corrected_from END,
                -- A changed value no longer matches the quote that came with the old one (review of phase 2b, H2 and F1).
                evidence_quote = CASE WHEN ai_audit_profile_fields.value_json IS NOT excluded.value_json THEN NULL ELSE ai_audit_profile_fields.evidence_quote END,
                verified_note = excluded.verified_note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        args: [
          newId(), t, version.id, input.field.field_key, valueJson, input.field.label, input.field.source_type, sourceRef,
          0, null, input.field.verified_note ?? null, input.actor.id, at,
          correcting ? 1 : 0, notePatch, correcting ? 1 : 0, correcting ? 1 : 0,
        ],
      },
      // The client's "no" to AI analysis stops a draft still reading the call (review of phase 2b, F5).
      ...(input.field.field_key === "consent.ai_processing" && input.field.value === false ? stopEngagementRunsStatements(t, input.engagementId, "no_ai_consent", at) : []),
      eventStatement({
        tenantId: t,
        engagementId: input.engagementId,
        event: correcting ? "profile_field_corrected" : "profile_field_saved",
        actor: input.actor,
        at,
        refType: "profile_field",
        refId: input.field.field_key,
        meta: { label: input.field.label, version_no: version.version_no },
      }),
    ],
    "write",
  );
  const row = (await db.execute({ sql: `SELECT ${PROFILE_FIELD_COLUMNS} FROM ai_audit_profile_fields WHERE tenant_id = ? AND profile_version_id = ? AND field_key = ? LIMIT 1`, args: [t, version.id, input.field.field_key] })).rows[0];
  if (!row) throw new Error("ai-audit.versions: saved a field but cannot read it back");
  return mapProfileField(row);
}

export async function deleteProfileField(db: Client, input: { tenantId: string; engagementId: string; fieldKey: string; actor: Actor; now: Date }): Promise<boolean> {
  const t = requireTenant(input.tenantId);
  await assertProfileEditable(db, t, input.engagementId);
  const { version } = await ensureDraftProfile(db, t, input.engagementId, input.actor, input.now);
  const at = input.now.toISOString();
  // The delete carries "this version is still a draft" itself. The database
  // guards inserts and updates on a frozen profile (bravo__237) but not
  // deletes, so Gate 1 landing between the check above and this write must
  // leave the field where it is (Codex review of phase 2).
  const removed = await casWrite(db, deleteDraftFieldStatement(t, version.id, input.fieldKey), [
    eventStatement({ tenantId: t, engagementId: input.engagementId, event: "profile_field_removed", actor: input.actor, at, refType: "profile_field", refId: input.fieldKey }),
  ]);
  if (!removed && (await getProfileVersion(db, t, version.id))?.status !== "draft") throw new Error("ai-audit.versions: the profile is frozen (authorized)");
  return removed;
}

/** Delete one field, only while its version is a draft. */
export function deleteDraftFieldStatement(tenantId: string, versionId: string, fieldKey: string): InStatement {
  return {
    sql: `DELETE FROM ai_audit_profile_fields WHERE tenant_id = ? AND profile_version_id = ? AND field_key = ?
            AND EXISTS (SELECT 1 FROM ai_audit_profile_versions WHERE tenant_id = ? AND id = ? AND status = 'draft')`,
    args: [tenantId, versionId, fieldKey, tenantId, versionId],
  };
}

// ---------------------------------------------------------------------------
// Audit and proposal versions (same shape, different content)
// ---------------------------------------------------------------------------

export type AuditVersion = {
  id: string;
  engagement_id: string;
  version_no: number;
  status: VersionStatus;
  doc: AuditDoc | null;
  content_sha256: string;
  supersedes_id: string | null;
  approval_id: string | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  pdf_bytes: number | null;
  pdf_pages: number | null;
  pdf_rendered_at: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  delivered_at: string | null;
};

export type ProposalVersion = {
  id: string;
  engagement_id: string;
  version_no: number;
  status: VersionStatus;
  currency: "CAD" | "USD";
  content: ProposalContent | null;
  content_sha256: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  due_now_cents: number;
  valid_until: string | null;
  audit_version_id: string | null;
  supersedes_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  delivered_at: string | null;
};

const AUDIT_COLUMNS =
  "id, engagement_id, version_no, status, content, content_sha256, supersedes_id, approval_id, pdf_path, pdf_sha256, pdf_bytes, pdf_pages, pdf_rendered_at, created_at, updated_at, submitted_at, approved_at, delivered_at";
const PROPOSAL_COLUMNS =
  "id, engagement_id, version_no, status, currency, content, content_sha256, subtotal_cents, tax_cents, total_cents, due_now_cents, valid_until, audit_version_id, supersedes_id, created_at, updated_at, submitted_at, approved_at, delivered_at";

function status(v: unknown): VersionStatus {
  const s = String(v);
  return isOneOf(VERSION_STATUSES, s) ? s : "withdrawn";
}

function mapAudit(r: Row): AuditVersion {
  let doc: AuditDoc | null = null;
  try {
    const parsed = validateAuditDoc(JSON.parse(String(r.content)));
    doc = parsed.ok ? parsed.doc : null;
  } catch {
    doc = null;
  }
  return {
    id: String(r.id),
    engagement_id: String(r.engagement_id),
    version_no: int(r.version_no, 1),
    status: status(r.status),
    doc,
    content_sha256: String(r.content_sha256),
    supersedes_id: text(r.supersedes_id),
    approval_id: text(r.approval_id),
    pdf_path: text(r.pdf_path),
    pdf_sha256: text(r.pdf_sha256),
    pdf_bytes: r.pdf_bytes === null || r.pdf_bytes === undefined ? null : int(r.pdf_bytes),
    pdf_pages: r.pdf_pages === null || r.pdf_pages === undefined ? null : int(r.pdf_pages),
    pdf_rendered_at: text(r.pdf_rendered_at),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    submitted_at: text(r.submitted_at),
    approved_at: text(r.approved_at),
    delivered_at: text(r.delivered_at),
  };
}

function mapProposal(r: Row): ProposalVersion {
  let content: ProposalContent | null = null;
  try {
    const parsed = validateProposalContent(JSON.parse(String(r.content)));
    content = parsed.ok ? parsed.value : null;
  } catch {
    content = null;
  }
  return {
    id: String(r.id),
    engagement_id: String(r.engagement_id),
    version_no: int(r.version_no, 1),
    status: status(r.status),
    currency: String(r.currency) === "USD" ? "USD" : "CAD",
    content,
    content_sha256: String(r.content_sha256),
    subtotal_cents: int(r.subtotal_cents),
    tax_cents: int(r.tax_cents),
    total_cents: int(r.total_cents),
    due_now_cents: int(r.due_now_cents),
    valid_until: text(r.valid_until),
    audit_version_id: text(r.audit_version_id),
    supersedes_id: text(r.supersedes_id),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    submitted_at: text(r.submitted_at),
    approved_at: text(r.approved_at),
    delivered_at: text(r.delivered_at),
  };
}

export async function getAuditVersion(db: Client, tenantId: string, id: string): Promise<AuditVersion | null> {
  const rs = await db.execute({ sql: `SELECT ${AUDIT_COLUMNS} FROM ai_audit_versions WHERE tenant_id = ? AND id = ? LIMIT 1`, args: [requireTenant(tenantId), id] });
  return rs.rows[0] ? mapAudit(rs.rows[0]) : null;
}

export async function getProposalVersion(db: Client, tenantId: string, id: string): Promise<ProposalVersion | null> {
  const rs = await db.execute({ sql: `SELECT ${PROPOSAL_COLUMNS} FROM ai_audit_proposal_versions WHERE tenant_id = ? AND id = ? LIMIT 1`, args: [requireTenant(tenantId), id] });
  return rs.rows[0] ? mapProposal(rs.rows[0]) : null;
}

export async function listAuditVersions(db: Client, tenantId: string, engagementId: string): Promise<AuditVersion[]> {
  const rs = await db.execute({ sql: `SELECT ${AUDIT_COLUMNS} FROM ai_audit_versions WHERE tenant_id = ? AND engagement_id = ? ORDER BY version_no DESC`, args: [requireTenant(tenantId), engagementId] });
  return rs.rows.map(mapAudit);
}

export async function listProposalVersions(db: Client, tenantId: string, engagementId: string): Promise<ProposalVersion[]> {
  const rs = await db.execute({ sql: `SELECT ${PROPOSAL_COLUMNS} FROM ai_audit_proposal_versions WHERE tenant_id = ? AND engagement_id = ? ORDER BY version_no DESC`, args: [requireTenant(tenantId), engagementId] });
  return rs.rows.map(mapProposal);
}

export type SaveDraftResult<T> = { ok: true; version: T; created: boolean } | { ok: false; error: "conflict" | "not_editable" | "not_found" };

/**
 * Where a delivered version may get a new draft: only in Research & Audit
 * Generation, after a revision moved the engagement back (lib/ai-audit/delivery.ts
 * reviseAfterDelivery, phase 5). While the client has it, the delivered
 * versions and the pointers the payment rules read stay as they are
 * (re-review of phase 5).
 */
const REVISION_STAGES: readonly string[] = ["generating"];

/**
 * Save the audit document on the engagement's draft version. When the current
 * version is not a draft (it was submitted, approved or delivered), a new
 * draft version is created that supersedes it; the frozen one stays as it is.
 */
export async function saveAuditDraft(
  db: Client,
  input: { tenantId: string; engagementId: string; doc: AuditDoc; actor: Actor; now: Date; expectedRowVersion: number },
): Promise<SaveDraftResult<AuditVersion>> {
  const t = requireTenant(input.tenantId);
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement) return { ok: false, error: "not_found" };
  if (engagement.row_version !== input.expectedRowVersion) return { ok: false, error: "conflict" };
  const json = JSON.stringify(input.doc);
  const sha = contentHash(input.doc);
  const at = input.now.toISOString();
  const current = engagement.current_audit_version_id ? await getAuditVersion(db, t, engagement.current_audit_version_id) : null;
  if (current && current.status === "draft") {
    const ok = await casWrite(db, engagementUpdateStatement(t, engagement.id, engagement.row_version, {}, at), [
      { sql: "UPDATE ai_audit_versions SET content = ?, content_sha256 = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'", args: [json, sha, at, t, current.id] },
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "audit_draft_saved", actor: input.actor, at, refType: "audit_version", refId: current.id, meta: { version_no: current.version_no, content_sha256: sha } }),
    ]);
    if (!ok) return { ok: false, error: "conflict" };
    const v = await getAuditVersion(db, t, current.id);
    return v ? { ok: true, version: v, created: false } : { ok: false, error: "not_found" };
  }
  if (current && current.status === "delivered" && !REVISION_STAGES.includes(engagement.stage)) {
    return { ok: false, error: "not_editable" };
  }
  const id = newId();
  const no = int((await db.execute({ sql: "SELECT COALESCE(MAX(version_no), 0) AS n FROM ai_audit_versions WHERE tenant_id = ? AND engagement_id = ?", args: [t, engagement.id] })).rows[0]?.n) + 1;
  const ok = await casWrite(db, engagementUpdateStatement(t, engagement.id, engagement.row_version, { current_audit_version_id: id }, at), [
    {
      sql: `INSERT INTO ai_audit_versions (id, tenant_id, engagement_id, version_no, status, content, content_sha256, profile_version_id, supersedes_id, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, t, engagement.id, no, json, sha, engagement.current_profile_version_id, current?.id ?? null, input.actor.id, at, at],
    },
    eventStatement({ tenantId: t, engagementId: engagement.id, event: "audit_draft_created", actor: input.actor, at, refType: "audit_version", refId: id, meta: { version_no: no, supersedes: current?.id ?? null } }),
  ]);
  if (!ok) return { ok: false, error: "conflict" };
  const v = await getAuditVersion(db, t, id);
  return v ? { ok: true, version: v, created: true } : { ok: false, error: "not_found" };
}

/**
 * The proposal as it may be stored: catalogue lines rebuilt from the
 * confirmed catalogue row (a line whose item is no longer confirmed becomes
 * "needs your price"), CC's own prices stamped with who set them, and the tax
 * rule taken from the workspace's settings.
 */
export async function normalizeProposal(
  db: Client,
  tenantId: string,
  content: ProposalContent,
  previous: ProposalContent | null,
  actorId: string,
  tax: TaxRule | null,
  now: Date,
  opts: { allowFixtureItems: boolean; ownerMayPrice?: boolean; fx: FxRate | null },
): Promise<ProposalContent> {
  const lines: ProposalLine[] = [];
  const unpriced = (l: ProposalLine, suggestedSku?: string): ProposalLine => ({
    kind: "needs_owner_price",
    line_id: l.line_id,
    name: l.name,
    description: l.description,
    category: l.category,
    unit: l.unit,
    ...(l.unit_label ? { unit_label: l.unit_label } : {}),
    quantity: l.quantity,
    optional: l.optional,
    deliverables: l.deliverables,
    onboarding_requirements: l.onboarding_requirements,
    ...(suggestedSku ? { suggested_sku: suggestedSku } : {}),
  });
  for (const l of content.lines) {
    if (l.kind === "catalogue") {
      const found = await confirmedCatalogueItem(db, tenantId, l.item_id);
      // The test prospect's canary item never prices a real client's proposal. An item priced in another
      // currency prices this one only converted at CC's rate (USD core, CAD on request); with no rate it waits.
      const item = found && (!found.is_fixture || opts.allowFixtureItems) ? found : null;
      const price = item ? itemPriceIn(item, content.currency, opts.fx) : null;
      if (!item || !price) {
        lines.push(unpriced(l, l.sku || undefined));
        continue;
      }
      // The same line the editor's "Add item" and "Use the confirmed price" build (lib/ai-audit/proposal.ts).
      lines.push(withConfirmedPrice(l, item, price, content.currency));
    } else if (l.kind === "owner_set") {
      const prior = previous?.lines.find((p) => p.line_id === l.line_id);
      const unchanged = prior && prior.kind === "owner_set" && prior.unit_price_cents === l.unit_price_cents && prior.set_by;
      // Only the workspace owner types a price. Anyone else's new or changed
      // price waits for the owner (CC's brief: no fee outside the approved
      // rules without his say); a price he set earlier is kept as it was.
      if (!unchanged && !opts.ownerMayPrice) {
        lines.push(unpriced(l));
        continue;
      }
      lines.push({
        ...l,
        set_by: unchanged ? (prior as { set_by: string }).set_by : actorId,
        set_at: unchanged ? (prior as { set_at: string }).set_at : now.toISOString(),
      });
    } else {
      lines.push(l);
    }
  }
  return { ...content, lines, tax };
}

export async function saveProposalDraft(
  db: Client,
  input: { tenantId: string; engagementId: string; content: ProposalContent; actor: Actor; now: Date; expectedRowVersion: number; tax: TaxRule | null; fx: FxRate | null; ownerMayPrice?: boolean },
): Promise<SaveDraftResult<ProposalVersion>> {
  const t = requireTenant(input.tenantId);
  const engagement = await getEngagement(db, t, input.engagementId);
  if (!engagement) return { ok: false, error: "not_found" };
  if (engagement.row_version !== input.expectedRowVersion) return { ok: false, error: "conflict" };
  const current = engagement.current_proposal_version_id ? await getProposalVersion(db, t, engagement.current_proposal_version_id) : null;
  if (current && current.status === "delivered" && !REVISION_STAGES.includes(engagement.stage)) {
    return { ok: false, error: "not_editable" };
  }
  const content = await normalizeProposal(db, t, input.content, current?.content ?? null, input.actor.id ?? "", input.tax, input.now, {
    allowFixtureItems: engagement.is_fixture,
    ownerMayPrice: input.ownerMayPrice === true,
    fx: input.fx,
  });
  const totals = proposalTotals(content);
  const json = JSON.stringify(content);
  const sha = contentHash(content);
  const at = input.now.toISOString();
  if (current && current.status === "draft") {
    const ok = await casWrite(db, engagementUpdateStatement(t, engagement.id, engagement.row_version, {}, at), [
      {
        sql: `UPDATE ai_audit_proposal_versions SET currency = ?, content = ?, content_sha256 = ?, subtotal_cents = ?, tax_cents = ?, total_cents = ?,
                due_now_cents = ?, valid_until = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'`,
        args: [content.currency, json, sha, totals.subtotal_cents, totals.tax_cents, totals.total_cents, totals.due_now_cents, content.valid_until, at, t, current.id],
      },
      eventStatement({ tenantId: t, engagementId: engagement.id, event: "proposal_draft_saved", actor: input.actor, at, refType: "proposal_version", refId: current.id, meta: { version_no: current.version_no, total_cents: totals.total_cents } }),
    ]);
    if (!ok) return { ok: false, error: "conflict" };
    const v = await getProposalVersion(db, t, current.id);
    return v ? { ok: true, version: v, created: false } : { ok: false, error: "not_found" };
  }
  const id = newId();
  const no = int((await db.execute({ sql: "SELECT COALESCE(MAX(version_no), 0) AS n FROM ai_audit_proposal_versions WHERE tenant_id = ? AND engagement_id = ?", args: [t, engagement.id] })).rows[0]?.n) + 1;
  const ok = await casWrite(db, engagementUpdateStatement(t, engagement.id, engagement.row_version, { current_proposal_version_id: id }, at), [
    {
      sql: `INSERT INTO ai_audit_proposal_versions (id, tenant_id, engagement_id, version_no, status, currency, content, content_sha256, subtotal_cents, tax_cents,
              total_cents, due_now_cents, valid_until, audit_version_id, supersedes_id, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, t, engagement.id, no, content.currency, json, sha, totals.subtotal_cents, totals.tax_cents, totals.total_cents, totals.due_now_cents, content.valid_until, engagement.current_audit_version_id, current?.id ?? null, input.actor.id, at, at],
    },
    eventStatement({ tenantId: t, engagementId: engagement.id, event: "proposal_draft_created", actor: input.actor, at, refType: "proposal_version", refId: id, meta: { version_no: no } }),
  ]);
  if (!ok) return { ok: false, error: "conflict" };
  const v = await getProposalVersion(db, t, id);
  return v ? { ok: true, version: v, created: true } : { ok: false, error: "not_found" };
}
