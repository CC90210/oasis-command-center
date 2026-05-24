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

// Empire-operator chrome-bleed regression (2026-05-24): CC signed in with
// his personal OASIS account and got dropped on /t/sun because his profile
// resolves to the SunBiz tenant (he's the listed operator on that row).
// Empire operators MUST always land on the master dashboard by default —
// they can preview /t/sun manually, but auto-routing them there on every
// login is the bug.
assert.equal(
  homePathForTenant({ commandCenterProfileSlug: "sun", isEmpireOperator: true }),
  "/",
  "Empire operators never auto-route to a tenant shell, even when profile resolves to sun",
);

assert.equal(
  homePathForTenant({ commandCenterProfileSlug: "suga", isEmpireOperator: true }),
  "/",
  "Empire operators never auto-route to suga either",
);

assert.equal(
  normalizePostLoginRedirect("/", {
    tenantSlug: "submissions",
    commandCenterProfileSlug: "sun",
    isEmpireOperator: true,
  }),
  "/",
  "Empire operator with no ?next= lands on / even when profile resolves to sun",
);

assert.equal(
  normalizePostLoginRedirect("/t/sun/playbook", {
    tenantSlug: "oasis-ai-cc",
    commandCenterProfileSlug: "oasis-ai-cc",
    isEmpireOperator: true,
  }),
  "/t/sun/playbook",
  "Empire operator can deep-link into any tenant they explicitly request (preview)",
);

assert.equal(
  normalizePostLoginRedirect("/t/sun/leads", {
    tenantSlug: "submissions",
    commandCenterProfileSlug: "sun",
    isEmpireOperator: false,
  }),
  "/t/sun/leads",
  "Real SunBiz tenant user keeps deep link (non-operator path still works)",
);

console.log("Auth routing tests passed");
