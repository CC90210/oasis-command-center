import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MARKETING_CONNECTION_SERVICES } from "../lib/founders/growth-shell";
import { probeMarketingCredential } from "../lib/integrations/credential-probes";
import { findIntegrationSchema } from "../lib/tenant-integration-schemas";

async function main() {
const expected = ["gws", "smtp", "twilio", "texttorrent", "late", "meta_ads", "google_ads"];
assert.deepEqual(MARKETING_CONNECTION_SERVICES, expected);
assert.equal(new Set(MARKETING_CONNECTION_SERVICES).size, expected.length);
for (const service of MARKETING_CONNECTION_SERVICES) {
  const schema = findIntegrationSchema(service);
  assert.ok(schema, `${service} has a closed schema`);
  assert.notEqual(schema.scope, "user_only", `${service} is tenant-scoped`);
}

const meta = findIntegrationSchema("meta_ads")!;
assert.equal(meta.fields.find((field) => field.key === "access_token")?.sensitive, true);
assert.equal(meta.fields.find((field) => field.key === "ad_account_id")?.sensitive, false);
const google = findIntegrationSchema("google_ads")!;
for (const key of ["developer_token", "client_id", "client_secret", "refresh_token"]) {
  assert.equal(google.fields.find((field) => field.key === key)?.sensitive, true, `${key} is masked`);
}
assert.equal(google.fields.find((field) => field.key === "login_customer_id")?.optional, true);

let smtpConfig: unknown;
const smtp = await probeMarketingCredential("smtp", {
  host: "smtp.example.test", port: "465", user: "mailer", password: "smtp-secret",
}, {
  fetch: async () => { throw new Error("SMTP probe must not fetch or send"); },
  verifySmtp: async (config) => { smtpConfig = config; return true; },
});
assert.equal(smtp?.ok, true);
assert.deepEqual(smtpConfig, {
  host: "smtp.example.test", port: 465, secure: true, user: "mailer", password: "smtp-secret",
});
assert.equal(JSON.stringify(smtp).includes("smtp-secret"), false);

const requests: Array<{ url: string; init?: RequestInit }> = [];
const queue = [
  new Response(JSON.stringify({ profiles: [] }), { status: 200 }),
  new Response(JSON.stringify({ id: "act_123" }), { status: 200 }),
  new Response(JSON.stringify({ access_token: "short-lived-token" }), { status: 200 }),
  new Response(JSON.stringify({ resourceNames: ["customers/1234567890"] }), { status: 200 }),
];
const mockFetch = async (input: URL | RequestInfo, init?: RequestInit) => {
  requests.push({ url: String(input), init });
  return queue.shift()!;
};
const deps = { fetch: mockFetch as typeof fetch, verifySmtp: async () => false };

const late = await probeMarketingCredential("late", { api_key: "late-secret" }, deps);
assert.equal(late?.ok, true);
assert.equal(requests[0].init?.method, "GET");
assert.equal(JSON.stringify(late).includes("late-secret"), false);

const metaProbe = await probeMarketingCredential("meta_ads", { access_token: "meta-secret", ad_account_id: "123" }, deps);
assert.equal(metaProbe?.ok, true);
assert.match(requests[1].url, /graph\.facebook\.com\/act_123/);
assert.equal(requests[1].init?.method, "GET");

const googleProbe = await probeMarketingCredential("google_ads", {
  developer_token: "developer-secret", customer_id: "123-456-7890", client_id: "client-id",
  client_secret: "client-secret", refresh_token: "refresh-secret", login_customer_id: "999-888-7777",
}, deps);
assert.equal(googleProbe?.ok, true);
assert.equal(requests[2].url, "https://oauth2.googleapis.com/token");
assert.equal(requests[3].url, "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers");
assert.equal((requests[3].init?.headers as Record<string, string>)["developer-token"], "developer-secret");
assert.equal((requests[3].init?.headers as Record<string, string>)["login-customer-id"], "9998887777");
assert.equal(JSON.stringify(googleProbe).includes("refresh-secret"), false);

let fetchCalled = false;
const missing = await probeMarketingCredential("google_ads", { customer_id: "123" }, {
  fetch: (async () => { fetchCalled = true; throw new Error("unexpected"); }) as typeof fetch,
  verifySmtp: async () => false,
});
assert.equal(missing?.ok, false);
assert.equal(fetchCalled, false);

const inaccessible = await probeMarketingCredential("google_ads", {
  developer_token: "secret", customer_id: "1234567890", client_id: "id", client_secret: "secret", refresh_token: "secret",
}, {
  fetch: (async (input: URL | RequestInfo) => String(input).includes("oauth2")
    ? new Response(JSON.stringify({ access_token: "token" }), { status: 200 })
    : new Response(JSON.stringify({ resourceNames: ["customers/0000000000"] }), { status: 200 })) as typeof fetch,
  verifySmtp: async () => false,
});
assert.equal(inaccessible?.error, "google_customer_not_accessible");

const root = join(__dirname, "..");
const page = readFileSync(join(root, "app/founders/growth/connections/page.tsx"), "utf8");
assert.match(page, /resolveFounder/);
assert.match(page, /MARKETING_CONNECTION_SERVICES/);
const testRoute = readFileSync(join(root, "app/api/integrations/keys/test/route.ts"), "utf8");
assert.match(testRoute, /canManageTenantIntegrations/);
assert.match(testRoute, /probeMarketingCredential/);

console.log("marketing-connections: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
