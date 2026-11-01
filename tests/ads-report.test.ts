import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { loadAdsReport } from "../lib/marketing/ads-report";

const db = createClient({ url: "file::memory:" });
const now = Date.parse("2026-11-01T12:00:00Z");
const a = "tenant-a";
const b = "tenant-b";
let checks = 0;
async function check(name: string, body: () => Promise<void>) {
  await body(); checks++; console.log(`ok ${name}`);
}
async function report() { return loadAdsReport(a, { db, now }); }
async function metric(input: { id?: string; source?: string; spend?: unknown; clicks?: unknown; conversions?: unknown; date?: string; captured?: string; tenant?: string } = {}) {
  await db.execute({ sql: "INSERT OR REPLACE INTO marketing_metric_daily VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [input.tenant ?? a, input.id ?? "creative-a", input.date ?? "2026-10-31", input.source ?? "meta_ads",
      input.spend === undefined ? "20" : input.spend as null, input.clicks === undefined ? 10 : input.clicks as null,
      input.conversions === undefined ? 2 : input.conversions as null, input.captured ?? "2026-11-01T11:00:00Z"] });
}
async function main() {
  await db.executeMultiple(`
    CREATE TABLE marketing_asset (tenant_id TEXT, id TEXT, channel TEXT, title TEXT, campaign TEXT, status TEXT, hook TEXT, body TEXT, updated_at TEXT, meta TEXT, PRIMARY KEY(tenant_id,id));
    CREATE TABLE marketing_metric_daily (tenant_id TEXT, asset_id TEXT, date TEXT, source TEXT, spend TEXT, clicks INTEGER, conversions INTEGER, captured_at TEXT, PRIMARY KEY(tenant_id,asset_id,date,source));
    INSERT INTO marketing_asset VALUES ('tenant-a','creative-a','paid-meta','Synthetic Alpha','Campaign A','draft','A test hook','Copy','2026-11-01','{"currency":"CAD","conversion_event":"lead"}');
    INSERT INTO marketing_asset VALUES ('tenant-a','organic','organic-instagram','Organic',NULL,'published',NULL,NULL,'2026-11-01','{"currency":"CAD"}');
    INSERT INTO marketing_asset VALUES ('tenant-b','creative-a','paid-meta','Other tenant',NULL,'published',NULL,NULL,'2026-11-01','{"currency":"USD"}');
  `);
  await check("saved creative without delivery evidence is unknown, not zero", async () => {
    const r = await report(); assert.equal(r.error, false); assert.equal(r.observations, 0);
    assert.equal(r.spend, null); assert.equal(r.clicks, null); assert.equal(r.conversions, null);
    assert.deepEqual(r.creatives.map((c) => c.title), ["Synthetic Alpha"]);
    assert.equal(r.from, "2026-10-26"); assert.equal(r.through, "2026-11-01");
  });
  await check("metrics and join are tenant scoped; organic, wrong sources and out-of-period rows are excluded", async () => {
    await metric(); await metric({ tenant: b, spend: "99999" }); await metric({ id: "organic", spend: "99999" });
    await metric({ source: "zernio", spend: "99999" }); await metric({ date: "2026-10-25", spend: "99999" });
    await metric({ date: "2026-11-02", spend: "99999" });
    const r = await report(); assert.equal(r.spend, 20); assert.equal(r.costPerClick, 2); assert.equal(r.clicks, 10);
    assert.equal(r.conversions, 2); assert.equal(r.conversionKind, "leads"); assert.equal(r.currency, "CAD");
    assert.equal(r.observations, 1); assert.equal(r.measuredAssets, 1); assert.equal(r.stale, false);
  });
  await check("duplicate imports of an asset/day use the latest observation once", async () => {
    await metric({ source: "meta", spend: "15", captured: "2026-11-01T10:00:00Z" });
    assert.equal((await report()).spend, 20);
    await metric({ source: "meta", spend: "25", captured: "2026-11-01T11:30:00Z" });
    assert.equal((await report()).spend, 25);
    await db.execute("DELETE FROM marketing_metric_daily WHERE source='meta'");
  });
  await check("null and malformed metric values never become zero or partial totals", async () => {
    for (const spend of [null, "", "bogus", "-10"]) {
      await metric({ spend }); const r = await report(); assert.equal(r.spend, null); assert.equal(r.costPerClick, null);
    }
    await metric({ clicks: null, conversions: null }); const r = await report();
    assert.equal(r.clicks, null); assert.equal(r.conversions, null); assert.equal(r.costPerClick, null);
  });
  await check("reported zero is kept but division by zero is unknown", async () => {
    await metric({ spend: "0", clicks: 0, conversions: 0 }); const r = await report();
    assert.equal(r.spend, 0); assert.equal(r.clicks, 0); assert.equal(r.conversions, 0); assert.equal(r.costPerClick, null);
  });
  await check("currency and conversion-event provenance are required", async () => {
    await db.execute("UPDATE marketing_asset SET meta='{}' WHERE tenant_id='tenant-a' AND id='creative-a'");
    await metric(); let r = await report(); assert.equal(r.spend, null); assert.equal(r.currency, null);
    assert.equal(r.conversionKind, "conversions"); assert.equal(r.conversions, 2);
    await db.execute("UPDATE marketing_asset SET meta='not JSON' WHERE tenant_id='tenant-a' AND id='creative-a'");
    r = await report(); assert.equal(r.error, false); assert.equal(r.currency, null);
  });
  await check("capture age and invalid timestamps cannot appear fresh", async () => {
    await metric({ captured: "2026-10-28T00:00:00Z" }); assert.equal((await report()).stale, true);
    await metric({ captured: "not a time" }); assert.equal((await report()).stale, true);
    await metric({ captured: "2026-12-01T00:00:00Z" }); assert.equal((await report()).stale, true);
  });
  await check("different account currencies are never added into a fake spend total", async () => {
    await db.execute("UPDATE marketing_asset SET meta='{\"currency\":\"CAD\"}' WHERE tenant_id='tenant-a' AND id='creative-a'");
    await db.execute("INSERT INTO marketing_asset VALUES ('tenant-a','usd','paid-meta','USD creative',NULL,'draft',NULL,NULL,'2026-11-01','{\"currency\":\"USD\"}')");
    await metric(); await metric({ id: "usd", spend: "10" });
    const r = await report(); assert.equal(r.currency, null); assert.equal(r.spend, null); assert.equal(r.costPerClick, null);
    assert.equal(r.clicks, 20); assert.equal(r.measuredAssets, 2);
  });
  await check("an empty tenant refuses before any SQL", async () => {
    let calls = 0;
    const fake = { execute: async () => { calls++; throw new Error("must not query"); } };
    assert.equal((await loadAdsReport("", { db: fake, now })).error, true); assert.equal(calls, 0);
  });
  await check("query failure is unavailable rather than an empty or zero report", async () => {
    const r = await loadAdsReport(a, { db: { execute: async () => { throw new Error("synthetic DB outage"); } }, now });
    assert.equal(r.error, true); assert.equal(r.spend, null); assert.equal(r.conversions, null);
  });
  db.close(); console.log(`ads-report: ${checks} checks passed`);
}
main().catch((error) => { db.close(); console.error(error); process.exitCode = 1; });
