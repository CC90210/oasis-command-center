/**
 * dispatch-scheduled-sends-deactivated-sender.test.ts — a scheduled send goes
 * out AS the teammate who queued it (their Gmail, their TextTorrent line), so a
 * row queued before that teammate was deactivated must never fire: it would
 * send from a retired person's mailbox and route the replies back to them.
 *
 * Drives GET /api/cron/dispatch-scheduled-sends for real against a local
 * libSQL database: claim, standing check, suppression checks, the SunBiz
 * agent-identity lookup, the queue state transitions and the lead_interactions
 * log all execute. Stand-ins record what they were asked instead of reaching
 * the network: the two Gmail senders, the TextTorrent client and the
 * conversations nudge.
 *
 * Run: node --conditions=react-server --import tsx tests/dispatch-scheduled-sends-deactivated-sender.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "dispatch-deactivated-sender-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.CRON_SECRET = "dispatch-deactivated-sender-cron-secret";
delete process.env.CRON_ALLOW_LOCAL;
// SMS must take the LIVE TextTorrent branch so a send is observable; the
// client below is a recorder.
delete process.env.BRAVO_FORCE_DRY_RUN;
process.env.LIVE_SEND_TEXTTORRENT = "1";

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = {
    id: path,
    filename: path,
    path: dirname(path),
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
}

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // brand "oasis"
const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110"; // brand "sunbiz"
const AVA = "3d3d3d3d-0000-4000-8000-000000000001"; // active on OASIS
const BEN = "3d3d3d3d-0000-4000-8000-000000000002"; // active on OASIS
const RILEY = "3d3d3d3d-0000-4000-8000-000000000003"; // deactivated on OASIS, active on SunBiz
const JORDAN = "3d3d3d3d-0000-4000-8000-000000000004"; // deactivated on SunBiz
const STRANGER = "3d3d3d3d-0000-4000-8000-000000000005"; // a member of SunBiz only
const RETIRED_AT = "2026-09-24T12:00:00Z";
const RILEY_DID = "+15145550103";
const JORDAN_DID = "+15145550104";

// Gmail: which mailboxes are connected, and every probe/send made.
const appPasswordMailboxes = new Set([`${OASIS}:${AVA}`, `${OASIS}:${BEN}`, `${OASIS}:${RILEY}`]);
const mailboxProbes: string[] = [];
type GmailSend = { tenantId: string; userId: string; to: string; idempotencyKey: string };
const gmailSends: GmailSend[] = [];
let onGmailSend: (() => Promise<void>) | null = null;
stubModule(require.resolve("../lib/integrations/gmail-apppassword-send"), {
  operatorHasAppPassword: async (tenantId: string, userId: string) => {
    mailboxProbes.push(`app_password:${tenantId}:${userId}`);
    return appPasswordMailboxes.has(`${tenantId}:${userId}`);
  },
  sendGmailAppPasswordAsOperator: async (args: GmailSend) => {
    gmailSends.push({ tenantId: args.tenantId, userId: args.userId, to: args.to, idempotencyKey: args.idempotencyKey });
    const hook = onGmailSend;
    onGmailSend = null;
    if (hook) await hook();
    return { ok: true, from_address: `${args.userId}@mail.test`, gmail_message_id: `gm-${gmailSends.length}` };
  },
});
stubModule(require.resolve("../lib/integrations/gmail-oauth-send"), {
  operatorHasGmailOAuth: async (tenantId: string, userId: string) => {
    mailboxProbes.push(`oauth:${tenantId}:${userId}`);
    return false;
  },
  sendGmailAsOperator: async () => {
    throw new Error("no OAuth mailbox is connected in this test");
  },
});

class TextTorrentError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const ttCredentialAsks: string[] = [];
const smsSends: Array<{ number: string; sender_id: string }> = [];
stubModule(require.resolve("../lib/integrations/texttorrent"), {
  TextTorrentError,
  getTextTorrentCredentials: async (tenantId: string, opts: { actAsEmail: string }) => {
    ttCredentialAsks.push(`${tenantId}:${opts.actAsEmail}`);
    return { tenantId };
  },
  sendSms: async (_creds: unknown, payload: { number: string; sender_id: string }) => {
    smsSends.push({ number: payload.number, sender_id: payload.sender_id });
    return { ok: true };
  },
});

stubModule(require.resolve("../lib/realtime/conversations-nudge"), {
  nudgeConversations: async () => undefined,
});

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n")[0]}`);
  }
}

const WARN_TAG = "[dispatch-scheduled-sends] sender deactivated";
const ERROR_TAG = "[dispatch-scheduled-sends] sender standing check failed";

async function main() {
  const seed = createClient({ url: `file:${dbFile}` });
  const NOW_SQL = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
  await seed.executeMultiple(`
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0, full_name TEXT,
      display_name TEXT, invited_by TEXT, joined_at TEXT, manager_user_id TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT);
    CREATE TABLE scheduled_sends (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, lead_id TEXT,
      thread_key TEXT NOT NULL, channel TEXT NOT NULL, to_phone TEXT, to_email TEXT, subject TEXT,
      body TEXT NOT NULL, actor_user_id TEXT NOT NULL, from_identity TEXT, scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT DEFAULT ${NOW_SQL}, sent_at TEXT, claimed_at TEXT);
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT, agent_source TEXT,
      to_phone TEXT, to_email TEXT, from_phone TEXT, subject TEXT, content TEXT, content_preview TEXT,
      actor_user_id TEXT, metadata TEXT, created_at TEXT DEFAULT ${NOW_SQL});
    CREATE TABLE email_suppressions (tenant_id TEXT, email TEXT);
    CREATE TABLE sunbiz_phone_suppressions (tenant_id TEXT, phone_last10 TEXT);
    CREATE TABLE sunbiz_agent_accounts (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, provider TEXT,
      enabled INTEGER, act_as_email TEXT, daily_cap INTEGER, from_number TEXT);
  `);
  const profile = (id: string, tenantId: string, authId: string, name: string, deactivatedAt: string | null = null) => ({
    sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, full_name, joined_at, deactivated_at)
          VALUES (?, ?, ?, ?, 'agent', ?, '2026-09-01T00:00:00Z', ?)`,
    args: [id, authId, `${name.toLowerCase()}@team.test`, tenantId, name, deactivatedAt],
  });
  const line = (id: string, userId: string, actAs: string, did: string) => ({
    sql: `INSERT INTO sunbiz_agent_accounts (id, tenant_id, user_id, provider, enabled, act_as_email, daily_cap, from_number)
          VALUES (?, ?, ?, 'texttorrent', 1, ?, 100, ?)`,
    args: [id, SUNBIZ, userId, actAs, did],
  });
  await seed.batch(
    [
      profile("p-ava", OASIS, AVA, "Ava"),
      profile("p-ben", OASIS, BEN, "Ben"),
      profile("p-riley-oasis", OASIS, RILEY, "Riley", RETIRED_AT),
      // Riley still works on SunBiz. Standing is read in the ROW's tenant, so
      // this row decides Riley's SunBiz sends and never their OASIS ones.
      profile("p-riley-sunbiz", SUNBIZ, RILEY, "Riley"),
      profile("p-jordan", SUNBIZ, JORDAN, "Jordan", RETIRED_AT),
      profile("p-stranger", SUNBIZ, STRANGER, "Sam"),
      line("line-riley", RILEY, "riley@sunbiz.test", RILEY_DID),
      line("line-jordan", JORDAN, "jordan@sunbiz.test", JORDAN_DID),
    ],
    "write",
  );

  let minutesAgo = 120;
  const queue = async (
    id: string,
    tenantId: string,
    actor: string,
    channel: "email" | "sms",
    fromIdentity: string,
  ) => {
    minutesAgo -= 1; // scheduled_for ascending == processing order
    await seed.execute({
      sql: `INSERT INTO scheduled_sends (id, tenant_id, lead_id, thread_key, channel, to_phone, to_email,
              subject, body, actor_user_id, from_identity, scheduled_for)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'Following up on your file.', ?, ?, ?)`,
      args: [
        id, tenantId, `id:${id}`, channel,
        channel === "sms" ? "+15145559999" : null,
        channel === "email" ? "client@example.com" : null,
        channel === "email" ? "Your file" : null,
        actor, fromIdentity, new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      ],
    });
  };
  const rowOf = async (id: string) =>
    (await seed.execute({ sql: "SELECT status, attempts, last_error, claimed_at, sent_at FROM scheduled_sends WHERE id = ?", args: [id] })).rows[0];
  const loggedActors = async () =>
    (await seed.execute("SELECT actor_user_id, channel FROM lead_interactions ORDER BY rowid")).rows.map(
      (r) => `${r.channel}:${r.actor_user_id}`,
    );

  const { GET } = await import("../app/api/cron/dispatch-scheduled-sends/route");
  const { NextRequest } = await import("next/server");
  type DispatchBody = { ok: boolean; processed?: number; sent?: number; failed?: number; error?: string };
  const dispatch = async () => {
    mailboxProbes.length = 0;
    gmailSends.length = 0;
    ttCredentialAsks.length = 0;
    smsSends.length = 0;
    const warned: unknown[][] = [];
    const errored: unknown[][] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => void warned.push(args);
    console.error = (...args: unknown[]) => void errored.push(args);
    try {
      const res = await GET(
        new NextRequest("http://localhost/api/cron/dispatch-scheduled-sends", {
          headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "x-vercel-cron": "1" },
        }),
      );
      const body = (await res.json()) as DispatchBody;
      assert.equal(res.status, 200, `dispatch status (${body.error ?? ""})`);
      return { body, warned, errored };
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  };
  const tagged = (logged: unknown[][], tag: string) => logged.filter((args) => args[0] === tag);

  // ── Pass 1: one batch, active and deactivated senders mixed ───────────────
  await queue("ss-ava-email", OASIS, AVA, "email", "ava@mail.test");
  await queue("ss-riley-oasis-email", OASIS, RILEY, "email", "riley@mail.test");
  await queue("ss-jordan-sms", SUNBIZ, JORDAN, "sms", JORDAN_DID);
  await queue("ss-riley-sunbiz-sms", SUNBIZ, RILEY, "sms", RILEY_DID);
  const pass1 = await dispatch();

  await check("a deactivated sender's email is failed as sender_deactivated and never sent", async () => {
    const row = await rowOf("ss-riley-oasis-email");
    assert.equal(row.status, "failed");
    assert.equal(row.last_error, "sender_deactivated");
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.claimed_at, null);
    assert.equal(row.sent_at, null);
    assert.ok(!gmailSends.some((s) => s.userId === RILEY), "nothing may leave Riley's mailbox");
    assert.ok(
      !mailboxProbes.some((p) => p.endsWith(`${OASIS}:${RILEY}`)),
      "no lane is chosen, so Riley's OASIS mailbox is never even probed",
    );
  });

  await check("a deactivated sender's SMS is failed as sender_deactivated; their line is never used", async () => {
    const row = await rowOf("ss-jordan-sms");
    assert.equal(row.status, "failed");
    assert.equal(row.last_error, "sender_deactivated");
    assert.equal(Number(row.attempts), 1);
    assert.ok(!smsSends.some((s) => s.sender_id === JORDAN_DID), "nothing may leave Jordan's line");
    assert.ok(!ttCredentialAsks.some((a) => a.includes("jordan@")), "Jordan's sub-account is never acted as");
  });

  await check("each withheld row is logged with its id and tenant", async () => {
    const warns = tagged(pass1.warned, WARN_TAG).map((args) => args[1]);
    assert.deepEqual(warns, [
      { id: "ss-riley-oasis-email", tenant: OASIS },
      { id: "ss-jordan-sms", tenant: SUNBIZ },
    ]);
  });

  // Scoped to the active sender, so these hold on the unfixed route too: the
  // standing check changes nothing for an active teammate.
  await check("an active sender's email goes out exactly as before, from their own mailbox", async () => {
    assert.deepEqual(gmailSends.filter((s) => s.userId === AVA), [
      { tenantId: OASIS, userId: AVA, to: "client@example.com", idempotencyKey: "scheduled-send:ss-ava-email" },
    ]);
    assert.deepEqual(mailboxProbes.filter((p) => p.endsWith(`:${AVA}`)), [`app_password:${OASIS}:${AVA}`]);
    const row = await rowOf("ss-ava-email");
    assert.equal(row.status, "sent");
    assert.equal(Number(row.attempts), 0);
    assert.equal(row.last_error, null);
    assert.ok(row.sent_at);
  });

  await check("standing is the row's tenant: Riley, active on SunBiz, still sends from their SunBiz line", async () => {
    assert.deepEqual(smsSends.filter((s) => s.sender_id === RILEY_DID), [{ number: "+15145559999", sender_id: RILEY_DID }]);
    assert.deepEqual(ttCredentialAsks.filter((a) => a.includes("riley@")), [`${SUNBIZ}:riley@sunbiz.test`]);
    assert.equal((await rowOf("ss-riley-sunbiz-sms")).status, "sent");
  });

  await check("only the active senders' messages went out and are logged, and the tally agrees", async () => {
    assert.equal(gmailSends.length, 1);
    assert.equal(smsSends.length, 1);
    assert.deepEqual(await loggedActors(), [`email:${AVA}`, `sms:${RILEY}`]);
    assert.equal(pass1.body.processed, 4);
    assert.equal(pass1.body.sent, 2);
    assert.equal(pass1.body.failed, 2);
  });

  // ── Pass 2: the standing read fails ───────────────────────────────────────
  await queue("ss-ava-retry", OASIS, AVA, "email", "ava@mail.test");
  await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
  const pass2 = await dispatch();
  await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");

  await check("a failed standing read requeues the row through the retry path and sends nothing", async () => {
    const row = await rowOf("ss-ava-retry");
    assert.equal(row.status, "pending");
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.last_error, "sender_standing_check_failed");
    assert.equal(row.claimed_at, null);
    assert.deepEqual(gmailSends, [], "an unknown standing must not send as the person");
    assert.deepEqual(mailboxProbes, [], "no lane is chosen");
    const errors = tagged(pass2.errored, ERROR_TAG);
    assert.equal(errors.length, 1, "the failed read is logged loudly");
    assert.equal((errors[0][1] as { id?: string }).id, "ss-ava-retry");
  });

  // ── Pass 3: the requeued row once standing reads again ────────────────────
  await dispatch();

  await check("the requeued row sends on the next pass once standing can be read", async () => {
    assert.deepEqual(gmailSends.map((s) => s.idempotencyKey), ["scheduled-send:ss-ava-retry"]);
    const row = await rowOf("ss-ava-retry");
    assert.equal(row.status, "sent");
    assert.equal(Number(row.attempts), 1);
  });

  // ── Pass 4: standing is read once per (tenant, actor) per pass ────────────
  await queue("ss-ava-first", OASIS, AVA, "email", "ava@mail.test");
  await queue("ss-ava-second", OASIS, AVA, "email", "ava@mail.test");
  await queue("ss-ben", OASIS, BEN, "email", "ben@mail.test");
  // Take the roster away the moment Ava's first row is handed to Gmail: any
  // standing read after that point fails.
  onGmailSend = async () => {
    await seed.execute("ALTER TABLE user_profiles RENAME TO user_profiles_offline");
  };
  await dispatch();
  onGmailSend = null;
  await seed.execute("ALTER TABLE user_profiles_offline RENAME TO user_profiles");

  await check("a second row by the same sender reuses the standing already read this pass", async () => {
    assert.deepEqual(gmailSends.map((s) => s.idempotencyKey), [
      "scheduled-send:ss-ava-first",
      "scheduled-send:ss-ava-second",
    ]);
    assert.equal((await rowOf("ss-ava-second")).status, "sent");
  });

  await check("a sender not yet read this pass is read, and its failure retries only that row", async () => {
    const row = await rowOf("ss-ben");
    assert.equal(row.status, "pending");
    assert.equal(row.last_error, "sender_standing_check_failed");
    assert.ok(!gmailSends.some((s) => s.userId === BEN));
  });
  // Park whatever pass 4 requeued so pass 5 dispatches only its own row.
  await seed.execute("UPDATE scheduled_sends SET status = 'cancelled' WHERE status = 'pending'");

  // ── Pass 5: an actor who is not a member of the row's tenant ──────────────
  await queue("ss-stranger", OASIS, STRANGER, "email", "sam@mail.test");
  const pass5 = await dispatch();

  await check("a non-member keeps today's behaviour: the lane's own tenant-scoped mailbox lookup decides", async () => {
    assert.deepEqual(mailboxProbes, [`app_password:${OASIS}:${STRANGER}`, `oauth:${OASIS}:${STRANGER}`]);
    assert.deepEqual(gmailSends, []);
    const row = await rowOf("ss-stranger");
    assert.equal(row.status, "pending");
    assert.match(String(row.last_error), /^not_connected: /);
    assert.deepEqual(tagged(pass5.warned, WARN_TAG), []);
  });

  if (failures) {
    console.error(`dispatch-scheduled-sends deactivated sender: ${failures} FAILED`);
    process.exit(1);
  }
  console.log("dispatch-scheduled-sends deactivated sender: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
