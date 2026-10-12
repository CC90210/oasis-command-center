import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

const pairCode = read("app/api/auth/pair-code/route.ts");
assert.match(
  pairCode,
  /\.from\("bridge_pair_codes"\)[\s\S]*?\.delete\(\)[\s\S]*?\.eq\("tenant_id", session\.tenantId\)[\s\S]*?\.eq\("auth_user_id", session\.userId\)/,
  "pair-code revocation must be scoped to both the active tenant and signed-in user",
);
assert.match(pairCode, /pair-code-mint:user:/, "pair-code minting must be rate-limited by signed-in user");
assert.match(pairCode, /pair-code-mint:ip:/, "pair-code minting must also be rate-limited by source IP");
assert.match(pairCode, /pair_code_mint_unavailable/, "pair-code database failures must use a stable public error");
assert.doesNotMatch(pairCode, /return bad\([^\n]*\.error\.message/, "pair-code responses must not expose raw database errors");

const devices = read("app/api/devices/route.ts");
for (const stableError of ["devices_unavailable", "device_lookup_unavailable", "device_disconnect_unavailable"]) {
  assert.ok(devices.includes(stableError), `devices route is missing stable error ${stableError}`);
}
assert.doesNotMatch(devices, /return bad\([^\n]*\.error\.message/, "device responses must not expose raw database errors");

const threads = read("app/api/conversations/threads/[key]/route.ts");
assert.match(
  threads,
  /function emptyThreadResponse\(\) \{\s*return NextResponse\.json\(\{ ok: true, messages: \[\], tt_chat_id: null \}\);\s*\}/,
  "missing and unreadable threads need one canonical response shape",
);
assert.equal(
  threads.match(/return emptyThreadResponse\(\);/g)?.length,
  3,
  "denied policy, missing thread, and inaccessible lead thread must be indistinguishable",
);

const noteMutation = read("app/api/leads/[id]/notes/[noteId]/route.ts");
assert.match(
  noteMutation,
  /if \(access\.status === 503\)[\s\S]*?error: access\.error[\s\S]*?status: access\.status/,
  "note mutations must preserve an access-check outage instead of disguising it as a 404",
);

const profile = read("app/api/profile/route.ts");
assert.match(
  profile,
  /\.eq\("id", currentProfile\.id\)[\s\S]*?\.eq\("tenant_id", currentProfile\.tenant_id\)/,
  "service-role profile updates must include the canonical profile's tenant boundary",
);
assert.ok(
  profile.includes('updateQuery.is("tenant_id", null)'),
  "pre-tenant onboarding profiles must remain explicitly null-tenant scoped",
);

const createApplication = read("app/api/leads/[id]/create-application/route.ts");
assert.ok(
  createApplication.includes("resolveSessionContext()"),
  "application creation must use the canonical session-to-tenant resolver",
);
assert.equal(
  createApplication.includes('.from("user_profiles")'),
  false,
  "application creation must not perform an unscoped service-role profile lookup",
);
for (const boundary of [
  "tenantId = session.tenantId",
  "userId: session.userId",
  "teamRole = session.teamRole",
]) {
  assert.ok(createApplication.includes(boundary), `application creation must derive ${boundary} from the same session`);
}

console.log("coderabbit-api-boundaries: OK");
