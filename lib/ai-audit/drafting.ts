/**
 * lib/ai-audit/drafting.ts — saving the first drafts of an audit and its
 * proposal (lib/ai-audit/draft.ts builds them), after Gate 1 and research.
 *
 * WHEN. Only in Research & Audit Generation, only while the authorization
 * holds, and only from a stored research run. The tick drafts once, right
 * after the first research run finishes, and only where nothing has been
 * drafted yet; CC's press drafts again and replaces the draft's content (the
 * page asks first). A submitted or delivered version is never touched: the
 * versions code opens a new draft instead.
 *
 * Nothing here contacts the client, prices anything a catalogue version does
 * not, or writes a figure the research does not hold.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { auditDocIssues, validateAuditDoc, type DocIssue } from "@/lib/ai-audit/doc";
import { draftAuditDoc, draftProposal } from "@/lib/ai-audit/draft";
import { OPPORTUNITY_SKU, type PlannedOpportunity } from "@/lib/ai-audit/opportunities";
import { estimateImpact } from "@/lib/ai-audit/impact";
import { assumptionOverrides, latestResearch, RESEARCH_STAGES } from "@/lib/ai-audit/research";
import { authorizedProfile } from "@/lib/ai-audit/authorize";
import { getAuditVersion, getProposalVersion, listProfileFields, saveAuditDraft, saveProposalDraft } from "@/lib/ai-audit/versions";
import { listCatalogue } from "@/lib/ai-audit/catalogue-store";
import { eventStatement, getEngagement, getSettings, readLead, requireTenant, type Actor } from "@/lib/ai-audit/store";

export type DraftResult =
  | { ok: true; versionId: string; created: boolean; issues: DocIssue[]; opportunities: number }
  | { ok: false; error: "not_found" | "stage_closed" | "not_authorized" | "no_research" | "draft_exists" | "no_audit_draft" | "conflict" | "not_editable" | "invalid"; detail?: string };

/** The authorized profile's tools, as the audit's systems. */
function toolsOf(fields: Awaited<ReturnType<typeof listProfileFields>>): Array<{ name: string; role: string }> {
  const rows = fields.find((f) => f.field_key === "tech.tools")?.value;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}))
    .map((r) => ({ name: String(r.tool ?? "").trim(), role: String(r["what it is for"] ?? "").trim() }))
    .filter((t) => t.name);
}

/** Draft the audit from the latest research run. `replace` lets CC's press overwrite a draft's content. */
export async function draftAuditFromResearch(db: Client, input: { tenantId: string; engagementId: string; actor: Actor; now: Date; replace?: boolean }): Promise<DraftResult> {
  const t = requireTenant(input.tenantId);
  const e = await getEngagement(db, t, input.engagementId);
  if (!e) return { ok: false, error: "not_found" };
  if (!RESEARCH_STAGES.includes(e.stage)) return { ok: false, error: "stage_closed" };
  if (!(await authorizedProfile(db, t, e))) return { ok: false, error: "not_authorized" };
  const research = await latestResearch(db, t, e.id);
  if (!research) return { ok: false, error: "no_research" };
  const current = e.current_audit_version_id ? await getAuditVersion(db, t, e.current_audit_version_id) : null;
  if (current && current.status === "draft" && !input.replace) return { ok: false, error: "draft_exists" };
  // Submitted, approved or sent: that version is final, and drafting waits until CC takes it back.
  if (current && ["awaiting_approval", "approved", "delivered"].includes(current.status)) return { ok: false, error: "not_editable" };

  const [overrides, lead, fields] = await Promise.all([
    assumptionOverrides(db, t, e.id),
    readLead(db, t, e.lead_id),
    e.current_profile_version_id ? listProfileFields(db, t, e.current_profile_version_id) : Promise.resolve([]),
  ]);
  const estimates = estimateImpact(research.content.impact_inputs, overrides).estimates;
  const { doc, opportunities } = draftAuditDoc({
    business: {
      name: e.business_name || lead?.businessName || "",
      type: e.business_type ?? "other",
      ...(lead?.city ? { location: lead.city } : {}),
      ...(lead?.website ? { website: lead.website } : {}),
    },
    contactName: e.contact_name ?? lead?.contactName ?? "",
    today: input.now.toISOString().slice(0, 10),
    pack: research.content,
    estimates,
    tools: toolsOf(fields),
  });
  const valid = validateAuditDoc(doc);
  if (!valid.ok) {
    // A draft that does not validate is a bug here, never something to save.
    console.error("[ai-audit.drafting] the drafted audit did not validate", { engagementId: e.id, path: valid.path, message: valid.message });
    return { ok: false, error: "invalid", detail: `${valid.path}: ${valid.message}` };
  }
  const saved = await saveAuditDraft(db, { tenantId: t, engagementId: e.id, doc: valid.doc, actor: input.actor, now: input.now, expectedRowVersion: e.row_version });
  if (!saved.ok) return { ok: false, error: saved.error };
  const issues = auditDocIssues(valid.doc);
  await db.execute(
    eventStatement({
      tenantId: t,
      engagementId: e.id,
      event: "audit_drafted",
      actor: input.actor,
      at: input.now.toISOString(),
      refType: "audit_version",
      refId: saved.version.id,
      meta: { research_version: research.version_no, opportunities: opportunities.length, blocking: issues.filter((i) => i.severity === "block").length, replaced: !!current },
    }),
  );
  return { ok: true, versionId: saved.version.id, created: saved.created, issues, opportunities: opportunities.length };
}

