/**
 * Nothing under lib/ or app/ may read the filesystem at runtime.
 *
 * Production is Cloudflare Workers (OpenNext — wrangler.jsonc). workerd has no
 * filesystem. A `readFileSync` there does not fail at build time, does not fail
 * in `next dev`, and does not fail in any Node-based test — it fails only on
 * the live Worker, as an uncaught throw, which Next answers with a 500 carrying
 * an EMPTY body. The browser then reports "Unexpected end of JSON input", which
 * names the JSON parser and points nowhere near the filesystem.
 *
 * That is precisely how shop-out died on 2026-09-15 (lib/config/agents.ts), and
 * why it survived a repair attempt aimed at the client: every local signal was
 * green because every local runtime has a disk.
 *
 * This guard is the cheap version of that lesson. It runs in Node, reads
 * source, and needs no Worker.
 *
 * BASELINE POLICY: the list below is the set of KNOWN-UNFIXED offenders at the
 * time this guard landed. It may shrink, never grow. A new entry is not a
 * baseline update — it is the bug this file exists to stop.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/**
 * lib/prompts/index.ts reads its .txt prompt files at module init with a
 * VARIABLE filename, so it cannot be converted with a one-line static import —
 * the prompts have to become modules first. It is listed here rather than
 * fixed because that is a change to the AI scoring routes under
 * /api/leads/[id] (score, next-action, compose-checkin), not to shop-out, and
 * bundling it into an outage fix would put unrelated risk on the hot path.
 *
 * Status 2026-09-15: latent, NOT observed failing — those three endpoints
 * logged zero errors in the Worker's observability window, because nothing has
 * exercised them since the cutover. They will throw the same way when they are.
 */
/**
 * The other five were found BY this guard, not by the outage. None of them is
 * on the shop-out path (checked: nothing in the shop-out import graph reaches
 * them), so none is fixed here — an outage fix should not drag five unrelated
 * surfaces with it. They are real debt, and they are written down rather than
 * excluded quietly:
 *
 *   lib/agent-inbox-fs.ts          -> /api/inbox/{post,mark-read}, /inbox
 *   lib/agent-stats.ts             -> /agents
 *   lib/playbooks.ts               -> /playbook, /playbook/[slug]
 *   app/playbook/onboarding/page.tsx
 *   lib/cloud-knowledge-tools.ts   -> no importers found; likely dead
 *
 * Each will throw on the live Worker the first time it is exercised, in the
 * same invisible way shop-out did.
 */
/**
 * lib/forms/watermark.ts is the one baseline entry that IS on the shop-out
 * path — the real send calls watermarkAttachmentsForShopOut. It is listed
 * rather than fixed because it does not fail the way agents.ts did: a failed
 * watermark is caught and degrades to shopOutCleanFallback, which ships the
 * verified CLEAN original and records the reason. So on Workers the send still
 * goes out, with UNBRANDED statements. That is a real consequence and worth
 * fixing (the logo and font have to be bundled, not read from node_modules and
 * public/), but it is a branding regression, not an outage, and it is not what
 * this change is repairing.
 */
const BASELINE = new Set([
  "lib/prompts/index.ts",
  "lib/agent-inbox-fs.ts",
  "lib/agent-stats.ts",
  "lib/cloud-knowledge-tools.ts",
  "lib/playbooks.ts",
  "lib/forms/watermark.ts",
  "app/playbook/onboarding/page.tsx",
]);

const SCAN_DIRS = ["lib", "app"];
const SKIP_DIR = /(^|[\\/])(__tests__|node_modules|\.next)([\\/]|$)/;

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (SKIP_DIR.test(full)) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Node's fs, in every spelling that reaches a real disk.
 *
 * The DYNAMIC form is not optional pedantry. The first version of this guard
 * only matched `from "node:fs"` and `require("fs")`, and it reported the repo
 * clean while lib/forms/watermark.ts sat there doing
 * `const fs = await import("node:fs/promises")` twice. A deferred import is
 * still a disk read; workerd does not care which syntax asked.
 */
const FS_IMPORT =
  /\bfrom\s+["'](?:node:)?fs(?:\/promises)?["']|(?:require|import)\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/;

const offenders: string[] = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split(sep).join("/");
    const code = stripComments(readFileSync(file, "utf8"));
    if (FS_IMPORT.test(code)) offenders.push(rel);
  }
}

const unexpected = offenders.filter((f) => !BASELINE.has(f));
assert.deepEqual(
  unexpected,
  [],
  `Runtime filesystem access is not available on Cloudflare Workers. ` +
    `These modules import fs and will throw on the live Worker while passing ` +
    `every local test: ${unexpected.join(", ")}. Bundle the data with a static ` +
    `import (see lib/config/agents.ts) instead of reading it from disk.`,
);

// The baseline must stay honest: an entry that no longer offends has to be
// removed, or the list quietly becomes permission rather than debt.
const staleBaseline = [...BASELINE].filter((f) => !offenders.includes(f));
assert.deepEqual(
  staleBaseline,
  [],
  `BASELINE lists ${staleBaseline.join(", ")}, which no longer reads the ` +
    `filesystem. Delete the entry — baselines shrink, never linger.`,
);

// PROVE THE GUARD FIRES. A scan that has never rejected anything is a scan
// nobody can trust.
for (const planted of [
  'import { readFileSync } from "node:fs";',
  'import { readFile } from "fs/promises";',
  'const fs = require("fs");',
  'import { readFileSync } from "node:fs/promises";',
  // The dynamic form the first version of this guard walked straight past.
  'const fs = await import("node:fs/promises");',
  'const fs = await import("fs");',
]) {
  assert.ok(FS_IMPORT.test(stripComments(planted)), `guard must reject: ${planted}`);
}
// ...and must NOT reject prose that merely mentions it, or the next person
// deletes the comment that explains the rule.
assert.ok(
  !FS_IMPORT.test(stripComments('/* we used to import from "node:fs" here */\nexport const x = 1;')),
  "guard must not fire on a comment describing the rule",
);
// ...nor on an unrelated identifier that happens to contain "fs".
assert.ok(
  !FS_IMPORT.test(stripComments('import { prefsFrom } from "@/lib/prefs";')),
  "guard must not fire on an unrelated module whose name contains fs",
);

console.log(
  `workers-no-runtime-fs: OK — scanned ${SCAN_DIRS.join("/")}, ` +
    `${offenders.length} known offender(s), 0 new`,
);
