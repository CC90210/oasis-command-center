/**
 * The agent roster must be BUNDLED, never read from disk at runtime.
 *
 * 2026-09-15: production moved to Cloudflare Workers (OpenNext — see
 * wrangler.jsonc). workerd has no filesystem, so lib/config/agents.ts's
 * `readFileSync(join(process.cwd(), "agents.config.json"))` threw on every
 * authenticated call:
 *
 *   at readFileSync (node-internal:internal_fs_sync:366:7)
 *   at getAgents -> findAgentByEmail -> resolveSignerForOperator
 *   at POST /api/applications/[id]/shop-out
 *
 * The shop-out route did not catch it, so Next returned a 500 with an empty
 * body and the browser reported "Unexpected end of JSON input". Shop-out was
 * dead for every deal: the lender grid, the attachment step and the send step
 * all gate on that one response.
 *
 * Twelve other call sites reach getAgents() (lender-thread reply/retry/
 * retry-all, shop-out/run, leads email, templates send, email-signature,
 * application-pdf, next-steps-email, derive-agent-ccs, shop-out, metrics).
 * They were all latently broken by the same line, so this guard covers the
 * roster loader itself rather than any one route.
 *
 * This test FAILS if a runtime fs read comes back to the module.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const rawSource = readFileSync(join(ROOT, "lib", "config", "agents.ts"), "utf8");

/**
 * Strip comments before asserting. The module's own header DESCRIBES the
 * outage in prose — it names readFileSync and process.cwd() on purpose, so
 * the next person understands why the static import is load-bearing. A guard
 * that greps raw text would fail on the explanation and force someone to
 * delete the very comment that prevents the regression.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const source = stripComments(rawSource);

// 1. No runtime filesystem access in the roster loader, in any spelling.
const forbidsFs = (code: string) => ({
  importsFs: /\bfrom\s+["'](?:node:)?fs["']/.test(code) || /require\(\s*["'](?:node:)?fs["']\s*\)/.test(code),
  readsFile: /\breadFileSync?\s*\(/.test(code) || /\breadFile\s*\(/.test(code),
  usesCwd: /process\.cwd\s*\(\s*\)/.test(code),
});

const checks = forbidsFs(source);
assert.ok(!checks.importsFs, "lib/config/agents.ts must not import fs — workerd has no filesystem");
assert.ok(
  !checks.readsFile,
  "lib/config/agents.ts must not call readFileSync — this is the 2026-09-15 shop-out outage",
);
assert.ok(
  !checks.usesCwd,
  "lib/config/agents.ts must not resolve paths against process.cwd() at runtime",
);

// 2. It must get the roster the portable way: a static import that the
//    bundler inlines for every runtime.
assert.match(
  source,
  /import\s+agentsConfig\s+from\s+["']@\/agents\.config\.json["']/,
  "lib/config/agents.ts must statically import agents.config.json so it is bundled",
);

// 3. PROVE THE GUARD FIRES. A doc comment asserting "no fs here" is worth
//    nothing unless the check that enforces it has been seen to fail. Plant
//    the exact regression and confirm each assertion rejects it.
const regressed = source
  .replace(
    /import\s+agentsConfig\s+from\s+["']@\/agents\.config\.json["'];/,
    'import { readFileSync } from "node:fs";',
  )
  .concat('\nconst raw = readFileSync(process.cwd() + "/agents.config.json", "utf8");\n');

const regressedChecks = forbidsFs(regressed);
assert.ok(regressedChecks.importsFs, "planted regression must trip the fs-import check");
assert.ok(regressedChecks.readsFile, "planted regression must trip the readFileSync check");
assert.ok(regressedChecks.usesCwd, "planted regression must trip the process.cwd() check");
assert.ok(
  !/import\s+agentsConfig\s+from\s+["']@\/agents\.config\.json["']/.test(regressed),
  "planted regression must trip the static-import check",
);

// And the comment-stripping must not become a hole: a REAL fs read that
// happens to sit next to prose is still caught.
assert.ok(
  forbidsFs(stripComments('/* mentions readFileSync */\nimport { readFileSync } from "node:fs";')).importsFs,
  "comment stripping must not hide a real fs import",
);

// 4. The bundled config must actually satisfy the roster contract, so a
//    malformed commit fails here and not at 3am in a shop-out.
const config = JSON.parse(readFileSync(join(ROOT, "agents.config.json"), "utf8")) as {
  agents?: Array<Record<string, unknown>>;
};
assert.ok(Array.isArray(config.agents) && config.agents.length > 0, "agents.config.json needs agents");
for (const entry of config.agents) {
  for (const field of ["key", "name", "email", "phone"]) {
    assert.equal(
      typeof entry[field],
      "string",
      `agents.config.json entry ${JSON.stringify(entry.key)} needs a string ${field}`,
    );
  }
}

console.log(`agents-config-runtime-portable: OK (${config.agents.length} agents, no runtime fs)`);
