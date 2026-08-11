/**
 * Let a plain-node script import a module marked `import "server-only"`.
 *
 * That marker exists to make the BUNDLER fail if a server module is pulled into
 * a client bundle — a guard worth keeping, and the reason lib/r2-storage.ts and
 * lib/supabase-admin.ts carry it. Outside Next there is no bundler, so the
 * package just throws on require and a server-side test cannot run at all.
 *
 * Resolving it to an empty module restores exactly the behaviour Next's server
 * build gives it, and only for the process that opts in:
 *
 *   npx tsx --require ./scripts/allow-server-only.cjs scripts/verify-r2-upload.ts
 */
const Module = require("node:module");
const path = require("node:path");

const NOOP = path.join(__dirname, "server-only-noop.cjs");
const original = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only" || request === "client-only") return NOOP;
  return original.call(this, request, ...rest);
};
