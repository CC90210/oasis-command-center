/**
 * Every opt-out is recorded where its sender looks, and honoured.
 *
 * WHY (2026-10-19 audit and its independent review). /api/unsubscribe resolved
 * the link's brand to a workspace by NAME:
 *   - a brand with a comma ("Trytan Health, Inc.") broke the filter
 *     expression, the route answered 500, and the opt-out was never recorded;
 *   - "_", "%" and "*" in a brand matched other workspaces' names;
 *   - a name is not an identity: 43 workspaces are called "OASIS AI" and a
 *     self-signup can take any name, so a real opt-out could be filed where its
 *     sender never looks.
 * And no OASIS sender read a global row (tenant_id NULL), so an opt-out filed
 * that way stopped no one.
 *
 * Now a brand pinned to one workspace (OASIS's support mail) files there, and
 * every other brand, or none, files globally. Every sender reads through
 * checkSuppression (lib/email/suppression-scope.ts): the workspace's own rows
 * plus the global ones, the address matched literally, failing closed. An
 * unsigned link can opt out anyone and a global row stops every sender, so
 * unsigned filings are capped per IP per hour; a token that does not match is
 * refused.
 *
 * Runs the REAL route, checkEmailSuppressed and checkSuppression against a
 * local libSQL file through the real Turso adapter, with the production
 * definitions of email_suppressions and pair_attempts (so the limiter runs).
 *
 * Run: node --conditions=react-server --import tsx tests/unsubscribe-records-every-opt-out.test.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "unsubscribe-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;

const TRYTAN = "11111111-0000-4000-8000-000000000001";
const ZETA = "11111111-0000-4000-8000-000000000002";
const SHARED_A = "11111111-0000-4000-8000-000000000003";
const SHARED_B = "11111111-0000-4000-8000-000000000004";
const SELF_SIGNUP = "11111111-0000-4000-8000-000000000005";
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const DIGITS = "0123";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
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
  const { OASIS_SUPPRESSION_TENANT_ID } = await import("../lib/email/support-mailbox");
  await db.executeMultiple(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT NOT NULL, custom_fields TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE "email_suppressions" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "email" TEXT NOT NULL,
      "tenant_id" TEXT,
      "brand" TEXT,
      "reason" TEXT NOT NULL DEFAULT 'unsubscribe',
      "source" TEXT NOT NULL DEFAULT 'web_form',
      "user_agent" TEXT,
      "ip_address" TEXT,
      "added_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"),
      FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX "email_suppressions_unique" ON "email_suppressions" (email, COALESCE (tenant_id, '\\u001f__null__'), COALESCE (brand, '\\u001f__null__'));
    CREATE TABLE "pair_attempts" (
      "id" INTEGER PRIMARY KEY,
      "profile_id" TEXT NOT NULL,
      "outcome" TEXT NOT NULL,
      "attempted_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "ip" TEXT
    );
    CREATE INDEX "idx_pair_attempts_profile_recent" ON "pair_attempts" (profile_id, attempted_at DESC);
  `);
  for (const [id, slug, name, custom] of [
    [TRYTAN, "trytan", "Trytan Health, Inc.", "{}"],
    [ZETA, "zeta", "Zeta Co", "{}"],
    [SHARED_A, "shared-a", "Shared Name", "{}"],
    [SHARED_B, "shared-b", "Shared Name", "{}"],
    [SELF_SIGNUP, "stranger", "Bright Brand", JSON.stringify({ brand: "Bright Brand" })],
    [SUNBIZ, "submissions", "SunBiz", "{}"],
    [DIGITS, "digits", "Digits Inc", "{}"],
    [OASIS_SUPPRESSION_TENANT_ID, "oasis-ai-cc", "OASIS AI", "{}"],
  ]) {
    await db.execute({ sql: "INSERT INTO tenants (id, slug, name, custom_fields) VALUES (?, ?, ?, ?)", args: [id, slug, name, custom] });
  }

  const { POST } = await import("../app/api/unsubscribe/route");
  const { checkEmailSuppressed } = await import("../lib/lead-interactions-queries");
  const { checkSuppression } = await import("../lib/email/suppression-scope");
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { NextRequest } = await import("next/server");

  const randomIp = () => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  async function optOut(email: string, brand: string, opts: { ip?: string; token?: string } = {}) {
    const res = await POST(
      new NextRequest("https://oasisai.work/api/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": opts.ip ?? randomIp() },
        body: JSON.stringify({ email, brand, ...(opts.token ? { token: opts.token } : {}) }),
      }),
    );
    const rows = await db.execute({ sql: "SELECT tenant_id, brand FROM email_suppressions WHERE email = ?", args: [email] });
    return { status: res.status, rows: rows.rows.map((r) => ({ tenant_id: r.tenant_id as string | null, brand: r.brand as string | null })) };
  }
  const file = (email: string, tenant: string | null) =>
    db.execute({ sql: "INSERT INTO email_suppressions (email, tenant_id, source) VALUES (?, ?, 'test')", args: [email, tenant] });
  const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const [warn, error] = [console.warn, console.error];
    console.warn = () => undefined;
    console.error = () => undefined;
    try {
      return await fn();
    } finally {
      console.warn = warn;
      console.error = error;
    }
  };

  console.log("unsubscribe-records-every-opt-out:");

  await check("no brand is matched to a workspace by name: a workspace's name, a shared name, a self-signup's, an unknown one and none all file for every sender", async () => {
    await quietly(async () => {
      for (const [email, brand] of [
        ["comma@example.com", "Trytan Health, Inc."],
        ["case@example.com", "trytan health, inc."],
        ["shared@example.com", "Shared Name"],
        ["stranger@example.com", "Bright Brand"],
        ["wild@example.com", "Zeta_Co"],
        ["star@example.com", "Z*"],
        ["unknown@example.com", "Nobody We Know"],
        ["nobrand@example.com", ""],
      ]) {
        const r = await optOut(email, brand);
        assert.equal(r.status, 200, `${brand}: HTTP ${r.status}`);
        assert.deepEqual(r.rows, [{ tenant_id: null, brand: brand || null }], JSON.stringify(brand));
      }
    });
  });

  await check("OASIS's support brand files under OASIS's own workspace, however it is typed", async () => {
    assert.deepEqual((await optOut("support@example.com", "OASIS AI")).rows, [{ tenant_id: OASIS_SUPPRESSION_TENANT_ID, brand: "OASIS AI" }]);
    assert.deepEqual((await optOut("support2@example.com", " oasis ai ")).rows, [{ tenant_id: OASIS_SUPPRESSION_TENANT_ID, brand: "oasis ai" }]);
  });

  await check("SunBiz is retired: its opt-outs file for every sender, never under its workspace", async () => {
    const r = await quietly(() => optOut("sunbiz-reader@example.com", "SunBiz"));
    assert.deepEqual(r.rows, [{ tenant_id: null, brand: "SunBiz" }]);
  });

  await check("filing reads no workspace at all: with the tenants table gone the opt-out is still recorded", async () => {
    await db.execute("ALTER TABLE tenants RENAME TO tenants_offline");
    try {
      const r = await quietly(() => optOut("no-tenants@example.com", "Trytan Health, Inc."));
      assert.equal(r.status, 200);
      assert.deepEqual(r.rows, [{ tenant_id: null, brand: "Trytan Health, Inc." }]);
    } finally {
      await db.execute("ALTER TABLE tenants_offline RENAME TO tenants");
    }
  });

  await check("a second click is not a second row", async () => {
    await quietly(() => optOut("twice@example.com", "Nobody We Know"));
    const again = await quietly(() => optOut("twice@example.com", "Nobody We Know"));
    assert.equal(again.status, 200);
    assert.equal(again.rows.length, 1);
  });

  await check("a global filing is logged, without the address", async () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void lines.push(JSON.stringify(args));
    try {
      await optOut("logged@example.com", "Nobody We Know");
    } finally {
      console.warn = warn;
    }
    assert.equal(lines.length, 1, "one line per global filing");
    assert.match(lines[0], /filed for every sender/);
    assert.ok(!lines[0].includes("logged@example.com"), "the log never carries the address");
  });

  await check("a global opt-out stops every workspace's sender; a workspace's own stops only that workspace", async () => {
    for (const tenant of [TRYTAN, ZETA, OASIS_SUPPRESSION_TENANT_ID]) {
      assert.deepEqual(await checkEmailSuppressed(tenant, "unknown@example.com"), { suppressed: true, checkFailed: false }, `global row vs ${tenant}`);
    }
    assert.deepEqual(await checkEmailSuppressed(OASIS_SUPPRESSION_TENANT_ID, "support@example.com"), { suppressed: true, checkFailed: false });
    assert.deepEqual(await checkEmailSuppressed(ZETA, "support@example.com"), { suppressed: false, checkFailed: false });
    assert.deepEqual(await checkEmailSuppressed(ZETA, "never-opted-out@example.com"), { suppressed: false, checkFailed: false });
  });

  await check("addresses with _ % \\ are matched exactly, as a workspace's rows and as global rows", async () => {
    const service = getServiceSupabase();
    for (const [scope, filedUnder] of [["tenant", ZETA], ["global", null]] as const) {
      const exact = [`john_doe.${scope}@example.com`, `pct%sign.${scope}@example.com`, `back\\slash.${scope}@example.com`];
      for (const addr of exact) await file(addr, filedUnder);
      for (const addr of exact) {
        assert.deepEqual(await checkSuppression(service, ZETA, addr), { suppressed: true, checkFailed: false }, `${scope}: ${addr}`);
        assert.deepEqual(await checkSuppression(service, ZETA, addr.toUpperCase()), { suppressed: true, checkFailed: false }, `${scope}: any case`);
      }
      for (const nearMiss of [`johnxdoe.${scope}@example.com`, `pctXYsign.${scope}@example.com`, `backxslash.${scope}@example.com`, `back/slash.${scope}@example.com`]) {
        assert.deepEqual(await checkSuppression(service, ZETA, nearMiss), { suppressed: false, checkFailed: false }, `${scope}: ${nearMiss} is someone else`);
      }
    }
  });

  await check("an address with * matches itself, and a row's * is never a wildcard for someone else", async () => {
    const service = getServiceSupabase();
    await file("star*x@example.com", null);
    assert.equal((await checkSuppression(service, ZETA, "star*x@example.com")).suppressed, true);
    assert.equal((await checkSuppression(service, ZETA, "starabcx@example.com")).suppressed, false);
  });

  await check("no workspace: the global rows only (it used to answer 'not suppressed' without reading)", async () => {
    assert.deepEqual(await checkEmailSuppressed("", "unknown@example.com"), { suppressed: true, checkFailed: false });
    assert.deepEqual(await checkEmailSuppressed("", "support@example.com"), { suppressed: false, checkFailed: false }, "a workspace's own row is not global");
    assert.deepEqual(await checkEmailSuppressed(ZETA, ""), { suppressed: false, checkFailed: false }, "no address, nothing to send to");
  });

  await check("an all-digit workspace id is matched as text, not read as a number", async () => {
    await file("digits@example.com", DIGITS);
    assert.deepEqual(await checkSuppression(getServiceSupabase(), DIGITS, "digits@example.com"), { suppressed: true, checkFailed: false });
  });

  await check("a failed lookup fails closed, and says why", async () => {
    await db.execute("ALTER TABLE email_suppressions RENAME TO email_suppressions_offline");
    try {
      const shared = await checkSuppression(getServiceSupabase(), ZETA, "unknown@example.com");
      assert.equal(shared.checkFailed, true);
      assert.equal(shared.suppressed, false);
      assert.ok(shared.error && shared.error.length > 0, "the error is carried to the caller's log");
      assert.deepEqual(await quietly(() => checkEmailSuppressed(ZETA, "unknown@example.com")), { suppressed: false, checkFailed: true });
      assert.deepEqual(await quietly(() => checkEmailSuppressed("", "unknown@example.com")), { suppressed: false, checkFailed: true });
    } finally {
      await db.execute("ALTER TABLE email_suppressions_offline RENAME TO email_suppressions");
    }
  });

  await check("with the signing secret set: a link with no token is accepted, a wrong token refused, the right one accepted", async () => {
    const secret = "unsubscribe-test-secret-0123456789";
    process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET = secret;
    const sign = (email: string, brand: string) => createHmac("sha256", secret).update(`${email}|${brand}`).digest("hex").slice(0, 16);
    try {
      await quietly(async () => {
        const missing = await optOut("no-token@example.com", "SunBiz");
        assert.equal(missing.status, 200, "a link sent before signing keeps working (CASL: 60 days)");
        assert.equal(missing.rows.length, 1);
        const wrong = await optOut("wrong-token@example.com", "SunBiz", { token: sign("someone-else@example.com", "SunBiz") });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.rows.length, 0, "a refused link records nothing");
        const right = await optOut("right-token@example.com", "SunBiz", { token: sign("right-token@example.com", "SunBiz") });
        assert.equal(right.status, 200);
        assert.equal(right.rows.length, 1);
      });
    } finally {
      delete process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
    }
  });

  await check("unsigned filings are capped at 100 per IP per hour; another IP, and a signed link, still get through", async () => {
    const ip = "203.0.113.7";
    await quietly(async () => {
      for (let i = 0; i < 100; i += 1) {
        const r = await optOut(`flood${i}@example.com`, "Nobody We Know", { ip });
        assert.equal(r.status, 200, `filing ${i + 1} of 100`);
      }
      const capped = await optOut("flood100@example.com", "Nobody We Know", { ip });
      assert.equal(capped.status, 429);
      assert.equal(capped.rows.length, 0, "a capped filing records nothing");
      assert.equal((await optOut("other-ip@example.com", "Nobody We Know", { ip: "203.0.113.8" })).status, 200);
      const secret = "unsubscribe-test-secret-0123456789";
      process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET = secret;
      try {
        const token = createHmac("sha256", secret).update("signed-past-cap@example.com|Nobody We Know").digest("hex").slice(0, 16);
        const signed = await optOut("signed-past-cap@example.com", "Nobody We Know", { ip, token });
        assert.equal(signed.status, 200, "a link we signed is never capped");
        assert.equal(signed.rows.length, 1);
      } finally {
        delete process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
      }
    });
  });

  await check("every sender reads opt-outs through checkSuppression; nothing else reads the table", async () => {
    const root = join(__dirname, "..");
    // lib/metrics counts a workspace's opt-outs for its dashboard; it never decides a send.
    const allowedReaders = new Set(["lib/email/suppression-scope.ts", "lib/metrics/index.ts"]);
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return /\.tsx?$/.test(name) ? [path] : [];
      });
    const readers: string[] = [];
    for (const path of [...walk(join(root, "lib")), ...walk(join(root, "app"))]) {
      const src = readFileSync(path, "utf8");
      const rel = relative(root, path).replace(/\\/g, "/");
      for (const m of src.matchAll(/\.from\(\s*["'`]email_suppressions["'`]\s*\)/g)) {
        const statement = src.slice(m.index, src.indexOf(";", m.index));
        if (/\.select\(/.test(statement)) readers.push(rel);
      }
    }
    const strays = readers.filter((rel) => !allowedReaders.has(rel));
    assert.deepEqual(strays, [], "read opt-outs with checkSuppression (lib/email/suppression-scope.ts), which reads global rows and fails closed");
    for (const sender of ["lib/lead-interactions-queries.ts", "lib/bulk-email/dispatch.ts", "lib/forms/oasis-funnel-email.ts", "lib/forms/next-steps-email.ts"]) {
      assert.match(readFileSync(join(root, sender), "utf8"), /checkSuppression\(/, `${sender} checks opt-outs before it sends`);
    }
  });

  if (failures > 0) {
    console.log(`unsubscribe-records-every-opt-out: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("unsubscribe-records-every-opt-out: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
