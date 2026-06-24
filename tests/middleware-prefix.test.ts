import assert from "node:assert/strict";
import { matchesPathPrefix } from "../lib/path-prefix";
import { isPublic } from "../middleware";

const cases: Array<[string, string, boolean]> = [
  ["/api/cron", "/api/cron", true],
  ["/api/cron/materialize-plans", "/api/cron", true],
  ["/api/cron-jobs", "/api/cron", false],
  ["/api/cron-jobs/poll", "/api/cron", false],
  ["/f/oasis/apply/token", "/f/", true],
  ["/favicon.ico", "/favicon", false],
  ["/favicon", "/favicon", true],
];

for (const [pathname, prefix, expected] of cases) {
  assert.equal(matchesPathPrefix(pathname, prefix), expected, `${prefix} vs ${pathname}`);
}

assert.equal(isPublic("/api/forms/submit"), true, "public form submit bypasses session middleware");
assert.equal(isPublic("/api/forms/upload-url"), true, "public form upload signer bypasses session middleware");
assert.equal(isPublic("/api/forms/view"), true, "public form view tracker bypasses session middleware");
assert.equal(isPublic("/api/forms/address-autocomplete"), true, "public form address autocomplete bypasses session middleware");
assert.equal(isPublic("/api/forms"), false, "operator forms list remains session-gated");
assert.equal(isPublic("/api/forms/abc/mint-link"), false, "operator link minting remains session-gated");

console.log("middleware-prefix ok");
