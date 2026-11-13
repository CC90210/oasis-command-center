/**
 * tests/site-scan-store.test.ts — site_scans end to end on a throwaway local libSQL file:
 * migration bravo__259 applied as scripts/apply_turso_migration.py splits it, bravo__206 for the
 * runner queue; insert, reuse within the window, Tier 0 save, the queued enrichment job, the
 * runner's report applied, and the view's stage ticks at each step. No network.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-store.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { applyEnrichReport, enrichJobInput, parseEnrichReport } from "../lib/site-scan/enrich-job";
import { queueEnrichment } from "../lib/site-scan/run";
import { getScan, insertScan, latestScanForDomain, reserveClaim, setClaimEngagement, saveTier0, scanCounts, setStatus, siteScanTablesInstalled } from "../lib/site-scan/store";
import { ENRICH_SCHEMA, ENRICH_WAIT_MINUTES, NARRATIVE_SCHEMA, SCORE_SCHEMA, FACTS_SCHEMA, type ScanFacts, type ScanNarrative, type ScanScore } from "../lib/site-scan/types";
import { stageStates, toView } from "../lib/site-scan/view";

const ROOT = join(__dirname, "..");
const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "site-scan-"));
  const db = createClient({ url: `file:${join(dir, "t.db")}` });
  try {
    assert.equal(await siteScanTablesInstalled(db), false, "before the migration the table is absent");
    // Whole files: bravo__206 holds triggers whose bodies carry semicolons a splitter would cut.
    await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__206_tool_jobs.sql"), "utf8"));
    await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__259_site_scans.sql"), "utf8"));
    assert.equal(await siteScanTablesInstalled(db), true);

    const t0 = new Date("2026-11-12T10:00:00.000Z");
    const { row } = await insertScan(db, { tenantId: TENANT, domain: "acme.example", url: "https://acme.example/", ipHash: "abc", now: t0 });
    assert.equal(row.status, "reading");
    assert.equal(row.stage, "read");
    assert.equal((await scanCounts(db, TENANT)).scans, 1);

    // The same domain the same day is the same row; another workspace never sees it.
    const again = await insertScan(db, { tenantId: TENANT, domain: "acme.example", url: "https://acme.example/", ipHash: null, now: new Date("2026-11-12T11:00:00.000Z") });
    assert.equal(again.row.id, row.id, "one scan per domain per day");
    assert.equal(await getScan(db, "other-tenant", row.id), null);

    // The view while reading: the first stage runs, nothing is done.
    let view = toView(row, t0);
    assert.equal(view.status, "reading");
    assert.equal(view.stages[0].state, "running");
    assert.ok(view.stages.slice(1).every((s) => s.state === "pending"));

    const facts: ScanFacts = {
      schema: FACTS_SCHEMA, domain: "acme.example", start_url: "https://acme.example/", final_url: "https://acme.example/", read_at: t0.toISOString(),
      site: { unread: null, pages_read: 2, notes: [], https_served: true, response_ms: 500, html_kb: 40 },
      checks: [{ key: "https", status: "yes", detail: "ok", found: [], evidence: null }], pagespeed: null,
      signals: { title: "Acme", meta_description: null, h1: [], og_site_name: null, language: null, business_name: "Acme", tagline: null, phones: [], emails: [], localities: ["Laval"], services: [], pricing_mentioned: false, booking_tools: [], forms_count: 0, chat_tools: [], analytics: [], socials: {}, schema_types: [], copyright_year: null, blog: { found: false, latest_date: null }, images_total: 0, images_missing_alt: 0, internal_links: 0, external_links: 0, cta_phrases: [], keywords: [], word_count: 10, text_excerpt: "secret text never leaves the server" },
    };
    const score: ScanScore = { schema: SCORE_SCHEMA, total: 41, pillars: [], fixes: [] };
    const narrative: ScanNarrative = { schema: NARRATIVE_SCHEMA, source: "template", what_you_sell: "A", who_buys: "B", competitors_note: null, fixes_intro: "C", email: null };
    const t1 = new Date("2026-11-12T10:00:30.000Z");
    assert.equal(await saveTier0(db, { tenantId: TENANT, id: row.id, facts, score, narrative, status: "enriching", stage: "profile", now: t1 }), true);
    assert.equal(await saveTier0(db, { tenantId: TENANT, id: row.id, facts, score, narrative, status: "enriching", stage: "profile", now: t1 }), false, "a second Tier 0 run finds the row moved on");

    const queued = await queueEnrichment(db, { tenantId: TENANT, scanId: row.id, attempt: row.createdAt, now: t1 });
    assert.deepEqual(queued, { ok: true });
    assert.deepEqual(await queueEnrichment(db, { tenantId: TENANT, scanId: row.id, attempt: row.createdAt, now: t1 }), { ok: true }, "queueing twice is one job");
    const jobs = await db.execute({ sql: "SELECT tool_key, status, runs_on, input_json FROM tool_jobs WHERE tenant_id = ?", args: [TENANT] });
    assert.equal(jobs.rows.length, 1);
    assert.equal(jobs.rows[0].tool_key, "site_scan_enrich");
    assert.equal(jobs.rows[0].status, "queued");
    assert.deepEqual(JSON.parse(String(jobs.rows[0].input_json)), { scan_id: row.id }, "the job carries the scan id only");

    // A finished report is never the next visitor's answer: the same domain the same day is read again
    // in place (CC, 2026-11-13: a report from the morning came back at once, "finished in two seconds").
    const fresh = (await insertScan(db, { tenantId: TENANT, domain: "fresh.example", url: "https://fresh.example/", ipHash: null, now: new Date("2026-11-14T10:00:00.000Z") })).row;
    await saveTier0(db, { tenantId: TENANT, id: fresh.id, facts: { ...facts, domain: "fresh.example" }, score, narrative, status: "done", stage: "done", now: new Date("2026-11-14T10:01:00.000Z") });
    const later = new Date("2026-11-14T15:00:00.000Z");
    const reread = await insertScan(db, { tenantId: TENANT, domain: "fresh.example", url: "https://fresh.example/", ipHash: null, now: later });
    assert.equal(reread.row.id, fresh.id, "the same row, under the one-per-day index");
    assert.equal(reread.started, true, "the finished report is read again");
    assert.equal(reread.row.status, "reading");
    assert.equal(reread.row.facts, null, "nothing of the earlier read passes for the new one's");
    assert.equal(reread.row.createdAt, later.toISOString(), "dated now");
    const joined = await insertScan(db, { tenantId: TENANT, domain: "fresh.example", url: "https://fresh.example/", ipHash: null, now: new Date(later.getTime() + 60_000) });
    assert.equal(joined.started, false, "the new read is the scan; a second visitor follows it");
    const nextDay = await insertScan(db, { tenantId: TENANT, domain: "fresh.example", url: "https://fresh.example/", ipHash: null, now: new Date("2026-11-15T10:00:00.000Z") });
    assert.notEqual(nextDay.row.id, fresh.id, "the next day is a new row");
    assert.equal(nextDay.started, true);

    // An enrichment the runner never delivered is read again once the view would have closed it; a live one is joined.
    const stuck = (await insertScan(db, { tenantId: TENANT, domain: "stuck.example", url: "https://stuck.example/", ipHash: null, now: later })).row;
    await saveTier0(db, { tenantId: TENANT, id: stuck.id, facts: { ...facts, domain: "stuck.example" }, score, narrative, status: "enriching", stage: "profile", now: later });
    const stuckAgain = (d: number) => insertScan(db, { tenantId: TENANT, domain: "stuck.example", url: "https://stuck.example/", ipHash: null, now: new Date(later.getTime() + d) });
    assert.equal((await stuckAgain(5 * 60_000)).started, false, "the runner is still expected: the visitor follows this run");
    assert.equal((await stuckAgain((ENRICH_WAIT_MINUTES + 1) * 60_000)).started, true, "overdue: read again");

    // A report a lead claimed is never reset: that lead's audit is built on it.
    const kept = (await insertScan(db, { tenantId: TENANT, domain: "kept.example", url: "https://kept.example/", ipHash: null, now: later })).row;
    await setStatus(db, { tenantId: TENANT, id: kept.id, status: "done", stage: "done", errorCode: null, now: later });
    assert.equal(await reserveClaim(db, { tenantId: TENANT, id: kept.id, leadRecordId: "lead-kept", now: later }), "reserved");
    const claimedAgain = await insertScan(db, { tenantId: TENANT, domain: "kept.example", url: "https://kept.example/", ipHash: null, now: new Date(later.getTime() + 60_000) });
    assert.equal(claimedAgain.started, false, "a report a lead claimed is never reset");
    assert.equal((await getScan(db, TENANT, kept.id))?.status, "done");

    // The view mid-enrichment: read, health and score are done; profile runs; the public view has no page text.
    const mid = (await getScan(db, TENANT, row.id))!;
    view = toView(mid, t1);
    assert.equal(view.status, "enriching");
    const state = Object.fromEntries(view.stages.map((s) => [s.key, s.state]));
    assert.equal(state.read, "done");
    assert.equal(state.health, "done");
    assert.equal(state.score, "done");
    assert.equal(state.profile, "running");
    assert.equal(state.segments, "pending");
    assert.equal(view.facts?.signals?.text_excerpt, "", "text_excerpt never reaches the browser");

    // What the runner is handed at claim time: facts without the excerpt field, plus the excerpt capped.
    const built = await enrichJobInput(db, { tenantId: TENANT, input: { scan_id: row.id } });
    assert.ok(built.ok);
    assert.equal(built.input.domain, "acme.example");
    assert.equal(built.input.leadgen_tenant_id, TENANT);
    assert.equal(built.input.text_excerpt, "secret text never leaves the server");
    assert.equal((built.input.facts.signals as Record<string, unknown>).text_excerpt, undefined);
    const gone = await enrichJobInput(db, { tenantId: TENANT, input: { scan_id: "00000000-0000-4000-8000-000000000000" } });
    assert.ok(!gone.ok && gone.code === "gone");

    // The runner's report lands: enrich + narrative + embedding; the scan is done; stages tick.
    const report = parseEnrichReport({
      enrich: { schema: ENRICH_SCHEMA, engine: { embedder: "hashed-tfidf:2048", version: "1.0.0" }, category: { key: "plumbing_hvac", label: "Plumbing", confidence: 0.7 }, keywords: ["drain"], segments: [{ key: "homeowners", label: "Homeowners", fit: 88, why: "w" }], competitors: [], prospects: [{ name: "Gestion Nord", locality: "Laval", region: "QC", domain: "gin.example", category_label: "Property managers", why: "w" }], email_auth: null, notes: [] },
      narrative: { schema: NARRATIVE_SCHEMA, source: "template", what_you_sell: "X", who_buys: "Y", competitors_note: null, fixes_intro: "Z", email: { to: "Gestion Nord", subject: "S", body: "B" } },
      embedding: [0.1, 0.2],
    });
    assert.ok(report.ok);
    const t2 = new Date("2026-11-12T10:02:00.000Z");
    assert.equal(await applyEnrichReport(db, { tenantId: TENANT, jobInput: { scan_id: row.id }, report: report.value, now: t2 }), true);
    const done = (await getScan(db, TENANT, row.id))!;
    assert.equal(done.status, "done");
    assert.equal(done.enrichedAt, t2.toISOString());
    assert.equal(done.narrative?.email?.subject, "S");
    const finalState = Object.fromEntries(stageStates(done, t2).map((s) => [s.key, s.state]));
    assert.deepEqual(finalState, { read: "done", health: "done", profile: "done", segments: "done", prospects: "done", email: "done", score: "done", done: "done" });
    assert.equal(await applyEnrichReport(db, { tenantId: TENANT, jobInput: { scan_id: row.id }, report: report.value, now: t2 }), true, "a repeated report is idempotent on a done row");

    // An enrichment that never arrives is closed by the view after the wait; the Worker's report stands.
    const { row: second } = await insertScan(db, { tenantId: TENANT, domain: "slow.example", url: "https://slow.example/", ipHash: null, now: t0 });
    await saveTier0(db, { tenantId: TENANT, id: second.id, facts: { ...facts, domain: "slow.example" }, score, narrative, status: "enriching", stage: "profile", now: t1 });
    const late = toView((await getScan(db, TENANT, second.id))!, new Date("2026-11-12T10:30:00.000Z"));
    assert.equal(late.status, "done");
    assert.equal(late.stages.find((s) => s.key === "segments")!.state, "skipped");
    assert.equal(late.stages.find((s) => s.key === "done")!.state, "done");

    // Failure words reach the visitor; the raw code does not.
    await setStatus(db, { tenantId: TENANT, id: second.id, status: "failed", stage: "read", errorCode: "read_failed", now: t2 });
    const failed = toView((await getScan(db, TENANT, second.id))!, t2);
    assert.match(failed.error ?? "", /could not be read/);

    // Claiming links the lead and flips the outcome once.
    assert.equal(await reserveClaim(db, { tenantId: TENANT, id: row.id, leadRecordId: "lead-1", now: t2 }), "reserved");
    assert.equal(await setClaimEngagement(db, { tenantId: TENANT, id: row.id, leadRecordId: "lead-1", engagementId: "eng-1", now: t2 }), true);
    const claimed = (await getScan(db, TENANT, row.id))!;
    assert.equal(claimed.outcome, "claimed");
    assert.equal(claimed.engagementId, "eng-1");
    assert.equal(toView(claimed, t2).claimed, true);
    assert.equal((await latestScanForDomain(db, TENANT, "acme.example"))?.id, row.id);
    console.log("site-scan-store: ok");
  } finally {
    db.close();
    // Windows may still hold the file for a moment; a failed cleanup is not a failed test.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* temp dir left behind */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
