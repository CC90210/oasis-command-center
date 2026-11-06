import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { VAULT_SERVICE_DEFINITIONS } from "../lib/credential-vault/catalog";
import { checkVaultService } from "../lib/credential-vault/service-checks";

async function main() {
  assert.deepEqual(VAULT_SERVICE_DEFINITIONS.map((item) => item.id), ["shopify", "wise", "higgsfield"]);

  let calls = 0;
  const missing = await checkVaultService(VAULT_SERVICE_DEFINITIONS[0], {}, {
    now: new Date("2026-10-13T12:00:00.000Z"),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  });
  assert.equal(missing.state, "not_configured");
  assert.equal(calls, 0);
  assert.deepEqual(missing.present, { SHOPIFY_STORE_DOMAIN: false, SHOPIFY_STOREFRONT_ACCESS_TOKEN: false });

  const secret = "shpat_secret_never_serialize";
  let shopifyRequest: { url: string; init?: RequestInit } | null = null;
  const shopify = await checkVaultService(
    VAULT_SERVICE_DEFINITIONS[0],
    { shopify_store_domain: "example.myshopify.com", shopify_storefront_access_token: secret },
    {
      fetchImpl: async (input, init) => {
        shopifyRequest = { url: String(input), init };
        return new Response(JSON.stringify({ data: { shop: { name: "Example Shop" } } }), { status: 200 });
      },
    },
  );
  assert.equal(shopify.state, "connected");
  assert.equal(shopifyRequest?.url, "https://example.myshopify.com/api/2026-10/graphql.json");
  assert.equal(new Headers(shopifyRequest?.init?.headers).get("X-Shopify-Storefront-Access-Token"), secret);
  assert.equal(JSON.stringify(shopify).includes(secret), false);

  let wiseAuthorization = "";
  const wiseUrls: string[] = [];
  const wise = await checkVaultService(VAULT_SERVICE_DEFINITIONS[1], { wise_api_token: "wise_secret" }, {
    fetchImpl: async (input, init) => {
      wiseUrls.push(String(input));
      wiseAuthorization = new Headers(init?.headers).get("Authorization") || "";
      return new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
    },
  });
  assert.equal(wise.state, "connected");
  assert.deepEqual(wiseUrls, ["https://api.wise.com/2026Q4/profiles"]);
  assert.equal(wiseAuthorization, "Bearer wise_secret");
  assert.equal(JSON.stringify(wise).includes("wise_secret"), false);

  const wiseFallbackUrls: string[] = [];
  const wiseFallback = await checkVaultService(VAULT_SERVICE_DEFINITIONS[1], { wise_api_token: "wise_secret" }, {
    fetchImpl: async (input) => {
      wiseFallbackUrls.push(String(input));
      return String(input).includes("api.wise.com")
        ? new Response(JSON.stringify({ error: "not supported" }), { status: 404 })
        : new Response(JSON.stringify([{ id: 1 }]), { status: 200 });
    },
  });
  assert.equal(wiseFallback.state, "connected");
  assert.deepEqual(wiseFallbackUrls, ["https://api.wise.com/2026Q4/profiles", "https://api.transferwise.com/v2/profiles"]);

  let higgsAuthorization = "";
  const higgsfield = await checkVaultService(VAULT_SERVICE_DEFINITIONS[2], { higgsfield_api_key: "id:secret" }, {
    fetchImpl: async (_input, init) => {
      higgsAuthorization = new Headers(init?.headers).get("Authorization") || "";
      return new Response(JSON.stringify({ detail: "not found" }), { status: 404 });
    },
  });
  assert.equal(higgsfield.state, "connected");
  assert.equal(higgsAuthorization, "Key id:secret");
  assert.equal(JSON.stringify(higgsfield).includes("id:secret"), false);

  const ambiguousNotFound = await checkVaultService(VAULT_SERVICE_DEFINITIONS[2], { higgsfield_api_key: "id:secret" }, {
    fetchImpl: async () => new Response("upstream route missing", { status: 404 }),
  });
  assert.equal(ambiguousNotFound.state, "error", "a generic 404 does not prove Higgsfield authenticated the key");

  const refused = await checkVaultService(VAULT_SERVICE_DEFINITIONS[2], { higgsfield_api_key: "bad-secret" }, {
    fetchImpl: async () => new Response(JSON.stringify({ detail: "bad-secret was invalid" }), { status: 401 }),
  });
  assert.equal(refused.state, "error");
  assert.equal(JSON.stringify(refused).includes("bad-secret"), false);

  const route = await readFile(new URL("../app/api/credentials/custom/status/route.ts", import.meta.url), "utf8");
  assert.match(route, /getTenantIntegrationBundleStrict\(session\.tenantId, VAULT_CUSTOM_SERVICE\)/);
  assert.doesNotMatch(route, /process\.env|encrypted_value|decryptField/);
  assert.match(route, /vault_unavailable/);

  const ui = await readFile(new URL("../components/settings/CustomCredentialsVault.tsx", import.meta.url), "utf8");
  assert.match(ui, /\/api\/credentials\/custom\/status/);
  assert.match(ui, /Test connection/);
  assert.doesNotMatch(ui, /window\.(SHOPIFY|WISE|HIGGSFIELD)/);

  console.log("credential-vault-status: all checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
