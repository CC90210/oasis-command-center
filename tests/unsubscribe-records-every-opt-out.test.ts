/**
 * Every opt-out is recorded where its sender looks, and honoured.
 *
 * WHY (2026-10-19 audit and its independent review). /api/unsubscribe resolved
 * the link's brand to a workspace by NAME:
 *   - a brand with a comma ("Trytan Health, Inc.") broke the filter
 *     expression, the route answered 500, and the opt-out was never recorded;
 *   - "_", "%" and "*" in a brand matched other workspaces' names;
 *   - a name is not an identity: dozens of workspaces are called "OASIS AI" and a
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
 * unsigned filings are capped per address bucket per hour; a token that does
 * not match is filed as unsigned, never refused.
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
  /** Run `fn`, keeping what it logged as warnings and errors. */
  const logged = async <T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
    const lines: string[] = [];
    const [warn, error] = [console.warn, console.error];
    console.warn = (...args: unknown[]) => void lines.push(JSON.stringify(args));
    console.error = (...args: unknown[]) => void lines.push(JSON.stringify(args));
    try {
      return { result: await fn(), lines };
    } finally {
      console.warn = warn;
      console.error = error;
    }
  };
  /** Every .ts/.tsx file under `dir`. */
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });

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

  const SECRET = "unsubscribe-test-secret-0123456789";
  // The scheme, written out once here independently of the code, so a change
  // to the shared function cannot pass unnoticed.
  const sign = (email: string, brand: string) => createHmac("sha256", SECRET).update(`${email}|${brand}`).digest("hex").slice(0, 16);
  /** Filings capped under an address bucket: the cap's own rows in pair_attempts. */
  const capRows = async (bucket: string) =>
    Number((await db.execute({ sql: "SELECT count(*) AS n FROM pair_attempts WHERE profile_id = ?", args: [`unsubscribe-unsigned:${bucket}`] })).rows[0].n);

  await check("the link builder and the route sign with one function: a link we build is accepted as signed", async () => {
    const { unsubscribeToken } = await import("../lib/email/unsubscribe-signing");
    const { unsubscribeUrl } = await import("../lib/email/tracked-html");
    assert.equal(unsubscribeToken("Round.Trip@Example.com ", "SunBiz", SECRET), sign("round.trip@example.com", "SunBiz"), "HMAC-SHA256(lowercased email|brand), 16 hex");
    process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET = SECRET;
    try {
      const link = new URL(unsubscribeUrl("Round.Trip@Example.com", "Nobody We Know", "https://oasisai.work"));
      const token = link.searchParams.get("token") ?? "";
      assert.equal(token.length, 16, "the link carries a token");
      const r = await quietly(() => optOut(link.searchParams.get("email") ?? "", link.searchParams.get("brand") ?? "", { ip: "198.51.100.9", token }));
      assert.equal(r.status, 200);
      assert.equal(await capRows("198.51.100.9"), 0, "accepted as signed: no place taken in the cap");
    } finally {
      delete process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
    }
    for (const rel of ["lib/email/tracked-html.ts", "app/api/unsubscribe/route.ts"]) {
      assert.ok(!/createHmac\([^)]*\)\s*\.update\(`\$\{[^}]+\}\|\$\{/.test(readFileSync(join(__dirname, "..", rel), "utf8")), `${rel} signs through unsubscribeToken, not its own copy`);
    }
  });

  await check("a brand or a token of any length is accepted: a long brand is cut for storage, a long token is simply unsigned", async () => {
    const longBrand = "B".repeat(200);
    const brandRun = await quietly(() => optOut("long-brand@example.com", longBrand));
    assert.equal(brandRun.status, 200, "a 200-character brand is not a refused opt-out");
    assert.deepEqual(brandRun.rows, [{ tenant_id: null, brand: longBrand.slice(0, 120) }]);
    const tokenRun = await quietly(() => optOut("long-token@example.com", "Nobody We Know", { ip: "198.51.100.10", token: "f".repeat(100) }));
    assert.equal(tokenRun.status, 200, "a 100-character token is not a refused opt-out");
    assert.equal(tokenRun.rows.length, 1);
    assert.equal(await capRows("198.51.100.10"), 1, "filed as unsigned");
    assert.equal((await quietly(() => optOut("not-an-address", "Nobody We Know"))).status, 400, "an address still has to be one");
  });

  await check("a write that fails answers db_error and keeps the database's words in the log", async () => {
    await db.execute(`CREATE TRIGGER refuse_optout BEFORE INSERT ON email_suppressions BEGIN SELECT RAISE(ABORT, 'es_internal_words_xyz'); END`);
    let status = 0;
    let body = "";
    let lines: string[] = [];
    try {
      const run = await logged(async () => {
        const res = await POST(
          new NextRequest("https://oasisai.work/api/unsubscribe", {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": randomIp() },
            body: JSON.stringify({ email: "write-fails@example.com", brand: "Nobody We Know" }),
          }),
        );
        return { status: res.status, body: await res.text() };
      });
      ({ status, body } = run.result);
      lines = run.lines;
    } finally {
      await db.execute("DROP TRIGGER refuse_optout");
    }
    assert.equal(status, 500);
    assert.deepEqual(JSON.parse(body), { ok: false, error: "db_error" });
    assert.ok(lines.some((l) => l.includes("opt-out write failed") && l.includes("es_internal_words_xyz")), "the log has the database's words");
  });

  await check("the limiter fails open: with its table gone a filing is still recorded, and the failure is logged", async () => {
    await db.execute("ALTER TABLE pair_attempts RENAME TO pair_attempts_offline");
    let run: { result: Awaited<ReturnType<typeof optOut>>; lines: string[] };
    try {
      run = await logged(() => optOut("limiter-down@example.com", "Nobody We Know"));
    } finally {
      await db.execute("ALTER TABLE pair_attempts_offline RENAME TO pair_attempts");
    }
    assert.equal(run.result.status, 200, "a broken limiter must not refuse a real opt-out");
    assert.equal(run.result.rows.length, 1);
    assert.ok(run.lines.some((l) => l.includes("[pair-rate-limit]")), "a limiter that cannot count is visible");
  });

  await check("with the signing secret set: no token and a wrong token are both filed as unsigned (counted against the cap); only the right one is signed", async () => {
    process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET = SECRET;
    try {
      await quietly(async () => {
        const missing = await optOut("no-token@example.com", "SunBiz", { ip: "198.51.100.1" });
        assert.equal(missing.status, 200, "a link sent before signing keeps working (CASL: 60 days)");
        assert.equal(missing.rows.length, 1);
        assert.equal(await capRows("198.51.100.1"), 1, "counted as unsigned");
        // Refusing a mismatch would strand every real link the day the secret
        // rotates, and an attacker would simply leave the token off.
        const wrong = await optOut("wrong-token@example.com", "SunBiz", { ip: "198.51.100.2", token: sign("someone-else@example.com", "SunBiz") });
        assert.equal(wrong.status, 200);
        assert.equal(wrong.rows.length, 1);
        assert.equal(await capRows("198.51.100.2"), 1, "a mismatched token is counted as unsigned");
        const right = await optOut("right-token@example.com", "SunBiz", { ip: "198.51.100.3", token: sign("right-token@example.com", "SunBiz") });
        assert.equal(right.status, 200);
        assert.equal(right.rows.length, 1);
        assert.equal(await capRows("198.51.100.3"), 0, "a signed link takes no place in the cap");
      });
    } finally {
      delete process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
    }
  });

  await check("with no signing secret, any token is unsigned: counted against the cap", async () => {
    const r = await quietly(() => optOut("bogus-token@example.com", "Nobody We Know", { ip: "198.51.100.4", token: "0123456789abcdef" }));
    assert.equal(r.status, 200);
    assert.equal(await capRows("198.51.100.4"), 1);
  });

  await check("unsigned filings are capped at 30 per address per hour, even in a parallel burst; another address, and a signed link, still get through", async () => {
    const ip = "203.0.113.7";
    const { lines } = await logged(async () => {
      const burst = await Promise.all(
        Array.from({ length: 45 }, (_, i) => optOut(`flood${i}@example.com`, "Nobody We Know", { ip })),
      );
      const statuses = burst.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 200).length, 30, `exactly 30 of a 45-request burst are filed: ${statuses.join(",")}`);
      assert.equal(statuses.filter((s) => s === 429).length, 15);
      const filed = await db.execute({ sql: "SELECT count(*) AS n FROM email_suppressions WHERE email LIKE 'flood%@example.com'", args: [] });
      assert.equal(Number(filed.rows[0].n), 30, "a capped filing records nothing");
      // One row per attempt, the cap's own: a trip writes no second row, and
      // the route keeps no separate failure counter (reviewer of #711, items
      // 24 and 33).
      assert.equal(await capRows(ip), 45);
      const extra = await db.execute("SELECT count(*) AS n FROM pair_attempts WHERE profile_id LIKE 'unsubscribe:%'");
      assert.equal(Number(extra.rows[0].n), 0);
      assert.equal((await optOut("other-ip@example.com", "Nobody We Know", { ip: "203.0.113.8" })).status, 200);
      process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET = SECRET;
      try {
        const signed = await optOut("signed-past-cap@example.com", "Nobody We Know", { ip, token: sign("signed-past-cap@example.com", "Nobody We Know") });
        assert.equal(signed.status, 200, "a link we signed is never capped");
        assert.equal(signed.rows.length, 1);
      } finally {
        delete process.env.OASIS_UNSUBSCRIBE_HMAC_SECRET;
      }
    });
    assert.ok(lines.some((l) => l.includes("unsigned opt-out cap reached")), "a trip is logged");
  });

  await check("claiming a slot prunes day-old limiter rows now and then, as recording an attempt does", async () => {
    // The opt-out route only claims slots now, and the prune used to run only
    // from recordPairAttempt: the table would have grown forever.
    const { claimCappedSlot } = await import("../lib/pair-rate-limit");
    await db.execute({
      sql: "INSERT INTO pair_attempts (profile_id, outcome, attempted_at) VALUES ('day-old-row', 'ok', ?)",
      args: [new Date(Date.now() - 3 * 86_400_000).toISOString()],
    });
    const random = Math.random;
    Math.random = () => 0; // the prune's dice: always this time
    try {
      assert.equal(await claimCappedSlot("prune-probe", null, 60, 10), true);
    } finally {
      Math.random = random;
    }
    let left = 1;
    for (let i = 0; i < 20 && left > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25)); // fire-and-forget: give it a moment
      left = Number((await db.execute("SELECT count(*) AS n FROM pair_attempts WHERE profile_id = 'day-old-row'")).rows[0].n);
    }
    assert.equal(left, 0, "the day-old row was pruned");
  });

  await check("an IPv6 client is capped by its /64, so rotating addresses inside it does not get around the cap", async () => {
    const { ipRateBucket } = await import("../lib/pair-rate-limit");
    assert.equal(ipRateBucket("2001:db8:85a3:12::8a2e:370:7334"), "2001:db8:85a3:12::/64");
    assert.equal(ipRateBucket("2001:0db8:85a3:0012:ffff:ffff:ffff:0001"), "2001:db8:85a3:12::/64");
    assert.equal(ipRateBucket("::ffff:192.0.2.9"), "192.0.2.9");
    assert.equal(ipRateBucket("192.0.2.9"), "192.0.2.9");
    assert.equal(ipRateBucket(""), "unknown");
    await quietly(async () => {
      for (let i = 1; i <= 30; i += 1) {
        const r = await optOut(`v6-${i}@example.com`, "Nobody We Know", { ip: `2001:db8:aaaa:1::${i.toString(16)}` });
        assert.equal(r.status, 200, `address ${i} of the /64`);
      }
      assert.equal((await optOut("v6-31@example.com", "Nobody We Know", { ip: "2001:db8:aaaa:1::ff" })).status, 429, "the 31st address in the /64");
      assert.equal((await optOut("v6-other@example.com", "Nobody We Know", { ip: "2001:db8:aaaa:2::1" })).status, 200, "another /64");
    });
  });

  await check("a pinned workspace that is gone does not lose the opt-out: it is filed for every sender", async () => {
    // Production enforces the tenant foreign key; this stands in for it.
    await db.execute(`CREATE TRIGGER fk_gone BEFORE INSERT ON email_suppressions WHEN NEW.tenant_id = '${OASIS_SUPPRESSION_TENANT_ID}'
      BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END`);
    try {
      const r = await quietly(() => optOut("pin-gone@example.com", "OASIS AI"));
      assert.equal(r.status, 200);
      assert.deepEqual(r.rows, [{ tenant_id: null, brand: "OASIS AI" }]);
    } finally {
      await db.execute("DROP TRIGGER fk_gone");
    }
  });

  await check("an alert to OASIS's own team is not stopped by an opt-out filed for a founder; anyone else's opt-out still stops the same send", async () => {
    const { sendOasisSharedGmail, isInternalTeamAlert } = await import("../lib/integrations/oasis-shared-gmail-send");
    const { OASIS_PIPELINE_ASSIGNMENT_EMAILS } = await import("../lib/team");
    const [founder, cofounder] = OASIS_PIPELINE_ASSIGNMENT_EMAILS;
    await quietly(() => optOut(founder, "Nobody We Know"));
    await quietly(() => optOut("outsider@example.com", "Nobody We Know"));
    const send = (to: string, cc: string[] | null, internalAlert: boolean) =>
      quietly(() =>
        sendOasisSharedGmail({ tenantId: OASIS_SUPPRESSION_TENANT_ID, to, cc, subject: "New ticket", body: "x", purpose: "support", internalAlert }),
      );
    assert.notEqual((await send(founder, [cofounder], true)).reason, "suppressed", "the desk's alert to the team goes past the opt-out");
    assert.equal((await send(founder, null, false)).reason, "suppressed", "without the flag the opt-out still applies");
    assert.equal((await send("outsider@example.com", null, true)).reason, "suppressed", "the flag never carries mail to anyone else");
    assert.equal((await send(founder, ["outsider@example.com"], true)).reason, "suppressed", "nor with an outsider on Cc");
    assert.equal(isInternalTeamAlert({ internalAlert: true, to: founder, cc: `${cofounder}, outsider@example.com` }), false);
    const notify = readFileSync(join(__dirname, "..", "lib/delivery/notify.ts"), "utf8");
    assert.match(notify, /deps\.email\(\{ to, cc, subject, body, idempotencyKey: key, internalAlert: true \}\)/, "the desk's founder alerts set it");
  });

  await check("an estate-wide health check pages OASIS when global web opt-outs pass the hourly ceiling", async () => {
    // The cap bounds one address bucket; a /48 holds 65,536 of them. An alarm,
    // never a refusal (reviewer of #711, item 25).
    const { OPTOUT_CHECKS, GLOBAL_WEB_OPTOUTS_PER_HOUR_CEILING } = await import("../lib/health/optout-checks");
    const { ESTATE_WIDE_CHECKS } = await import("../lib/health/runner");
    const surge = OPTOUT_CHECKS[0];
    assert.ok(ESTATE_WIDE_CHECKS.some((c) => c.id === surge.id), "it runs in the estate-wide pass");
    assert.deepEqual(surge.rule, { kind: "must_be_below", ceiling: GLOBAL_WEB_OPTOUTS_PER_HOUR_CEILING });
    assert.equal(surge.lane, "operator");
    const filed = Number((await db.execute("SELECT count(*) AS n FROM email_suppressions WHERE tenant_id IS NULL AND source = 'web_form'")).rows[0].n);
    assert.ok(filed > GLOBAL_WEB_OPTOUTS_PER_HOUR_CEILING, `this test's own burst is past the ceiling (${filed})`);
    const service = getServiceSupabase();
    assert.equal(await surge.observe(service, "any workspace", Date.now() + 1000), filed, "every global web filing of the last hour, whichever workspace the run is under");
    assert.equal(await surge.observe(service, "any workspace", Date.now() + 2 * 3_600_000), 0, "two hours on, the window has moved past them");
    await db.execute("ALTER TABLE email_suppressions RENAME TO email_suppressions_offline");
    try {
      assert.equal(await surge.observe(service, "any workspace", Date.now()), null, "a failed read is check_broken, never zero");
    } finally {
      await db.execute("ALTER TABLE email_suppressions_offline RENAME TO email_suppressions");
    }
  });

  await check("every file that touches the opt-out table is a known reader or writer, and every sender reads through checkSuppression", async () => {
    const root = join(__dirname, "..");
    // Every file under lib/ and app/ whose CODE touches the table, in the
    // builder form or in raw SQL, and why. A new one fails here until someone
    // decides what it is: a sender must read through checkSuppression (global
    // rows, a literal match, fail closed). The first version of this guard
    // matched one statement shape only (reviewer of #711).
    const known: Record<string, "reader" | "writer"> = {
      "lib/email/suppression-scope.ts": "reader", // the lookup every sender calls
      "lib/metrics/index.ts": "reader", // counts a workspace's opt-outs for its dashboard; never decides a send
      "lib/health/optout-checks.ts": "reader", // counts global web filings for the surge alarm; never decides a send
      "app/api/unsubscribe/route.ts": "writer",
      "app/api/cron/collect-cc-metrics/route.ts": "writer", // Constant Contact opt-outs
      "app/api/integrations/smartlead/webhook/route.ts": "writer",
      "lib/delivery/email-intake.ts": "writer", // an inbound STOP; its SELECT only dedupes the insert
    };
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const touches: string[] = [];
    const builderReaders: string[] = [];
    for (const path of [...walk(join(root, "lib")), ...walk(join(root, "app"))]) {
      const code = stripComments(readFileSync(path, "utf8"));
      const rel = relative(root, path).replace(/\\/g, "/");
      // The table's name as a string anywhere in the code, too: a name held in
      // a constant and passed to .from() later was not seen (reviewer of #711,
      // item 27).
      if (/\.from\(\s*["'`]email_suppressions["'`]\s*\)|\b(?:from|into|update|join)\s+["'`]?email_suppressions\b|["'`]email_suppressions["'`]/i.test(code)) touches.push(rel);
      for (const m of code.matchAll(/\.from\(\s*["'`]email_suppressions["'`]\s*\)/g)) {
        const statement = code.slice(m.index, code.indexOf(";", m.index));
        if (/\.select\(/.test(statement)) builderReaders.push(rel);
      }
    }
    assert.deepEqual(touches.filter((rel) => !(rel in known)).sort(), [],
      "a new file touches email_suppressions: add it to this list on purpose (and read through checkSuppression if it sends)");
    assert.deepEqual([...new Set(builderReaders)].filter((rel) => known[rel] !== "reader").sort(), [],
      "read opt-outs with checkSuppression (lib/email/suppression-scope.ts), which reads global rows and fails closed");
    for (const rel of Object.keys(known)) assert.ok(touches.includes(rel), `${rel} no longer touches the table: drop it from this list`);
    for (const sender of ["lib/lead-interactions-queries.ts", "lib/bulk-email/dispatch.ts", "lib/forms/oasis-funnel-email.ts", "lib/forms/next-steps-email.ts"]) {
      assert.match(readFileSync(join(root, sender), "utf8"), /checkSuppression\(/, `${sender} checks opt-outs before it sends`);
    }
  });

  await check("every opt-out link carries a brand whose filing was decided: pinned to a workspace, or knowingly global", async () => {
    // A sender that puts a NEW brand on its opt-out links has its opt-outs
    // filed globally, for every sender (only OASIS's support mail is pinned,
    // lib/email/support-mailbox.ts). That may be right for it, but it has to be
    // a decision: add the brand here, or pin it (reviewer of #711).
    const root = join(__dirname, "..");
    const decided = new Set([
      "OASIS_SUPPRESSION_BRAND", // pinned to OASIS's own workspace
      "SUNBIZ_BRAND", // SunBiz is retired: its opt-outs file globally
      '"SunBiz"',
      '""', // no brand, knowingly global: the templates gallery (app/api/templates/send)
    ]);
    // tracked-html's own wrappers pass their `brand` parameter through. Only
    // there: anywhere else, an identifier that happens to be named `brand`
    // would wave through a brand nobody decided (reviewer of #711, item 27).
    const isPassthrough = (rel: string, brand: string) => brand === "brand" && rel === "lib/email/tracked-html.ts";
    const seen: string[] = [];
    const undecided: string[] = [];
    for (const path of [...walk(join(root, "lib")), ...walk(join(root, "app"))]) {
      const code = readFileSync(path, "utf8");
      const rel = relative(root, path).replace(/\\/g, "/");
      const calls = [
        ...code.matchAll(/\b(?:unsubscribeUrl|unsubscribeApiUrl|listUnsubscribeHeader)\(\s*[^,()]+,\s*([^,)]+)/g),
        ...code.matchAll(/\bbuildTrackedHtml\([^)]*?\bbrand:\s*([^,}\s]+)/g),
      ];
      for (const m of calls) {
        if (/function\s+$/.test(code.slice(Math.max(0, (m.index ?? 0) - 12), m.index))) continue; // a definition, not a call
        const brand = m[1].trim();
        seen.push(`${rel}: ${brand}`);
        if (!decided.has(brand) && !isPassthrough(rel, brand)) undecided.push(`${rel}: ${brand}`);
      }
    }
    assert.ok(seen.length >= 6, `the scan found the senders' links (${seen.length}): ${seen.join("; ")}`);
    assert.deepEqual(undecided, [], "decide where these brands' opt-outs file: pin the brand, or add it here as knowingly global");
  });

  await check("no link a person clicks points at the API: a click is a GET, and /api/unsubscribe answers only POST", async () => {
    // The templates gallery's {{unsubscribe_url}} was /api/unsubscribe?email=...:
    // every click answered 405 and opted nobody out (2026-10-20). The page
    // (unsubscribeUrl) confirms and posts; the API URL is only the RFC 8058
    // one-click target, which mail clients POST (unsubscribeApiUrl).
    const root = join(__dirname, "..");
    const route = await import("../app/api/unsubscribe/route");
    assert.equal(typeof (route as Record<string, unknown>).GET, "undefined", "if the API ever answers GET, revisit this check");
    const builders: string[] = [];
    for (const path of [...walk(join(root, "lib")), ...walk(join(root, "app"))]) {
      const rel = relative(root, path).replace(/\\/g, "/");
      if (rel === "lib/email/tracked-html.ts") continue; // unsubscribeApiUrl, the one-click POST target
      const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      if (/\/api\/unsubscribe\?/.test(code)) builders.push(rel);
    }
    assert.deepEqual(builders, [], "build a clickable opt-out link with unsubscribeUrl (lib/email/tracked-html.ts)");
    assert.match(readFileSync(join(root, "app/api/templates/send/route.ts"), "utf8"), /const realUnsubscribe = unsubscribeUrl\(toEmail, "", new URL\(req\.url\)\.origin\);/);
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
