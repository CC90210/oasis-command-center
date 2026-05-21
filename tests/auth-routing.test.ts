import assert from "node:assert/strict";
import {
  homePathForTenant,
  normalizePostLoginRedirect,
} from "@/lib/auth-routing";

assert.equal(
  normalizePostLoginRedirect("/t/sun/leads", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/",
  "OASIS users must not be dropped into SunBiz after login",
);

assert.equal(
  normalizePostLoginRedirect("/t/sun/leads", {
    tenantSlug: "submissions",
    commandCenterProfileSlug: "sun",
  }),
  "/t/sun/leads",
  "SunBiz users can keep their own tenant deep link",
);

assert.equal(
  normalizePostLoginRedirect("/pipeline", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/pipeline",
  "Non-tenant app links should survive login",
);

assert.equal(
  normalizePostLoginRedirect("https://evil.example/t/sun", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/",
  "External redirects are rejected",
);

assert.equal(
  normalizePostLoginRedirect("/login?next=/t/sun", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/",
  "Login loops are rejected",
);

assert.equal(
  normalizePostLoginRedirect("/demo/sun", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
  }),
  "/",
  "Authenticated login should not land on the public demo shell",
);

assert.equal(homePathForTenant({ commandCenterProfileSlug: "sun" }), "/t/sun");
assert.equal(homePathForTenant({ commandCenterProfileSlug: "oasis-ai-cc" }), "/");

console.log("Auth routing tests passed");
