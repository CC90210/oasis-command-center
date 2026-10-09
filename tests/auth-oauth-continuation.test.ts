import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inviteTokenFromPath, safeInternalPath } from "../lib/turso-auth-admin";
import { loginFailureMessage } from "../lib/login-error";

assert.equal(safeInternalPath("/invite/token-123?from=login"), "/invite/token-123?from=login");
for (const unsafe of [
  "https://evil.example/steal",
  "//evil.example/steal",
  "/\\evil.example/steal",
  "\\evil.example/steal",
  "/safe\\..\\evil",
  "/\t/evil.example",
  "/\n/evil.example",
  "/\r/evil.example",
  "/safe\r\nLocation: https://evil.example",
]) {
  assert.equal(safeInternalPath(unsafe), "/", `${JSON.stringify(unsafe)} must fail closed`);
}

const inviteToken = "invite_recovery_token_1234567890";
assert.equal(inviteTokenFromPath(`/invite/${inviteToken}`), inviteToken);
for (const notInvite of [
  "/invite/short",
  `/invite/${inviteToken}/extra`,
  `/invite/${inviteToken}?redirect=evil`,
  "/pipeline",
]) {
  assert.equal(inviteTokenFromPath(notInvite), null);
}

const start = readFileSync("app/api/auth/google/start/route.ts", "utf8");
const callback = readFileSync("app/api/auth/google/callback/route.ts", "utf8");
const login = readFileSync("app/login/LoginForm.tsx", "utf8");
const forgot = readFileSync("app/forgot-password/page.tsx", "utf8");
const authClient = readFileSync("lib/auth-client.ts", "utf8");

assert(
  start.includes('safeInternalPath(req.nextUrl.searchParams.get("next"))'),
  "OAuth start stores only a same-origin continuation",
);
assert(callback.includes('url.searchParams.set("err", error)'));
assert(callback.includes('url.searchParams.set("invite", inviteToken)'));
assert(!callback.includes('url.searchParams.set("error", error)'));
assert(callback.includes('const safeNext = safeInternalPath(next)'));
assert(callback.includes('return loginRedirect(req, "oauth_denied", safeNext)'));
for (const error of [
  "oauth_state_mismatch",
  "oauth_exchange_failed",
  "oauth_bad_token",
  "auth_backend_unavailable",
  "no_account",
]) {
  assert(
    callback.includes(`loginRedirect(req, "${error}", safeNext)`),
    `${error} must preserve the validated invite continuation`,
  );
}
assert(callback.includes("new URL(safeNext, req.url)"));
assert(!callback.includes("console."), "OAuth tokens and payloads must never be logged");
assert(login.includes('params.get("err")'), "the login UI reads the callback's error key");
assert(
  login.includes('if (inviteToken) query.set("invite", inviteToken)')
    && forgot.includes("{ inviteToken: inviteToken || undefined }"),
  "an OAuth error's recovered invite reaches the Forgot link and server-validated reset request",
);

assert(
  !forgot.includes('redirect.searchParams.set("invite"'),
  "the browser cannot attach an unverified invite to a legacy-provider reset callback",
);
assert(
  authClient.includes('new URL("/auth/reset-password", window.location.origin).toString()'),
  "the Supabase rollback path always uses a clean same-origin reset callback",
);

console.log("Auth OAuth-continuation tests passed");

// The password form blames the password ONLY when the server said the
// credentials were wrong (401). An outage, a missing backend or a malformed
// request is not "Invalid email or password" (Adon 2026-10-08: a 5xx read as
// a wrong password hides an outage and sends people to reset a good password).
{

  const INVALID = "Invalid email or password.";
  assert.equal(loginFailureMessage(401), INVALID);
  assert.match(loginFailureMessage(429), /too many attempts/i);
  for (const status of [400, 404, 500, 502, 503, 504, 0]) {
    assert.notEqual(loginFailureMessage(status), INVALID, `${status} must not blame the password`);
  }
  assert.match(loginFailureMessage(503), /unavailable/i);
  for (const status of [401, 429, 400, 500, 503]) {
    assert(!loginFailureMessage(status).includes("—"), "no em dashes in customer-facing copy");
  }
  assert(login.includes("loginFailureMessage(r.status)"), "the form uses the tested mapping");
  assert(!login.includes(': "Invalid email or password."'), "no inline fallback that blames the password");
}
