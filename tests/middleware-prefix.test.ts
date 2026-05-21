import assert from "node:assert/strict";
import { matchesPathPrefix } from "../lib/path-prefix";

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

console.log("middleware-prefix ok");
