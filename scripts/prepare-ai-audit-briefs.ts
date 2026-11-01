/** Scoped pre-call preparation: preview by default; no client contact or AI calls. */
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { buildBrief, defaultSiteDeps, latestBrief } from "../lib/ai-audit/briefs";
import { getEngagement, readLead } from "../lib/ai-audit/store";

async function main() {
  const args = process.argv.slice(2);
  assert(args.every(a => a === "--apply" || a.startsWith("--tenant=") || a.startsWith("--engagement=")), "unknown argument");
  const tenantId = args.find(a => a.startsWith("--tenant="))?.slice(9) ?? "";
  const ids = [...new Set(args.filter(a => a.startsWith("--engagement=")).map(a => a.slice(13)))];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  assert(uuid.test(tenantId) && ids.length > 0 && ids.length <= 10 && ids.every(id => uuid.test(id)), "supply --tenant=<uuid> and one to ten --engagement=<uuid>");
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  try {
    // Validate the entire selection before any build.
    const selected = [];
    for (const id of ids) {
      const engagement = await getEngagement(db, tenantId, id);
      assert(engagement && engagement.stage === "call_scheduled" && engagement.appointment_id && engagement.meet_room_id, `not a linked scheduled audit: ${id}`);
      const lead = await readLead(db, tenantId, engagement.lead_id);
      assert(lead, `lead missing: ${id}`);
      const brief = await latestBrief(db, tenantId, id);
      selected.push({ id, website: lead.website, alreadyPrepared: !!brief?.content.diagnostics });
    }
    if (!args.includes("--apply")) { console.log(JSON.stringify({ apply: false, selected }, null, 2)); return; }
    for (const item of selected) {
      if (!item.alreadyPrepared) {
        const built = await buildBrief(db, { tenantId, engagementId: item.id, actor: { type: "system", id: null }, now: new Date(), deps: defaultSiteDeps() });
        assert(built.ok, `brief build failed for ${item.id}: ${JSON.stringify(built)}`);
      }
      const brief = await latestBrief(db, tenantId, item.id);
      assert(brief?.content.diagnostics, `diagnostics not persisted: ${item.id}`);
      const research = await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_research WHERE tenant_id=? AND engagement_id=? AND json_extract(content,'$.schema')='ai_audit_preflight/v1' AND json_extract(content,'$.brief_id')=?", args: [tenantId, item.id, brief.id] });
      assert(Number(research.rows[0]?.n) > 0, `preflight research not persisted: ${item.id}`);
      console.log(JSON.stringify({ id: item.id, version: brief.version_no, status: brief.status, pagesRead: brief.content.site.pages_read, checks: brief.content.diagnostics.checks.length, pagespeed: brief.content.diagnostics.pagespeed?.ok ?? false, researchStored: true }));
    }
  } finally { db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
