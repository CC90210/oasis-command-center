/** Public website evidence, kept separately from consent-bound call research. */
import "server-only";
import type { Client, InStatement } from "@libsql/client";
import type { PreCallBrief } from "@/lib/ai-audit/brief";
import { CHECK_TITLES } from "@/lib/ai-audit/site-checks";
import { contentHash, newId } from "@/lib/ai-audit/hash";
import { requireTenant, type Actor } from "@/lib/ai-audit/store";
import { ensureDraftProfile } from "@/lib/ai-audit/versions";
import { researchTablesInstalled } from "@/lib/ai-audit/research-purge";

export const PREFLIGHT_SCHEMA = "ai_audit_preflight/v1";

/** Used inside the brief's guarded transaction. Refreshes only its own untouched measurements. */
export async function preflightStatements(db: Client, input: {
  tenantId: string; engagementId: string; briefId: string; brief: PreCallBrief; actor: Actor; now: Date;
}): Promise<InStatement[]> {
  const t = requireTenant(input.tenantId);
  const diagnostics = input.brief.diagnostics;
  if (!diagnostics || !(await researchTablesInstalled(db))) return [];
  const at = input.now.toISOString();
  const publicResearch = {
    schema: PREFLIGHT_SCHEMA, built_at: at, brief_id: input.briefId,
    website: input.brief.site.url, ...diagnostics,
  };
  const statements: InStatement[] = [{
    sql: `INSERT INTO ai_audit_research (id, tenant_id, engagement_id, version_no, status, content, content_sha256, created_by, created_at)
          SELECT ?, ?, ?, COALESCE(MAX(version_no), 0) + 1, ?, ?, ?, ?, ?
          FROM ai_audit_research WHERE tenant_id = ? AND engagement_id = ?`,
    args: [newId(), t, input.engagementId,
      diagnostics.pagespeed?.ok && diagnostics.checks.every(c => c.status !== "unknown") ? "ready" : "partial",
      JSON.stringify(publicResearch), contentHash(publicResearch), input.actor.id, at, t, input.engagementId],
  }];
  const values = diagnostics.checks.filter(c => c.status !== "unknown").map(c => ({
    check: CHECK_TITLES[c.key], result: c.detail, source: c.evidence?.url ?? input.brief.site.url ?? "",
  }));
  const ps = diagnostics.pagespeed;
  if (ps?.ok && ps.scores.performance !== null) values.push({
    check: "Mobile PageSpeed performance", result: `${ps.scores.performance}/100 (Lighthouse lab test)`, source: ps.url,
  });
  if (!values.length) return statements;
  const { version } = await ensureDraftProfile(db, t, input.engagementId, input.actor, input.now);
  statements.push({
    sql: `INSERT INTO ai_audit_profile_fields
          (id, tenant_id, profile_version_id, field_key, value_json, label, source_type, source_ref, verified_note, updated_at)
          VALUES (?, ?, ?, 'website.diagnostics', ?, 'verified', 'research', ?, ?, ?)
          ON CONFLICT (tenant_id, profile_version_id, field_key) DO UPDATE SET
            value_json = excluded.value_json, source_ref = excluded.source_ref,
            verified_note = excluded.verified_note, updated_at = excluded.updated_at
          WHERE ai_audit_profile_fields.source_type = 'research'
            AND ai_audit_profile_fields.owner_corrected = 0
            AND ai_audit_profile_fields.updated_by IS NULL
            AND CASE WHEN json_valid(ai_audit_profile_fields.source_ref)
              THEN json_extract(ai_audit_profile_fields.source_ref, '$.brief_id') END IS NOT NULL`,
    args: [newId(), t, version.id, JSON.stringify(values),
      JSON.stringify({ brief_id: input.briefId, measured_at: at }),
      `Public website checks recorded ${at}; absent tags describe only the pages read.`, at],
  });
  return statements;
}
