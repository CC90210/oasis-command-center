import assert from "node:assert/strict";

// Phase 4 of the SunBiz multi-employee personalization plan (2026-05-29):
// the per-user Gmail OAuth path must NEVER apply to SMS / Kixie / Stripe.
// This is a pure-logic regression lock on the scope tagging in the
// integration-schemas registry: gmail_oauth is the only entry with
// scope="user_only" today; everything else (TextTorrent, Kixie, Stripe)
// stays tenant-scoped and uses Matt's shared API keys regardless of
// which employee is acting.

import { INTEGRATION_SCHEMAS } from "../lib/tenant-integration-schemas";
import {
  TEXTTORRENT_FROM_NUMBER_FIELD,
  pickTextTorrentSenderId,
} from "../lib/integrations/texttorrent-sender-core";

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

// Case 4 — per-agent TextTorrent number (2026-06-24). The tenant texttorrent
// schema keeps a `from_number` field (now the "Default Business Number" / owner
// fallback used for automated Helios sends); the per-rep override lives in
// user_integration_credentials under TEXTTORRENT_FROM_NUMBER_FIELD.
const tt = getIntegrationSchema("texttorrent");
assert.ok(tt, "texttorrent schema must exist");
const ttFrom = tt.fields.find((f) => f.key === "from_number");
assert.ok(ttFrom, "texttorrent schema must keep a from_number (tenant default) field");
assert.equal(ttFrom.validation, "phone_e164", "texttorrent from_number must validate E.164");
assert.equal(
  TEXTTORRENT_FROM_NUMBER_FIELD,
  "texttorrent_from_number",
  "per-user TT field key is the contract between the route, the panel, and the resolver",
);

// Case 5 — sender precedence ladder: rep's own number → tenant default →
// undefined (TT account default). Whitespace-only values count as unset.
assert.equal(
  pickTextTorrentSenderId("+15551112222", "+19998887777"),
  "+15551112222",
  "the rep's own number wins when set (manual send from their own line)",
);
assert.equal(
  pickTextTorrentSenderId(null, "+19998887777"),
  "+19998887777",
  "falls back to the tenant default (owner number) when the rep has none — the automated/Helios case",
);
assert.equal(
  pickTextTorrentSenderId("   ", "+19998887777"),
  "+19998887777",
  "whitespace-only rep number is treated as unset",
);
assert.equal(
  pickTextTorrentSenderId(undefined, undefined),
  undefined,
  "no rep number and no tenant default → undefined (TT account default applies)",
);
assert.equal(
  pickTextTorrentSenderId("  +15551112222  ", null),
  "+15551112222",
  "a set rep number is trimmed",
);

console.log("ok user-credential-resolver");