/** Draft the proposal from the current audit draft's opportunities. `replace` lets CC's press overwrite a draft. */
export async function draftProposalFromAudit(db: Client, input: { tenantId: string; engagementId: string; actor: Actor; now: Date; replace?: boolean }): Promise<DraftResult> {
  const t = requireTenant(input.tenantId);
  const e = await getEngagement(db, t, input.engagementId);
  if (!e) return { ok: false, error: "not_found" };
  if (!RESEARCH_STAGES.includes(e.stage)) return { ok: false, error: "stage_closed" };
  const audit = e.current_audit_version_id ? await getAuditVersion(db, t, e.current_audit_version_id) : null;
  if (!audit?.doc) return { ok: false, error: "no_audit_draft" };
  const current = e.current_proposal_version_id ? await getProposalVersion(db, t, e.current_proposal_version_id) : null;
  if (current && current.status === "draft" && !input.replace) return { ok: false, error: "draft_exists" };

  // The audit's opportunities as they stand now (CC may have removed some); one CC added himself has no catalogue item.
  const planned: PlannedOpportunity[] = audit.doc.sections.opportunities.items.flatMap((o) => {
    const sku = OPPORTUNITY_SKU.get(o.id);
    return sku ? [{ ...o, sku, impact: "medium" as const, effort: "medium" as const, urgency: "" }] : [];
  });
  const [settings, catalogue, lead] = await Promise.all([getSettings(db, t), listCatalogue(db, t, { includeFixture: e.is_fixture }), readLead(db, t, e.lead_id)]);
  const content = draftProposal({
    opportunities: planned,
    roadmap: audit.doc.sections.roadmap,
    confirmed: catalogue.filter((i) => i.status === "confirmed"),
    currency: settings.settings.default_currency,
    tax: settings.settings.tax,
    depositBps: settings.settings.deposit_bps,
    to: e.contact_email ?? lead?.email ?? "",
    businessName: e.business_name || lead?.businessName || "",
    contactName: e.contact_name ?? lead?.contactName ?? "",
    today: input.now.toISOString().slice(0, 10),
  });
  const saved = await saveProposalDraft(db, { tenantId: t, engagementId: e.id, content, actor: input.actor, now: input.now, expectedRowVersion: e.row_version, tax: settings.settings.tax });
  if (!saved.ok) return { ok: false, error: saved.error };
  await db.execute(
    eventStatement({
      tenantId: t,
      engagementId: e.id,
      event: "proposal_drafted",
      actor: input.actor,
      at: input.now.toISOString(),
      refType: "proposal_version",
      refId: saved.version.id,
      meta: { lines: content.lines.length, needs_price: content.lines.filter((l) => l.kind === "needs_owner_price").length, replaced: !!current },
    }),
  );
  return { ok: true, versionId: saved.version.id, created: saved.created, issues: [], opportunities: planned.length };
}
