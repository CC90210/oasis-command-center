/** Actual workerd + actual Quo helpers, synthetic account and intercepted outbound only. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, Response as WorkerResponse, convertV4MiniflareOptions } from "miniflare";

async function main() {
  // The helpers under test execute unchanged in workerd. Unused storage imports
  // fail if reached; this fixture has no production database, credential or network.
  const bundled = await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import { discoverQuoNumbers } from './lib/integrations/quo-setup';
      import { verifyQuoWebhookProvider } from './lib/integrations/quo-webhook';
      const config = { tenantId:'fixture', apiKey:'synthetic-only', signingKey:'unused', orgId:'ORfixture', phoneNumberId:'PNfixture', fromNumber:'+14165550100', webhookId:'123' };
      export default { async fetch(request) {
        try {
          const value = new URL(request.url).pathname === '/discovery'
            ? await discoverQuoNumbers({ tenantId:'fixture', credentials:async()=>config })
            : await verifyQuoWebhookProvider(config, 'https://oasisai.work', 1793534400);
          return Response.json({ok:true,value});
        } catch(error) { return Response.json({ok:false,error:error.code || error.message}, {status:503}); }
      } };`, loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "node", target: "es2022", external: ["node:*"],
    plugins: [{ name: "isolate-unused-storage", setup(builder) {
      builder.onResolve({ filter: /^(server-only|@\/lib\/(field-encryption|integrations\/quo|tenant-integration-store|tenant\/retired|sms-opt-out))$/ }, args => ({ path: args.path, namespace: "unused-storage" }));
      builder.onLoad({ filter: /.*/, namespace: "unused-storage" }, () => ({ contents: `
        const unavailable = () => { throw new Error('fixture_storage_unavailable'); };
        export { unavailable as decryptField, unavailable as encryptField, unavailable as getQuoCredentials,
          unavailable as readTenantCredentialStrict, unavailable as isRetiredTenant,
          unavailable as applyInboundSmsStopInTransaction, unavailable as isStopCommand };` }));
    } }],
  });
  let status = 200;
  const calls: string[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
    script: bundled.outputFiles[0].text,
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push(request.url);
      assert.equal(url.origin, "https://api.quo.com");
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "synthetic-only");
      assert.equal(request.headers.get("quo-api-version"), "2026-03-30");
      if (status !== 200) return new WorkerResponse(null, { status, headers: { location: "https://untrusted.example/collect" } });
      let data: unknown;
      if (url.pathname === "/phone-numbers") {
        assert.equal(url.search, "?limit=50&include=restrictions");
        return new WorkerResponse(JSON.stringify({ data: [{ id: "PNfixture", phoneNumber: "+14165550100" }], nextCursor: null }));
      }
      if (url.pathname === "/webhooks/123") data = { id: "123", orgId: "ORfixture", status: "enabled", apiVersion: "2026-03-30", url: "https://oasisai.work/api/webhooks/quo/fixture", events: ["message.received"], resourceIds: ["PNfixture"], updatedAt: "2026-10-31T12:00:00Z" };
      else if (url.pathname === "/phone-numbers/PNfixture") data = { id: "PNfixture", phoneNumber: "+14165550100" };
      else {
        assert.equal(url.pathname, "/webhooks/123/events");
        assert.equal(url.searchParams.get("eventType"), "message.received");
        assert.equal(url.searchParams.get("limit"), "1");
        assert.ok(["pending", "sending", "failed"].includes(url.searchParams.get("status")!));
        data = [];
      }
      return new WorkerResponse(JSON.stringify({ data }));
    },
  }));
  try {
    const discovery = await mf.dispatchFetch("https://fixture.invalid/discovery");
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json() as { value: unknown }).value, [{ id: "PNfixture", number: "+14165550100", name: "", messaging: { CA: "unknown", US: "unknown", Intl: "unknown" } }]);
    assert.equal(calls.length, 1);
    const verification = await mf.dispatchFetch("https://fixture.invalid/verify");
    assert.deepEqual(await verification.json(), { ok: true, value: "ready" });
    assert.equal(calls.length, 6);
    console.log("ok actual Quo discovery and provider verification execute in workerd");
    for (const redirect of [301, 302, 303, 307, 308]) {
      status = redirect;
      for (const [path, expected, count] of [["discovery", "provider_unavailable", 1], ["verify", "quo_webhook_provider_unavailable", 5]] as const) {
        const before = calls.length;
        const response = await mf.dispatchFetch(`https://fixture.invalid/${path}`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { ok: false, error: expected });
        assert.equal(calls.length - before, count, "only the initial fixed-host requests, never Location");
      }
    }
    console.log("ok 301/302/303/307/308 fail closed in workerd without following Location");
    console.log("quo-worker-transport: 2 passed");
  } finally { await mf.dispose(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
