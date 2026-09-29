/**
 * tests/stripe-provision-removed.test.ts — the unsigned provisioning webhook
 * stays deleted, and nothing points at it or at the progress it faked.
 *
 * WHY THIS EXISTS (P0-2, 2026-09-28)
 * ----------------------------------
 * app/api/webhooks/stripe-provision checked no Stripe signature, took the
 * tenant id from the request body, and wrote "Payment confirmed" into
 * provisioning_runs as a simulation. /api/webhooks/ is public by middleware
 * contract, so anyone could make any workspace's owner see a payment
 * confirmation and setup progress that never happened: the onboarding wizard
 * rendered that row as "Payment verified" and refreshed it every 3 seconds.
 * provisioning_runs had 0 live rows, so the route did nothing real.
 *
 * Its replacement (a signature-verified, idempotent billing webhook that
 * creates a provisioning grant, never a tenant) is Phase 2 work. Until then
 * this pins the deletion: the route file is gone, no code links it or calls
 * the helpers only it called, and the wizard no longer claims a payment.
 *
 * Run: node --conditions=react-server --import tsx tests/stripe-provision-removed.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCE_ROOTS = ["app", "components", "lib", "scripts", "middleware.ts"];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/;

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (SOURCE_EXT.test(entry.name)) out.push(path);
  }
  return out;
}

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

console.log("stripe-provision-removed:");
const files = SOURCE_ROOTS.flatMap(sourceFiles);
assert.ok(files.length > 100, `the source walk must find the app, or every check below is vacuous (found ${files.length})`);

check("the route file is gone", () => {
  assert.equal(existsSync("app/api/webhooks/stripe-provision/route.ts"), false);
  assert.equal(existsSync("app/api/webhooks/stripe-provision"), false, "no directory left to grow a route back into");
});

check("no code requests or imports the route", () => {
  // A quoted path (fetch, href, import, config) or an import of the module.
  // Prose in comments naming what was deleted is fine; a string a request
  // could be built from is not.
  const reference = /["'`]\/api\/webhooks\/stripe-provision|app\/api\/webhooks\/stripe-provision/;
  const hits = files.filter((f) => reference.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, [], "these files still reference the deleted route");
});

check("nothing calls the helpers only the route called", () => {
  // The definitions may stay (or go, with lib/client-provisioning.ts's own
  // cleanup); a CALL anywhere would mean something still forges runs.
  const call = /\b(startProvisioningRun|updateProvisioningRun)\s*\(/g;
  const callers = files.filter((f) => {
    const text = readFileSync(f, "utf8");
    const calls = text.match(call) || [];
    const definitions = text.match(/export\s+async\s+function\s+(startProvisioningRun|updateProvisioningRun)\s*\(/g) || [];
    return calls.length > definitions.length;
  });
  assert.deepEqual(callers, [], "these files call a provisioning-run writer");
});

check("the onboarding wizard no longer claims a payment or polls a run", () => {
  // Code only: the page's own comment explains what the old screen said.
  const wizard = readFileSync("app/onboarding/wizard/page.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(wizard, /ProvisioningProgress/, "the simulated progress screen is neither imported nor rendered");
  assert.doesNotMatch(wizard, /Payment (verified|confirmed)/i, "nothing verified a payment");
  assert.doesNotMatch(wizard, /router\.refresh|setInterval/, "nothing to poll for");
  assert.match(wizard, /OASIS sets up your workspace/, "an open run shows the neutral message instead");
});

if (failures > 0) {
  console.error(`stripe-provision-removed: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("stripe-provision-removed: all assertions passed");
