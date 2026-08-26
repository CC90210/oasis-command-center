/**
 * tests/google-dwd.test.ts — Google Workspace domain-wide delegation.
 *
 * THE ONE THAT MATTERS IS THE DOMAIN ALLOWLIST. A delegated service account can
 * mint a token for ANY address on the domains an admin authorised it for, so
 * the only thing between "every rep is connected with zero clicks" and "we can
 * read a stranger's calendar" is `isDelegatableAddress`. Everything here that
 * looks paranoid is protecting that one function.
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  dwdConfig,
  isDwdConfigured,
  isDelegatableAddress,
  buildAssertion,
  mintDelegatedAccessToken,
  clearDelegatedTokenCache,
} from "@/lib/integrations/google-dwd";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function configure(domains = "oasisai.work") {
  process.env.GOOGLE_DWD_CLIENT_EMAIL = "reminders@oasis.iam.gserviceaccount.com";
  process.env.GOOGLE_DWD_PRIVATE_KEY = String(privateKey);
  process.env.GOOGLE_DWD_DOMAINS = domains;
  clearDelegatedTokenCache();
}
function unconfigure() {
  delete process.env.GOOGLE_DWD_CLIENT_EMAIL;
  delete process.env.GOOGLE_DWD_PRIVATE_KEY;
  delete process.env.GOOGLE_DWD_DOMAINS;
  clearDelegatedTokenCache();
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function main() {

/* --------------------------------------------- off by default, on by config */

unconfigure();
assert.equal(dwdConfig(), null, "absent configuration must read as 'feature off', not as an error");
assert.equal(isDwdConfigured(), false);

configure();
const config = dwdConfig();
assert.ok(config, "all three variables present means delegation is available");
assert.deepEqual(config.domains, ["oasisai.work"]);

// A partial configuration is OFF, not half-on. Half a service account cannot
// mint anything, and treating it as configured would report a confusing
// "delegation rejected" instead of "nobody set this up".
for (const missing of ["GOOGLE_DWD_CLIENT_EMAIL", "GOOGLE_DWD_PRIVATE_KEY", "GOOGLE_DWD_DOMAINS"]) {
  configure();
  const saved = process.env[missing];
  delete process.env[missing];
  assert.equal(dwdConfig(), null, `missing ${missing} must disable delegation entirely`);
  process.env[missing] = saved;
}

/* ------------------------------------- 🚨 THE ALLOWLIST IS THE WHOLE MODEL */

configure();
const cfg = dwdConfig()!;

assert.equal(isDelegatableAddress("rep@oasisai.work", cfg), true);
assert.equal(
  isDelegatableAddress("REP@OasisAI.Work", cfg),
  true,
  "case must not decide whether someone is on the domain",
);

// The suffix attack. `endsWith("oasisai.work")` would pass every one of these,
// and each is a domain an attacker can register.
for (const hostile of [
  "rep@evil-oasisai.work",
  "rep@notoasisai.work",
  "rep@xoasisai.work",
]) {
  assert.equal(
    isDelegatableAddress(hostile, cfg),
    false,
    `${hostile} must NOT be delegatable: a suffix test here reads a stranger's calendar`,
  );
}

// A subdomain is a different domain. If the org wants it, the admin lists it.
assert.equal(isDelegatableAddress("rep@mail.oasisai.work", cfg), false);

// Plainly not ours.
assert.equal(isDelegatableAddress("someone@gmail.com", cfg), false);
assert.equal(isDelegatableAddress("attacker@oasisai.work.evil.com", cfg), false);

// Malformed input must be refused before it ever reaches a signed claim.
for (const junk of ["", "   ", "not-an-email", "a@b", "@oasisai.work", "rep@", "a b@oasisai.work"]) {
  assert.equal(
    isDelegatableAddress(junk, cfg),
    false,
    `malformed address ${JSON.stringify(junk)} must be refused`,
  );
}

// Two addresses, one legal one not, must not be smuggled through together.
assert.equal(isDelegatableAddress("rep@oasisai.work,evil@gmail.com", cfg), false);

/* ---------------------------------------------------- the signed assertion */

