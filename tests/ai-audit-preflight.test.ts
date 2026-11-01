import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OASIS, USERS, check, finish, setupDatabase, setupProjectCustomers } from "./_delivery-harness";
import { buildBrief } from "../lib/ai-audit/briefs";
import { openEngagement, getEngagement } from "../lib/ai-audit/store";
import { latestResearch } from "../lib/ai-audit/research";
import { purgeVoidedResearch } from "../lib/ai-audit/research-purge";
import { listProfileFields, saveProfileField } from "../lib/ai-audit/versions";
import { diagnosticSignals, meetingTime, presentationOptions } from "../lib/ai-audit/presentation";
import { CATALOGUE_SEED, type CatalogueItem } from "../lib/ai-audit/catalogue";
import type { PreCallBrief } from "../lib/ai-audit/brief";

const at = new Date("2026-11-01T12:00:00.000Z");
const actor = { type: "system" as const, id: null };
const siteHtml = `<html><head><title>Fixture plumbing</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><p>${"We repair pipes and heating for local homes. ".repeat(40)}</p></body></html>`;
let clock = 0;
let pageSpeedAvailable = true;
let performanceScore = 0.42;
const site = {
  clock: () => (clock += 10),
  fetch: async (url: string) => {
    const parsed = new URL(url);
    if (parsed.hostname === "www.googleapis.com") return pageSpeedAvailable
      ? Response.json({ lighthouseResult: { finalUrl: "https://fixture-preflight.example.com/", categories: { performance: { score: performanceScore }, seo: { score: 0.8 } }, audits: { "largest-contentful-paint": { numericValue: 4800 } } } })
      : new Response("quota", { status: 429 });
    return parsed.pathname === "/" ? new Response(siteHtml, { headers: { "content-type": "text/html" } }) : new Response("", { status: 404 });
  },
};

