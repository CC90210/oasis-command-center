/**
 * cold-sending-retired.test.ts — cold sending is off for every workspace: it can
 * only send as SunBiz (its footer carries SunBiz Funding LLC's name and Florida
 * address, its opt-outs file under "SunBiz"), and SunBiz is retired.
 *
 * WHAT IS PINNED.
 *   - sendColdEmail refuses with reason "retired" before reading anything: a
 *     ready mailbox with headroom sends nothing and its daily count is unchanged;
 *   - registerColdMailbox stores nothing;
 *   - the blast and the mailbox registration answer 410 cold_sending_retired, and
 *     registration answers before any SMTP login is tried;
 *   - an existing mailbox can still be paused and removed;
 *   - the reason a caller sees names neither SunBiz nor an address.
 * (tests/role-gates-and-platform-keys.test.ts pins the same 410 behind the scan
 * key's workspace check and for a signed-in client admin.)
 *
 * Run: node --conditions=react-server --import tsx tests/cold-sending-retired.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";
import { NextRequest } from "next/server";

const dbFile = join(mkdtempSync(join(tmpdir(), "cold-sending-retired-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
const SCAN_KEY = "scan-trigger-key-cold-sending-retired-01";
process.env.SCAN_TRIGGER_SECRET = SCAN_KEY;
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "cold-sending-retired-field-key-000001";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // OASIS_ENV_CREDENTIAL_TENANT_IDS
const MAILBOX = "mbx-ready-1";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
// Every SMTP touch is recorded: a login check (verify) or a send.
const smtp: string[] = [];
stub("nodemailer", {
  createTransport: () => ({
    verify: async () => { smtp.push("verify"); return true; },
    sendMail: async () => { smtp.push("send"); return { messageId: "<cold-sending-retired@test>" }; },
  }),
});
stub("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
});

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`);
  }
}

const db = createClient({ url: `file:${dbFile}` });
const scalar = async (sql: string, args: (string | number)[] = []) => Number((await db.execute({ sql, args })).rows[0]?.v ?? NaN);

function call(method: string, body: unknown) {
  return new NextRequest("http://localhost/api/cold-sending/x", {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${SCAN_KEY}` },
    body: JSON.stringify(body),
  });
}

async function main() {
  await db.executeMultiple(`
    CREATE TABLE cold_sending_mailboxes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, domain TEXT NOT NULL,
      address TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'app_password', app_password_enc TEXT, api_ref TEXT,
      daily_cap INTEGER NOT NULL DEFAULT 30, sends_today INTEGER NOT NULL DEFAULT 0, sends_date TEXT, last_send_at TEXT,
      warmup_status TEXT NOT NULL DEFAULT 'warming', active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT,
      UNIQUE (tenant_id, address));
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT,
      direction TEXT, agent_source TEXT, to_email TEXT, subject TEXT, content_preview TEXT, provider TEXT,
      provider_message_id TEXT, metadata TEXT, created_at TEXT);
    CREATE TABLE email_suppressions (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT, brand TEXT, reason TEXT, added_at TEXT);
  `);
  await db.execute({
    sql: `INSERT INTO cold_sending_mailboxes (id, tenant_id, domain, address, app_password_enc, warmup_status, active, created_at)
          VALUES (?, ?, 'cold.test', 'hi@cold.test', 'not-decrypted', 'ready', 1, '2026-10-01T00:00:00Z')`,
    args: [MAILBOX, OASIS],
  });

  const lib = await import("../lib/integrations/cold-sending");
  const blast = await import("../app/api/cold-sending/blast/route");
  const mailboxes = await import("../app/api/cold-sending/mailboxes/route");

  await check("sendColdEmail refuses as retired; a ready mailbox with headroom sends nothing", async () => {
    smtp.length = 0;
    const r = await lib.sendColdEmail({ tenantId: OASIS, to: "owner@prospect.test", subject: "Hi", body: "Hello" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "retired");
    assert.deepEqual(smtp, [], "no SMTP touch");
    assert.equal(await scalar("SELECT sends_today AS v FROM cold_sending_mailboxes WHERE id = ?", [MAILBOX]), 0);
    assert.equal(await scalar("SELECT count(*) AS v FROM lead_interactions"), 0);
  });

  await check("registerColdMailbox stores nothing", async () => {
    const r = await lib.registerColdMailbox({ tenantId: OASIS, domain: "new.test", address: "a@new.test", appPassword: "abcdefghijklmnop" });
    assert.deepEqual(r, { ok: false, error: "cold_sending_retired" });
    assert.equal(await scalar("SELECT count(*) AS v FROM cold_sending_mailboxes WHERE address = 'a@new.test'"), 0);
  });

  await check("the blast answers 410 cold_sending_retired and sends nothing", async () => {
    smtp.length = 0;
    const res = await blast.POST(call("POST", { tenantId: OASIS, subject: "Quick question", body: "A minute this week?", recipients: ["owner@prospect.test"] }));
    assert.equal(res.status, 410);
    const body = await res.json();
    assert.equal(body.error, "cold_sending_retired");
    assert.deepEqual(smtp, []);
    assert.equal(await scalar("SELECT sends_today AS v FROM cold_sending_mailboxes WHERE id = ?", [MAILBOX]), 0);
  });

  await check("registering a mailbox answers 410 before any SMTP login is tried", async () => {
    smtp.length = 0;
    const res = await mailboxes.POST(call("POST", { tenantId: OASIS, domain: "new.test", address: "b@new.test", app_password: "abcd efgh ijkl mnop" }));
    assert.equal(res.status, 410);
    assert.equal((await res.json()).error, "cold_sending_retired");
    assert.deepEqual(smtp, [], "the app password was tried against SMTP");
    assert.equal(await scalar("SELECT count(*) AS v FROM cold_sending_mailboxes WHERE address = 'b@new.test'"), 0);
  });

  await check("an existing mailbox can still be paused and removed", async () => {
    const pause = await mailboxes.PATCH(call("PATCH", { tenantId: OASIS, id: MAILBOX, warmup_status: "paused" }));
    assert.equal(pause.status, 200, JSON.stringify(await pause.clone().json()));
    assert.equal((await db.execute({ sql: "SELECT warmup_status AS v FROM cold_sending_mailboxes WHERE id = ?", args: [MAILBOX] })).rows[0].v, "paused");
    const off = await mailboxes.DELETE(call("DELETE", { tenantId: OASIS, id: MAILBOX }));
    assert.equal(off.status, 200, JSON.stringify(await off.clone().json()));
    assert.equal(await scalar("SELECT active AS v FROM cold_sending_mailboxes WHERE id = ?", [MAILBOX]), 0);
  });

  await check("the refusal a caller reads names no company and no address", () => {
    const text = JSON.stringify(lib.COLD_SENDING_OFF);
    assert.doesNotMatch(text, /sunbiz|broward|lauderdale|\bFL\b/i);
    assert.equal(lib.COLD_SENDING_ENABLED, false);
  });

  if (failures > 0) {
    console.log(`\ncold-sending-retired.test.ts — ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\ncold-sending-retired.test.ts — cold sending off for every workspace, pause and remove still work ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