{
  const assertionJwt = buildAssertion(cfg, "rep@oasisai.work", 1_700_000_000);
  const [, claimsPart] = assertionJwt.split(".");
  const claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(claims.sub, "rep@oasisai.work", "sub is who we act as");
  assert.equal(claims.iss, "reminders@oasis.iam.gserviceaccount.com");
  assert.equal(
    claims.scope,
    "https://www.googleapis.com/auth/calendar.events",
    "the scope is pinned in the module and must not be widenable by a caller",
  );
  assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
  assert.ok(
    Number(claims.exp) > Number(claims.iat),
    "an assertion that expires before it starts is rejected by Google with an opaque error",
  );
  assert.equal(assertionJwt.split(".").length, 3, "a JWT is three dot-separated parts");
}

/* --------------------------------------------------------------- minting */

{
  // Not configured: a refusal, not a throw, and no network call.
  unconfigure();
  let called = 0;
  const r = await mintDelegatedAccessToken("rep@oasisai.work", {
    fetchImpl: async () => {
      called += 1;
      return json({ access_token: "leaked" });
    },
  });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "not_configured");
  assert.equal(called, 0, "an unconfigured mint must not reach the network");
}

{
  // 🚨 Off-domain must be refused BEFORE any network call. If this ever regresses
  // it is not a bug, it is an incident.
  configure();
  let called = 0;
  const r = await mintDelegatedAccessToken("someone@gmail.com", {
    fetchImpl: async () => {
      called += 1;
      return json({ access_token: "leaked" });
    },
  });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "not_delegatable");
  assert.equal(called, 0, "an off-domain address must never produce a token request");
  assert.ok(
    !r.ok && !r.detail.includes("gmail.com"),
    "the refusal must not echo an attacker-influenced address into logs",
  );
}

{
  configure();
  const r = await mintDelegatedAccessToken("rep@oasisai.work", {
    fetchImpl: async () => json({ access_token: "tok_live", expires_in: 3600 }),
    now: () => 1_000_000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.accessToken, "tok_live");
  assert.equal(r.ok && r.expiresAtMs, 1_000_000 + 3_600_000);
}

{
  // The cache must serve a live token rather than re-minting per lead.
  configure();
  let mints = 0;
  const deps = {
    fetchImpl: async () => {
      mints += 1;
      return json({ access_token: `tok_${mints}`, expires_in: 3600 });
    },
    now: () => 2_000_000,
  };
  await mintDelegatedAccessToken("rep@oasisai.work", deps);
  await mintDelegatedAccessToken("rep@oasisai.work", deps);
  assert.equal(mints, 1, "a cron pass over many leads for one rep must mint once, not once per lead");

  // ...but two different reps must never share a token.
  await mintDelegatedAccessToken("other@oasisai.work", deps);
  assert.equal(mints, 2, "tokens are per-person; sharing one would act as the wrong rep");
}

/* ------------------------------------------------- failure classification */

const CASES: Array<[number, string, string]> = [
  [503, "", "retryable"],
  [429, "", "retryable"],
  // 400/401/403 mean the admin has not authorised this client for this scope,
  // or the key is wrong. A person must act; a timer never helps.
  [403, '{"error":"unauthorized_client"}', "delegation_rejected"],
  [400, '{"error":"invalid_grant"}', "delegation_rejected"],
  [401, "", "delegation_rejected"],
];
for (const [status, body, expected] of CASES) {
  configure();
  const r = await mintDelegatedAccessToken("rep@oasisai.work", {
    fetchImpl: async () => new Response(body, { status }),
  });
  assert.equal(r.ok, false, `${status} must not report success`);
  assert.equal(!r.ok && r.reason, expected, `HTTP ${status} should classify as ${expected}`);
}

{
  // A 200 with no token is not a success. Returning ok here would hand the
  // caller `undefined` as a bearer credential.
  configure();
  const r = await mintDelegatedAccessToken("rep@oasisai.work", {
    fetchImpl: async () => json({ expires_in: 3600 }),
  });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "retryable");
}

{
  configure();
  const r = await mintDelegatedAccessToken("rep@oasisai.work", {
    fetchImpl: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "retryable", "a network error may clear on a later attempt");
}

unconfigure();
console.log("google-dwd.test.ts passed");

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