async function main() {
  const db = await setupDatabase();
  await setupProjectCustomers(db);
  for (const file of ["bravo__186_os_approvals.sql", "bravo__206_tool_jobs.sql", "bravo__237_ai_audit_core.sql", "bravo__238_ai_audit_delivery.sql", "bravo__239_ai_audit_discovery.sql", "bravo__241_ai_audit_briefs.sql", "bravo__243_ai_audit_research.sql"]) {
    const sql = readFileSync(join(process.cwd(), "database/turso", file), "utf8");
    // executeMultiple preserves complete trigger bodies on the permanent schema fixture.
    await db.executeMultiple(sql);
  }
  const leadId = "f0000000-0000-4000-8000-000000000001";
  await db.execute({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)", args: [leadId, OASIS, JSON.stringify({ business_name: "[TEST] Preflight", stage: "founder_meeting_booked", website: "https://fixture-preflight.example.com" })] });
  const opened = await openEngagement(db, { tenantId: OASIS, leadId, actor, now: at, isFixture: true });
  assert.ok(opened.ok);
  const eid = opened.engagement.id;
  let brief!: PreCallBrief;
  await check("booking preflight persists measured site/PageSpeed data and fills a draft profile without authorizing AI", async () => {
    const result = await buildBrief(db, { tenantId: OASIS, engagementId: eid, actor, now: at, deps: site });
    assert.ok(result.ok, JSON.stringify(result));
    brief = result.brief.content;
    assert.equal(brief.diagnostics?.pagespeed?.ok, true);
    const rows = await db.execute({ sql: "SELECT content FROM ai_audit_research WHERE tenant_id = ? AND engagement_id = ?", args: [OASIS, eid] });
    assert.equal(rows.rows.length, 1);
    assert.equal(JSON.parse(String(rows.rows[0].content)).schema, "ai_audit_preflight/v1");
    assert.equal(await latestResearch(db, OASIS, eid), null, "public checks are never treated as authorized call research");
    const e = await getEngagement(db, OASIS, eid);
    assert.equal(e?.authorization_approval_id, null);
    assert.equal(e?.stage, "call_scheduled");
    const fields = await listProfileFields(db, OASIS, e!.current_profile_version_id!);
    assert.equal(fields.length, 1);
    assert.equal(fields[0].field_key, "website.diagnostics");
    assert.equal(fields[0].source_type, "research");
    assert.equal(fields[0].label, "verified");
  });
  await check("normal pre-call upkeep retains public research and wrong-tenant requests cannot read it", async () => {
    assert.equal(await purgeVoidedResearch(db, OASIS), 0);
    assert.equal(await latestResearch(db, "other-tenant", eid), null);
    const result = await buildBrief(db, { tenantId: "other-tenant", engagementId: eid, actor, now: at, deps: site });
    assert.deepEqual(result, { ok: false, error: "not_found" });
  });
  await check("rebuild keeps owner corrections and reports PageSpeed failure without inventing scores", async () => {
    performanceScore = 0.99;
    const refreshed = await buildBrief(db, { tenantId: OASIS, engagementId: eid, actor, now: new Date(at.getTime() + 120_000), deps: site });
    assert.ok(refreshed.ok);
    const latest = await getEngagement(db, OASIS, eid);
    const autoFields = await listProfileFields(db, OASIS, latest!.current_profile_version_id!);
    assert.ok(JSON.stringify(autoFields[0].value).includes("99/100"), "untouched automatic measurements refresh");
    await saveProfileField(db, { tenantId: OASIS, engagementId: eid, actor: { type: "user", id: USERS.cc.id }, now: at,
      field: { field_key: "website.diagnostics", value: autoFields[0].value, label: "verified", source_type: "research", source_note: "Owner annotation", verified_note: "Owner checked this with the client" } });
    performanceScore = 0.84;
    const annotated = await buildBrief(db, { tenantId: OASIS, engagementId: eid, actor, now: new Date(at.getTime() + 240_000), deps: site });
    assert.ok(annotated.ok);
    const notes = await listProfileFields(db, OASIS, latest!.current_profile_version_id!);
    assert.equal(notes[0].owner_corrected, false, "note-only edits need protection even when the value did not change");
    assert.equal(notes[0].source_ref.note, "Owner annotation");
    assert.equal(notes[0].verified_note, "Owner checked this with the client");
    await saveProfileField(db, { tenantId: OASIS, engagementId: eid, actor, now: at,
      field: { field_key: "website.diagnostics", value: [{ check: "Owner note", result: "Confirmed on call", source: "owner" }], label: "client_reported", source_type: "owner" } });
    pageSpeedAvailable = false;
    const result = await buildBrief(db, { tenantId: OASIS, engagementId: eid, actor, now: new Date(at.getTime() + 360_000), deps: site });
    assert.ok(result.ok);
    assert.equal(result.brief.status, "partial");
    assert.equal(result.brief.content.diagnostics?.pagespeed?.ok, false);
    assert.ok(!diagnosticSignals(result.brief.content).some(s => s.text.includes("/100")));
    const e = await getEngagement(db, OASIS, eid);
    const fields = await listProfileFields(db, OASIS, e!.current_profile_version_id!);
    assert.deepEqual(fields[0].value, [{ check: "Owner note", result: "Confirmed on call", source: "owner" }]);
  });
  await check("presentation prices come only from confirmed catalogue versions and times use Toronto", async () => {
    assert.match(meetingTime("2026-11-02T17:00:00Z"), /12:00.*EST/);
    assert.match(meetingTime("2026-07-02T17:00:00Z"), /1:00.*EDT/);
    const item = { ...CATALOGUE_SEED.find(i => i.sku === "checkout-conversion-sprint-focused")!, status: "proposed", id: "price-1" } as CatalogueItem;
    const options = presentationOptions(brief, "local_service", [item]);
    assert.ok(options.length >= 2);
    assert.ok(options.every(o => o.item === null));
    item.status = "confirmed";
    assert.equal(presentationOptions(brief, "local_service", [item]).filter(o => o.item?.id === "price-1").length, 1, "the same service is never priced twice");
    const signals = diagnosticSignals(brief);
    assert.match(signals[0].text, /42\/100.*4.8s/);
    assert.ok(signals.every(s => !/40%|lost revenue|losing/i.test(s.text)));
  });
  await check("closing an engagement removes its public preflight research", async () => {
    await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'cancelled' WHERE tenant_id = ? AND id = ?", args: [OASIS, eid] });
    assert.equal(await purgeVoidedResearch(db, OASIS), 4);
  });
  db.close();
  finish("ai-audit-preflight");
}
main().catch(err => { console.error(err); process.exitCode = 1; });
