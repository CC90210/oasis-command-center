/**
 * audit-operator-emails.test.ts — the operator-alias audit reports the right
 * verdict per alias and NEVER prints an email address (doc 02 P0-7 "Now").
 *
 * WHY. An alias on OPERATOR_EMAIL / ADMIN_EMAILS with no live auth user is one
 * whoever registers that address first would hold. The audit exists to find
 * those so they can be removed from the Worker env the same day — and because
 * its output lands in a terminal and a chat log, the values themselves must
 * never appear in it. "claimable" must match what signup actually refuses:
 * turso-signup rejects an address held by any non-deleted auth user, banned or
 * not, so a banned holder is NOT claimable and a soft-deleted one IS.
 *
 * Runs the audit function against a local libSQL file, then the script itself
 * as a child process against the same file (never a remote database), and
 * scans its stdout/stderr for every address.
 *
 * Run: node --conditions=react-server --import tsx tests/audit-operator-emails.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "audit-operator-emails-")), "test.db");

const HELD = "held@alias.test";
const BANNED = "banned@alias.test";
const DELETED = "deleted@alias.test";
const DANGLING = "dangling@alias.test";
const DEFAULT = "conaugh@oasisai.work";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 4).join("\n        ")}`);
  }
}

async function main() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    INSERT INTO "_supabase_auth_users" (id, email) VALUES ('a1', '${DEFAULT}');
    INSERT INTO "_supabase_auth_users" (id, email) VALUES ('a2', 'HELD@alias.test');
    INSERT INTO "_supabase_auth_users" (id, email, banned_until) VALUES ('a3', '${BANNED}', '2999-01-01T00:00:00Z');
    INSERT INTO "_supabase_auth_users" (id, email, deleted_at) VALUES ('a4', '${DELETED}', '2026-09-01T00:00:00Z');
  `);

  const audit = await import("../scripts/audit-operator-emails");
  const repoRoot = join(__dirname, "..");
  const env = { OPERATOR_EMAIL: ` ${HELD} `, ADMIN_EMAILS: `${BANNED}, ,${DELETED},${DANGLING}` };

  console.log("audit-operator-emails:");

  await check("the hardcoded default is read from lib/operator-credentials.ts, not retyped", () => {
    assert.equal(audit.readDefaultOperatorEmail(repoRoot), DEFAULT);
  });

  await check("each alias gets the verdict signup would enforce", async () => {
    const rows = await audit.auditOperatorAliases(db, env, DEFAULT);
    assert.deepEqual(
      rows.map((r) => [r.source, r.set, r.liveAuthUser, r.claimable]),
      [
        ["DEFAULT_OPERATOR_EMAIL (hardcoded)", true, true, false],
        ["OPERATOR_EMAIL", true, true, false], // matched case-insensitively, trimmed
        ["ADMIN_EMAILS[1]", true, false, false], // banned holder still blocks signup
        ["ADMIN_EMAILS[2]", true, false, true], // soft-deleted holder does not
        ["ADMIN_EMAILS[3]", true, false, true], // nobody holds it
      ],
    );
  });

  await check("unset sources are reported as unset, never as claimable", async () => {
    const rows = await audit.auditOperatorAliases(db, {}, DEFAULT);
    assert.deepEqual(
      rows.map((r) => [r.source, r.set, r.claimable]),
      [
        ["DEFAULT_OPERATOR_EMAIL (hardcoded)", true, false],
        ["OPERATOR_EMAIL", false, false],
        ["ADMIN_EMAILS", false, false],
      ],
    );
  });

  await check("the script prints no address, flags the claimable ones and exits 1", () => {
    const run = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", join(repoRoot, "scripts", "audit-operator-emails.ts")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ...env,
          TURSO_DB_PATH: dbFile,
          TURSO_DATABASE_URL: "",
          TURSO_DB_URL: "",
        },
      },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    for (const email of [HELD, BANNED, DELETED, DANGLING, DEFAULT, "alias.test", "oasisai.work"]) {
      assert.ok(!output.toLowerCase().includes(email.toLowerCase()), `output leaked ${email.split("@")[0]}…`);
    }
    assert.equal(run.status, 1, `exit ${run.status}: ${output}`);
    assert.match(output, /ADMIN_EMAILS\[3\]\s+yes\s+no\s+CLAIMABLE: remove it from the Worker env today/);
    assert.match(output, /2 claimable alias\(es\)\./);
  });

  await check("the script refuses to guess when no database is configured (exit 2)", () => {
    const run = spawnSync(
      process.execPath,
      ["--conditions=react-server", "--import", "tsx", join(repoRoot, "scripts", "audit-operator-emails.ts")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...env, TURSO_DB_PATH: "", TURSO_DATABASE_URL: "", TURSO_DB_URL: "" },
      },
    );
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
  });

  if (failures > 0) {
    console.log(`audit-operator-emails: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("audit-operator-emails: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
