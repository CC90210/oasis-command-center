/** Actual importer in workerd; synthetic account, read-only provider fixture, no live network. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse, convertV4MiniflareOptions } from "miniflare";

async function main() {
  const version = readFileSync("lib/integrations/key-probes.ts", "utf8").match(/export const META_GRAPH_VERSION = "(v\d+\.\d+)"/)?.[1];
  assert.ok(version, "read the actual shared API version without loading unrelated connector probes");
  const bundled = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import { importMetaDelivery } from './lib/marketing/meta-import';
      const db = {
        execute: async () => ({ rows:[{id:'fixture-asset',external_id:'12345678901',meta:'{}'}] }),
        transaction: async () => { throw new Error('empty_or_failed_report_must_not_write'); }
      };
      export default { async fetch() {
        return Response.json(await importMetaDelivery('fixture-tenant', { db,
          now:new Date('2026-11-01T02:00:00Z'),
          credentials:async()=>({access_token:'synthetic-only',ad_account_id:'act_98765432101'})
        }));
      } };`, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022", external: ["node:*"],
    plugins: [{ name: "isolate-unused-storage", setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/integrations\/key-probes$/ }, () => ({ path: "meta-version", namespace: "fixture-version" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture-version" }, () => ({ contents: `export const META_GRAPH_VERSION = ${JSON.stringify(version)};` }));
      builder.onResolve({ filter: /^(server-only|@\/lib\/(turso|tenant-integration-store))$/ }, args => ({ path: args.path, namespace: "unused-storage" }));
      builder.onLoad({ filter: /.*/, namespace: "unused-storage" }, () => ({ contents: `
        const unavailable = () => { throw new Error('fixture_storage_unavailable'); };
        export { unavailable as getTursoClient, unavailable as getTenantIntegrationBundle };` }));
    } }],
  });
  let status = 200;
  let redirectInsights = false;
  const calls: string[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
    script: bundled.outputFiles[0].text,
    outboundService: async request => {
      calls.push(request.url);
      const url = new URL(request.url);
      assert.equal(url.origin, "https://graph.facebook.com");
      assert.ok([`/${version}/act_98765432101`, `/${version}/act_98765432101/insights`].includes(url.pathname));
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-only");
      assert.ok(!url.href.includes("synthetic-only"));
      const insights = url.pathname.endsWith("/insights");
      if (status !== 200 && (!redirectInsights || insights)) return new WorkerResponse(null, { status, headers: { location: "https://untrusted.example/collect" } });
      return new WorkerResponse(JSON.stringify(insights ? { data: [] } : { id: "act_98765432101", currency: "CAD", timezone_name: "America/Toronto" }));
    },
  }));
  try {
    const result = await (await mf.dispatchFetch("https://fixture.invalid")).json();
    assert.deepEqual(result, { ok: true, imported: 0, linkedAssets: 1, unlinkedAssets: 0, unmatchedRows: 0, from: "2026-10-25", through: "2026-10-31", currency: "CAD", timezone: "America/Toronto" });
    assert.equal(calls.length, 2);
    console.log("ok actual Meta importer reads account and empty report in workerd without inventing metrics");
    for (const redirect of [301, 302, 303, 307, 308]) {
      status = redirect;
      for (const afterAccount of [false, true]) {
        redirectInsights = afterAccount;
        const before = calls.length;
        const response = await mf.dispatchFetch("https://fixture.invalid");
        assert.deepEqual(await response.json(), { ok: false, error: "provider_rejected" });
        assert.equal(calls.length - before, afterAccount ? 2 : 1, "never follows Location or writes a failed report");
      }
    }
    console.log("ok every redirect at account or insights read is refused without forwarding the key");
    console.log("meta-worker-transport: 2 passed");
  } finally { await mf.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
