import assert from "node:assert/strict";

// Phase 4 of the SunBiz multi-employee personalization plan (2026-05-29):
// the per-user Gmail OAuth path must NEVER apply to SMS / Kixie / Stripe.
// This is a pure-logic regression lock on the scope tagging in the
// integration-schemas registry: gmail_oauth is the only entry with
// scope="user_only" today; everything else (TextTorrent, Kixie, Stripe)
// stays tenant-scoped and uses Ezra's shared API keys regardless of
// which employee is acting.

import { INTEGRATION_SCHEMAS } from "../lib/tenant-integration-schemas";

function getIntegrationSchema(service: string) {
  return INTEGRATION_SCHEMAS.find((s) => s.service === service);
}

// Case 1 — gmail_oauth is registered and tagged user_only.
const gmail = getIntegrationSchema("gmail_oauth");
assert.ok(gmail, "gmail_oauth schema must exist");
assert.equal(gmail.scope, "user_only", "gmail_oauth must be scope=user_only");
assert.ok(
  gmail.fields.some((f) => f.key === "refresh_token"),
  "gmail_oauth schema must include refresh_token field",
);
assert.ok(
  gmail.fields.some((f) => f.key === "access_token"),
  "gmail_oauth schema must include access_token field",
);
assert.ok(
  gmail.fields.some((f) => f.key === "gmail_address"),
  "gmail_oauth schema must include gmail_address field",
);

// Case 2 — TextTorrent / Kixie / Stripe are NOT user-scoped. Even if
// the schemas table grows, none of the historically-tenant integrations
// should ever flip to user_only without an explicit migration.
const tenantOnlyServices = ["texttorrent", "kixie", "stripe"];
for (const svc of tenantOnlyServices) {
  const s = getIntegrationSchema(svc);
  if (!s) continue; // schema doesn't exist in this env — that's fine
  assert.notEqual(
    s.scope,
    "user_only",
    `service '${svc}' must stay tenant-scoped, never user_only`,
  );
}

// Case 3 — registry has at least one user_only scope (sanity check
// that the new scope field is actually populated, not just typed).
const userOnly = INTEGRATION_SCHEMAS.filter((s) => s.scope === "user_only");
assert.ok(
  userOnly.length >= 1,
  "at least one integration must be scope=user_only (gmail_oauth)",
);

console.log("ok user-credential-resolver");
