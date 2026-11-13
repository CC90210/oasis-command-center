/**
 * tests/site-scan-metrics.test.ts — the founders' free-scan page numbers (lib/site-scan/metrics.ts)
 * on a throwaway local libSQL file: totals, visitors by hashed address, the 30-day series with
 * empty days present, kinds of business, recent rows with their live-step counts, and a database
 * without the live feed's table. No network.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-metrics.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { appendEvents, cleanEvent } from "../lib/site-scan/events";
import { dayRange, scanMetrics } from "../lib/site-scan/metrics";
import { insertScan, reserveClaim, saveEnrich, saveTier0, setStatus } from "../lib/site-scan/store";
import { ENRICH_SCHEMA, FACTS_SCHEMA, NARRATIVE_SCHEMA, SCORE_SCHEMA, type ScanFacts, type ScanNarrative, type ScanScore } from "../lib/site-scan/types";

const ROOT = join(__dirname, "..");
const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

const facts = (domain: string): ScanFacts => ({
  schema: FACTS_SCHEMA,
  domain,
  start_url: `https://${domain}/`,
  final_url: `https://${domain}/`,
  read_at: "2026-11-12T10:00:00.000Z",
  site: { unread: null, pages_read: 2, notes: [], https_served: true, response_ms: 300, html_kb: 40 },
  checks: [],
  pagespeed: null,
  signals: null,
});
const score = (total: number | null): ScanScore => ({ schema: SCORE_SCHEMA, total, pillars: [], fixes: [] });
const narrative: ScanNarrative = { schema: NARRATIVE_SCHEMA, source: "template", what_you_sell: "x", who_buys: "x", competitors_note: null, fixes_intro: "x", email: null };

async function scan(db: Client, domain: string, ip: string | null, now: Date, total: number | null) {
  const { row } = await insertScan(db, { tenantId: TENANT, domain, url: `https://${domain}/`, ipHash: ip, now });
  await saveTier0(db, { tenantId: TENANT, id: row.id, facts: facts(domain), score: score(total), narrative, status: "enriching", stage: "profile", now });
  return row.id;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "site-scan-metrics-"));
  const db = createClient({ url: `file:${join(dir, "t.db")}` });
  try {
    for (const f of ["bravo__206_tool_jobs.sql", "bravo__259_site_scans.sql", "bravo__260_site_scan_events.sql"]) {
      await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", f), "utf8"));
    }
    const now = new Date("2026-11-12T18:00:00.000Z");
    const a = await scan(db, "plumber-one.ca", "ip1", new Date("2026-11-12T15:00:00.000Z"), 70);
    const b = await scan(db, "garden-two.ca", "ip1", new Date("2026-11-10T15:00:00.000Z"), 50);
    const c = await scan(db, "bakery-three.ca", "ip2", new Date("2026-10-20T15:00:00.000Z"), null);
    await setStatus(db, { tenantId: TENANT, id: c, status: "failed", stage: "read", errorCode: "read_failed", now });
    await saveEnrich(db, {
      tenantId: TENANT,
      id: a,
      enrich: { schema: ENRICH_SCHEMA, engine: { embedder: "t", version: "1.2.0" }, category: { key: "plumbing_hvac", label: "Plumbing, heating and HVAC", confidence: 0.9 }, keywords: [], segments: [], competitors: [{ name: "P1", domain: null, locality: null }, { name: "P2", domain: null, locality: null }], prospects: [], email_auth: null, notes: [] },
      narrative: null,
      embedding: null,
      now,
    });
    await reserveClaim(db, { tenantId: TENANT, id: a, leadRecordId: "lead-1", now });
    await appendEvents(db, { tenantId: TENANT, scanId: a, source: "worker", events: [cleanEvent({ kind: "page", text: "Read /", at: now.toISOString() })!, cleanEvent({ kind: "done", text: "Report ready", at: now.toISOString() })!] });
    // Another workspace's scan never counts.
    await insertScan(db, { tenantId: "other", domain: "elsewhere.ca", url: "https://elsewhere.ca/", ipHash: "ip9", now });

    const m = await scanMetrics(db, TENANT, now);
    assert.deepEqual(
      { scans: m.totals.scans, sites: m.totals.sites, visitors: m.totals.visitors, last24h: m.totals.last24h, last7d: m.totals.last7d, claimed: m.totals.claimed, failed: m.totals.failed, matched: m.totals.matched, avgScore: m.totals.avgScore },
      { scans: 3, sites: 3, visitors: 2, last24h: 1, last7d: 2, claimed: 1, failed: 1, matched: 1, avgScore: 60 },
    );
    assert.equal(m.days.length, 30);
    assert.equal(m.days[29].day, "2026-11-12");
    assert.deepEqual(m.days[29], { day: "2026-11-12", scans: 1, claimed: 1 });
    assert.deepEqual(m.days[27], { day: "2026-11-10", scans: 1, claimed: 0 });
    assert.equal(m.days[28].scans, 0, "an empty day is present, not skipped");
    assert.deepEqual(m.categories, [{ label: "Plumbing, heating and HVAC", scans: 1 }]);
    assert.deepEqual(m.recent.map((r) => r.domain), ["plumber-one.ca", "garden-two.ca", "bakery-three.ca"]);
    const top = m.recent[0];
    assert.deepEqual({ score: top.score, competitors: top.competitors, engine: top.engine, steps: top.steps, lead: top.leadRecordId, outcome: top.outcome }, { score: 70, competitors: 2, engine: "1.2.0", steps: 2, lead: "lead-1", outcome: "claimed" });
    assert.equal(m.recent[2].errorCode, "read_failed");
    assert.equal(m.recent[2].score, null);
    assert.equal(b.length > 0, true);

    // Without bravo__260 the page still reads; live steps are simply unknown.
    const old = createClient({ url: `file:${join(dir, "old.db")}` });
    await old.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__259_site_scans.sql"), "utf8"));
    await insertScan(old, { tenantId: TENANT, domain: "x.ca", url: "https://x.ca/", ipHash: null, now });
    const om = await scanMetrics(old, TENANT, now);
    assert.equal(om.totals.scans, 1);
    assert.equal(om.recent[0].steps, null);
    old.close();

    assert.deepEqual(dayRange(new Date("2026-03-02T01:00:00.000Z"), 3), ["2026-02-28", "2026-03-01", "2026-03-02"]);
    console.log("site-scan-metrics: ok");
  } finally {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a just-closed libSQL file a moment longer; the OS clears tmp.
    }
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
