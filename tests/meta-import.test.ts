import { OASIS, CLIENT_A, USERS, setupDatabase, login, check, finish } from "./_delivery-harness";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.BRAVO_FIELD_ENCRYPTION_KEY = "meta-import-fixture-key-no-real-secrets";
delete process.env.OPERATOR_EMAIL;
delete process.env.ADMIN_EMAILS;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
const now = new Date("2026-11-01T02:00:00Z");
const token = "synthetic-meta-token-never-real";
const adId = "12345678901";
const accountId = "98765432101";
const credentials = async () => ({ access_token: token, ad_account_id: `act_${accountId}` });

async function main() {
  const db = await setupDatabase();
  await db.executeMultiple(`
    CREATE TABLE marketing_asset (tenant_id TEXT, id TEXT, channel TEXT, external_id TEXT, meta TEXT NOT NULL DEFAULT '{}', title TEXT DEFAULT 'Fixture', campaign TEXT, status TEXT DEFAULT 'draft', hook TEXT, body TEXT, updated_at TEXT, PRIMARY KEY(tenant_id,id));
    CREATE TABLE marketing_metric_daily (tenant_id TEXT, asset_id TEXT, date TEXT, source TEXT, impressions INTEGER, reach INTEGER, clicks INTEGER, spend TEXT, conversions INTEGER, captured_at TEXT, PRIMARY KEY(tenant_id,asset_id,date,source));
    CREATE TABLE tenant_integration_credentials (tenant_id TEXT, service TEXT, field_key TEXT, encrypted_value TEXT, PRIMARY KEY(tenant_id,service,field_key));
    CREATE TABLE platform_operators (auth_user_id TEXT, revoked_at TEXT);
  `);
  const { importMetaDelivery } = await import("../lib/marketing/meta-import");
  const { loadAdsReport } = await import("../lib/marketing/ads-report");
  const asset = async (id: string, tenant = OASIS, external: string | null = adId, meta: Record<string, unknown> = { conversion_event: "lead" }) => {
    await db.execute({ sql: "INSERT OR REPLACE INTO marketing_asset (tenant_id,id,channel,external_id,meta) VALUES (?,?,'paid-meta',?,?)", args: [tenant, id, external, JSON.stringify(meta)] });
  };
  let calls = 0;
  let amount = "12.50";
  let currency = "CAD";
  let timezone = "America/Toronto";
  let mode = "normal";
  let reportedAdId = adId;
  const fake: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${token}`);
    assert.ok(!url.toString().includes(token));
    if (mode === "outage") throw new Error(`synthetic failure with ${token}`);
    if (!url.pathname.endsWith("/insights")) return Response.json({ id: `act_${accountId}`, currency, timezone_name: timezone });
    assert.equal(url.searchParams.get("time_increment"), "1");
    const range = JSON.parse(url.searchParams.get("time_range")!);
    const row = { account_id: accountId, account_currency: currency, ad_id: reportedAdId, date_start: range.until, date_stop: range.until,
      impressions: "100", reach: "90", clicks: "5", spend: amount, actions: [{ action_type: "lead", value: "2" }, { action_type: "offsite_conversion.fb_pixel_lead", value: "2" }] };
    if (mode === "missing") return Response.json({ data: [{ ...row, clicks: undefined, spend: undefined, actions: undefined }] });
    if (mode === "invalid_currency") return Response.json({ data: [{ ...row, account_currency: "USD" }] });
    if (mode === "duplicate") return Response.json({ data: [row, row] });
    if (mode === "empty") return Response.json({ data: [] });
    if (mode === "mapping_race") await db.execute({ sql: "UPDATE marketing_asset SET external_id='55555555555' WHERE tenant_id=? AND id='a'", args: [OASIS] });
    if (url.searchParams.has("after")) return mode === "page_failure" ? new Response("refused", { status: 500 }) : Response.json({ data: [{ ...row, ad_id: "44444444444" }] });
    return Response.json({ data: [row], paging: { next: "https://attacker.invalid/steal", cursors: { after: "safe-cursor" } } });
  };
  const run = (date = now) => importMetaDelivery(OASIS, { db, now: date, credentials, fetch: fake });
  const rows = async () => (await db.execute({ sql: "SELECT * FROM marketing_metric_daily WHERE tenant_id=? ORDER BY asset_id,date", args: [OASIS] })).rows;
  await check("missing configuration and missing exact ad mappings do not call Meta or invent rows", async () => {
    assert.deepEqual(await importMetaDelivery(OASIS, { db, credentials: async () => ({}), fetch: fake }), { ok: false, error: "not_configured" });
    await asset("a", OASIS, "publisher-hex-id");
    assert.deepEqual(await run(), { ok: false, error: "no_linked_ads" });
    assert.equal(calls, 0); assert.equal((await rows()).length, 0);
  });
  await check("duplicate and conflicting stored ad IDs fail closed", async () => {
    await asset("a"); await asset("b");
    assert.deepEqual(await run(), { ok: false, error: "mapping_conflict" });
    await db.execute({ sql: "DELETE FROM marketing_asset WHERE tenant_id=? AND id='b'", args: [OASIS] });
    await asset("a", OASIS, adId, { platform_ad_id: "88888888888" });
    assert.deepEqual(await run(), { ok: false, error: "mapping_conflict" });
    assert.equal(calls, 0); await asset("a");
  });
  await check("daily GET import follows only safe cursors, joins exact tenant IDs, preserves source and account dates", async () => {
    await asset("other", CLIENT_A); await asset("unlinked", OASIS, null);
    const result = await run(); assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.imported, 1); assert.equal(result.unmatchedRows, 1); assert.equal(result.unlinkedAssets, 1);
    assert.equal(result.through, "2026-10-31"); assert.equal(result.from, "2026-10-25");
    const saved = await rows(); assert.equal(saved.length, 1); assert.equal(saved[0].asset_id, "a");
    assert.equal(saved[0].source, "meta_ads"); assert.equal(saved[0].spend, "12.50"); assert.equal(saved[0].conversions, 2, "overlapping lead actions never added");
    assert.equal(Number((await db.execute({ sql: "SELECT count(*) n FROM marketing_metric_daily WHERE tenant_id=?", args: [CLIENT_A] })).rows[0].n), 0);
    const report = await loadAdsReport(OASIS, { db, now: now.getTime() });
    assert.equal(report.spend, 12.5); assert.equal(report.through, result.through); assert.equal(report.reportingTimezone, timezone);
  });
  await check("retry refreshes one observation; older retries cannot replace newer measurements", async () => {
    amount = "20.00"; assert.ok((await run(new Date(now.getTime() + 60_000))).ok);
    assert.equal((await rows()).length, 1); assert.equal((await rows())[0].spend, "20.00");
    amount = "9.00"; assert.ok((await run()).ok); assert.equal((await rows())[0].spend, "20.00");
  });
  await check("provider outage, partial pagination failure and inconsistent data leave stored observations unchanged", async () => {
    const saved = JSON.stringify(await rows());
    for (const setting of ["outage", "page_failure", "invalid_currency", "duplicate"]) {
      mode = setting; const result = await run(); assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes(token)); assert.equal(JSON.stringify(await rows()), saved);
    }
    mode = "normal";
  });
  await check("currency/account timezone changes cannot relabel old observations", async () => {
    currency = "USD"; assert.deepEqual(await run(), { ok: false, error: "report_context_conflict" }); currency = "CAD";
    timezone = "America/Vancouver"; assert.deepEqual(await run(), { ok: false, error: "report_context_conflict" }); timezone = "America/Toronto";
    assert.equal((await rows())[0].spend, "20.00");
  });
  await check("conversion definition changes cannot relabel historical lead measurements", async () => {
    await db.execute({ sql: "UPDATE marketing_asset SET meta=json_set(meta,'$.conversion_event','purchase') WHERE tenant_id=? AND id='a'", args: [OASIS] });
    assert.deepEqual(await run(), { ok: false, error: "report_context_conflict" });
    const report = await loadAdsReport(OASIS, { db, now: now.getTime() }); assert.equal(report.conversionKind, "leads");
    await db.execute({ sql: "UPDATE marketing_asset SET meta=json_set(meta,'$.conversion_event','lead') WHERE tenant_id=? AND id='a'", args: [OASIS] });
  });
  await check("relinking an ad cannot mix old and new delivery history or adopt unprovenanced rows", async () => {
    const before = JSON.stringify(await rows());
    const storedMeta = String((await db.execute({ sql: "SELECT meta FROM marketing_asset WHERE tenant_id=? AND id='a'", args: [OASIS] })).rows[0].meta);
    assert.equal(JSON.parse(storedMeta).ads_imported_ad_id, adId);
    reportedAdId = "22222222222";
    await db.execute({ sql: "UPDATE marketing_asset SET external_id=? WHERE tenant_id=? AND id='a'", args: [reportedAdId, OASIS] });
    assert.deepEqual(await run(new Date(now.getTime() + 120_000)), { ok: false, error: "report_context_conflict" });
    assert.equal(JSON.stringify(await rows()), before);
    reportedAdId = adId;
    await db.execute({ sql: "UPDATE marketing_asset SET external_id=?,meta=json_remove(meta,'$.ads_imported_ad_id') WHERE tenant_id=? AND id='a'", args: [adId, OASIS] });
    assert.deepEqual(await run(), { ok: false, error: "report_context_conflict" });
    assert.equal(JSON.stringify(await rows()), before);
    await db.execute({ sql: "UPDATE marketing_asset SET meta=? WHERE tenant_id=? AND id='a'", args: [storedMeta, OASIS] });
  });
  await check("missing optional metrics stay unknown; empty delivery does not create zero rows", async () => {
    mode = "missing"; assert.ok((await run(new Date(now.getTime() + 120_000))).ok);
    assert.equal((await rows())[0].spend, null); assert.equal((await rows())[0].clicks, null); assert.equal((await rows())[0].conversions, null);
    mode = "empty"; const result = await run(); assert.ok(result.ok); assert.equal(result.imported, 0); assert.equal((await rows()).length, 1);
    mode = "normal";
  });
  await check("explicit zero lead/purchase counts remain zero; omitted actions remain unknown", async () => {
    const tenant = "meta-actions-fixture";
    try {
      for (const event of ["lead", "purchase"]) {
        await asset("conversion", tenant, adId, { conversion_event: event });
        for (const actions of [[{ action_type: event, value: "0" }], [{ action_type: "link_click", value: "5" }], [], undefined]) {
          const response: typeof fetch = async input => new URL(String(input)).pathname.endsWith("/insights")
            ? Response.json({ data: [{ account_id: accountId, account_currency: currency, ad_id: adId,
              date_start: "2026-10-31", date_stop: "2026-10-31", actions }] })
            : Response.json({ id: `act_${accountId}`, currency, timezone_name: timezone });
          assert.ok((await importMetaDelivery(tenant, { db, now, credentials, fetch: response })).ok);
          const saved = (await db.execute({ sql: "SELECT conversions FROM marketing_metric_daily WHERE tenant_id=?", args: [tenant] })).rows;
          assert.equal(saved.length, 1);
          assert.equal(saved[0].conversions, actions?.[0]?.action_type === event ? 0 : null);
        }
        await db.execute({ sql: "DELETE FROM marketing_metric_daily WHERE tenant_id=?", args: [tenant] });
      }
    } finally {
      await db.execute({ sql: "DELETE FROM marketing_metric_daily WHERE tenant_id=?", args: [tenant] });
      await db.execute({ sql: "DELETE FROM marketing_asset WHERE tenant_id=?", args: [tenant] });
    }
  });
  await check("creative changes during fetch abort the whole write", async () => {
    const before = JSON.stringify(await rows()); mode = "mapping_race";
    assert.deepEqual(await run(), { ok: false, error: "mapping_changed" });
    assert.equal(JSON.stringify(await rows()), before); mode = "normal";
    await db.execute({ sql: "UPDATE marketing_asset SET external_id=? WHERE tenant_id=? AND id='a'", args: [adId, OASIS] });
  });
  await check("500 ads across seven days use 13 transaction data calls and a late mapping conflict rolls back earlier updates", async () => {
    const tenant = "meta-batch-fixture";
    const bulk = Array.from({ length: 500 }, (_, i) => ({ id: `bulk-${i}`, adId: String(70000000000 + i) }));
    const counts = { execute: 0, batches: [] as number[] };
    const monitored = new Proxy(db, {
      get(target, key) {
        if (key === "transaction") return async (...args: Parameters<typeof db.transaction>) => {
          const tx = await target.transaction(...args);
          return new Proxy(tx, {
            get(transaction, property) {
              if (property === "execute") return (...statements: Parameters<typeof tx.execute>) => {
                counts.execute++; return transaction.execute(...statements);
              };
              if (property === "batch") return (...statements: Parameters<typeof tx.batch>) => {
                counts.batches.push(statements[0].length); return transaction.batch(...statements);
              };
              const value = Reflect.get(transaction, property);
              return typeof value === "function" ? value.bind(transaction) : value;
            },
          });
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let changeLastMapping = false;
    const bulkFetch: typeof fetch = async input => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/insights")) return Response.json({ id: `act_${accountId}`, currency, timezone_name: timezone });
      if (changeLastMapping) await db.execute({ sql: "UPDATE marketing_asset SET external_id='99999999999' WHERE tenant_id=? AND id='bulk-499'", args: [tenant] });
      const page = Number(url.searchParams.get("after") ?? 0);
      const day = `2026-10-${25 + page}`;
      return Response.json({ data: bulk.map(item => ({ account_id: accountId, account_currency: currency, ad_id: item.adId,
        date_start: day, date_stop: day, impressions: "10", spend: "1.00" })),
        ...(page < 6 ? { paging: { next: "https://graph.facebook.com/unused", cursors: { after: String(page + 1) } } } : {}) });
    };
    const importBulk = () => importMetaDelivery(tenant, { db: monitored, now, credentials, fetch: bulkFetch });
    try {
      await db.batch(bulk.map(item => ({ sql: "INSERT INTO marketing_asset (tenant_id,id,channel,external_id,meta) VALUES (?,?,'paid-meta',?,'{}')", args: [tenant, item.id, item.adId] })));
      const first = await importBulk(); assert.ok(first.ok); assert.equal(first.imported, 3500);
      assert.equal(counts.execute, 1, "history is read together within the transaction");
      assert.equal(counts.batches.length, 12, "500 metadata updates and the maximum 3,500 daily rows take twelve bounded batches");
      assert.ok(counts.batches.slice(0, 5).every(size => size <= 100));
      assert.ok(counts.batches.slice(5).every(size => size <= 500));
      assert.equal(Number((await db.execute({ sql: "SELECT count(*) n FROM marketing_metric_daily WHERE tenant_id=?", args: [tenant] })).rows[0].n), 3500);
      // Reset only this synthetic tenant; a conflict in the final update batch
      // must roll back the provenance already written for the first 400 ads.
      await db.execute({ sql: "DELETE FROM marketing_metric_daily WHERE tenant_id=?", args: [tenant] });
      await db.execute({ sql: "UPDATE marketing_asset SET meta='{}' WHERE tenant_id=?", args: [tenant] });
      changeLastMapping = true; counts.execute = 0; counts.batches = [];
      assert.deepEqual(await importBulk(), { ok: false, error: "mapping_changed" });
      assert.equal(counts.execute, 1); assert.equal(counts.batches.length, 5);
      assert.equal(Number((await db.execute({ sql: "SELECT count(*) n FROM marketing_asset WHERE tenant_id=? AND meta<>'{}'", args: [tenant] })).rows[0].n), 0);
      assert.equal(Number((await db.execute({ sql: "SELECT count(*) n FROM marketing_metric_daily WHERE tenant_id=?", args: [tenant] })).rows[0].n), 0);
    } finally {
      await db.execute({ sql: "DELETE FROM marketing_metric_daily WHERE tenant_id=?", args: [tenant] });
      await db.execute({ sql: "DELETE FROM marketing_asset WHERE tenant_id=?", args: [tenant] });
    }
  });
  await check("mixed reporting timezones are not presented as one comparable total", async () => {
    await asset("zone-b", OASIS, "33333333333", { currency: "CAD", ads_reporting_timezone: "America/Vancouver" });
    await db.execute({ sql: "INSERT INTO marketing_metric_daily (tenant_id,asset_id,date,source,spend,captured_at) VALUES (?,'zone-b','2026-10-31','meta_ads','50',?)", args: [OASIS, now.toISOString()] });
    const report = await loadAdsReport(OASIS, { db, now: now.getTime() }); assert.equal(report.error, true); assert.equal(report.spend, null);
    await db.execute({ sql: "DELETE FROM marketing_metric_daily WHERE tenant_id=? AND asset_id='zone-b'", args: [OASIS] });
    await db.execute({ sql: "DELETE FROM marketing_asset WHERE tenant_id=? AND id='zone-b'", args: [OASIS] });
  });
  await check("API gates before credentials, rejects browser tenant overrides and uses only session tenant encrypted credentials", async () => {
    const { POST } = await import("../app/api/marketing/ads/import/route");
    const request = (body?: object, query = "") => new NextRequest(`https://fixture.test/api/marketing/ads/import${query}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
    const originalFetch = globalThis.fetch; globalThis.fetch = fake;
    const before = calls;
    try {
      await login(null); assert.equal((await POST(request())).status, 401);
      for (const user of [USERS.rep, USERS.admin, USERS.clientA, USERS.formerOperator]) { await login(user); assert.equal((await POST(request())).status, 403); }
      await login(USERS.cc);
      assert.equal((await POST(request({ tenantId: CLIENT_A }))).status, 400);
      assert.equal((await POST(request(undefined, `?tenantId=${CLIENT_A}`))).status, 400);
      assert.equal((await POST(new NextRequest("https://fixture.test/api/marketing/ads/import", { method: "POST", headers: { Origin: "https://attacker.invalid" } }))).status, 400);
      const { encryptField } = await import("../lib/field-encryption");
      for (const [field, value] of Object.entries(await credentials())) await db.execute({ sql: "INSERT INTO tenant_integration_credentials VALUES (?,'meta_ads',?,?)", args: [CLIENT_A, field, encryptField(value)] });
      assert.equal((await POST(request())).status, 409, "another tenant's configured token is not used");
      assert.equal((await POST(new NextRequest("https://fixture.test/api/marketing/ads/import", { method: "POST", headers: { "X-Tenant-ID": CLIENT_A } }))).status, 409, "a forged tenant header cannot select another credential");
      assert.equal(calls, before);
      for (const [field, value] of Object.entries(await credentials())) await db.execute({ sql: "INSERT INTO tenant_integration_credentials VALUES (?,'meta_ads',?,?)", args: [OASIS, field, encryptField(value)] });
      const response = await POST(request()); assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      assert.equal((await response.json()).ok, true); assert.ok(calls > before);
    } finally { globalThis.fetch = originalFetch; }
  });
  db.close(); finish("meta-import");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
