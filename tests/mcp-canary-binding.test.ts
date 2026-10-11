/**
 * The O4 canary bearer is bound to the computer that asked for it (security
 * review, O4): resolveMcpSession refuses a bearer that names a computer (pid)
 * with no run once that computer's pairing is revoked or unreadable, and the
 * canary route mints its bearer with that pid. Without the binding, a
 * revoked computer kept a five-minute read bearer to the workspace's tools.
 * Pinned in source: lib/mcp/tools.ts pulls in Next's client runtime, which a
 * bare tsx process cannot load.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).stack?.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

console.log("mcp-canary-binding:");

check("resolveMcpSession checks the named computer for a bearer with no run, and refuses a revoked one", () => {
  const tools = src("lib/mcp/tools.ts");
  const branch = tools.indexOf("} else if (claims.pid) {");
  assert.ok(branch > 0, "a pid-without-run branch exists");
  const body = tools.slice(branch, branch + 600);
  assert.match(body, /pairingBlocked\)\(claims\.pid\)\) return RUN_GONE;/);
});

check("the canary route mints its bearer bound to the asking computer", () => {
  assert.match(src("app/api/bridge/runs/canary/route.ts"), /pid: pairing\.pairingId/);
});

if (failures > 0) {
  console.log(`mcp-canary-binding: ${failures} failure(s)`);
  process.exit(1);
}
console.log("mcp-canary-binding: all passed");
