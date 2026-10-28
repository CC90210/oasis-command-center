/**
 * Quo's inbound STOP intake (app/api/webhooks/quo, lib/integrations/quo-webhook.ts):
 * a STOP texted back to OASIS's Quo number reaches the STOP list, cancels the
 * meeting texts queued to that number, and the next automated text to it is
 * refused. Only a correctly signed delivery is read, and automated texts stay
 * off until one has been (quoStopIntakeConnected). Runs the real route against
 * a local libSQL file.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "quo-stop-intake-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
const KEY_BYTES = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `whsec_${KEY_BYTES.toString("base64")}`;
process.env.QUO_WEBHOOK_SIGNING_KEY = SECRET;
process.env.LIVE_SEND_QUO = "1";
delete process.env.BRAVO_FORCE_DRY_RUN;

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const LEAD_PHONE = "+14165550123";

function sign(id: string, ts: number, body: string, key: Buffer = KEY_BYTES): string {
  return `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
}

async function main() {
  const { verifyQuoWebhook, parseQuoEvent, quoWebhookKeyConfigured } = await import("../lib/integrations/quo-webhook");
  const now = Date.now();
  const ts = Math.floor(now / 1000);
  const body = JSON.stringify({ id: "evt_1", type: "message.received" });

  // Signature: only Quo's own key over id.timestamp.body passes, and only fresh.
  assert.deepEqual(verifyQuoWebhook({ id: "msg_1", timestamp: String(ts), signature: sign("msg_1", ts, body), rawBody: body, secret: SECRET, nowMs: now }), { ok: true });
  assert.deepEqual(
    verifyQuoWebhook({ id: "msg_1", timestamp: String(ts), signature: `v1,bogus ${sign("msg_1", ts, body)}`, rawBody: body, secret: SECRET, nowMs: now }),
    { ok: true },
    "any one valid v1 entry passes",
  );
  assert.equal(verifyQuoWebhook({ id: "msg_1", timestamp: String(ts), signature: sign("msg_1", ts, body), rawBody: `${body} `, secret: SECRET, nowMs: now }).ok, false, "a changed body fails");
  assert.equal(verifyQuoWebhook({ id: "msg_2", timestamp: String(ts), signature: sign("msg_1", ts, body), rawBody: body, secret: SECRET, nowMs: now }).ok, false, "another delivery's signature fails");
  assert.deepEqual(
    verifyQuoWebhook({ id: "msg_1", timestamp: String(ts - 301), signature: sign("msg_1", ts - 301, body), rawBody: body, secret: SECRET, nowMs: now }),
    { ok: false, reason: "stale_timestamp" },
  );
  assert.deepEqual(
    verifyQuoWebhook({ id: "msg_1", timestamp: String(ts), signature: sign("msg_1", ts, body, Buffer.from("x".repeat(32))), rawBody: body, secret: SECRET, nowMs: now }),
    { ok: false, reason: "bad_signature" },
  );
  assert.deepEqual(verifyQuoWebhook({ id: "msg_1", timestamp: String(ts), signature: "v1,x", rawBody: body, secret: undefined, nowMs: now }), { ok: false, reason: "not_configured" });
  assert.equal(quoWebhookKeyConfigured({ QUO_WEBHOOK_SIGNING_KEY: "whsec_short" }), false);
  assert.equal(quoWebhookKeyConfigured({ QUO_WEBHOOK_SIGNING_KEY: SECRET }), true);

  // Both payload shapes read; anything else is null, never guessed.
  assert.deepEqual(
    parseQuoEvent({ id: "e1", type: "message.received", resource: { id: "m1", text: "STOP", direction: "incoming" }, context: { senderIdentifier: { phoneNumber: LEAD_PHONE } } }),
    { eventId: "e1", type: "message.received", direction: "incoming", from: LEAD_PHONE, text: "STOP", messageId: "m1" },
  );
  assert.deepEqual(
    parseQuoEvent({ id: "e2", type: "message.received", data: { object: { id: "m2", from: LEAD_PHONE, to: ["+13653603976"], body: "stop", direction: "incoming" } } }),
    { eventId: "e2", type: "message.received", direction: "incoming", from: LEAD_PHONE, text: "stop", messageId: "m2" },
  );
  assert.equal(parseQuoEvent({ type: "call.completed" }).from, null);

  // The real route on a local database.
  const seed = createClient({ url: `file:${dbFile}` });
  await seed.executeMultiple(`
    CREATE TABLE sunbiz_phone_suppressions (tenant_id TEXT NOT NULL, phone_last10 TEXT NOT NULL, reason TEXT, source TEXT,
      updated_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (tenant_id, phone_last10));
    CREATE TABLE lead_interactions (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT, lead_id TEXT,
      type TEXT, channel TEXT, direction TEXT, agent_source TEXT, from_phone TEXT, to_phone TEXT, subject TEXT, content TEXT,
      content_preview TEXT, metadata TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE website_sales_meeting_notifications (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, channel TEXT NOT NULL,
      recipient TEXT NOT NULL, status TEXT NOT NULL, claimed_at TEXT, last_error TEXT, updated_at TEXT);
    ${readFileSync("database/turso/bravo__251_quo_inbound_intake.sql", "utf8")}
    INSERT INTO website_sales_meeting_notifications (id, tenant_id, channel, recipient, status) VALUES
      ('t30', '${OASIS}', 'sms', '${LEAD_PHONE}', 'pending'),
      ('t5', '${OASIS}', 'sms', '${LEAD_PHONE}', 'pending'),
      ('mail', '${OASIS}', 'email', 'lead@example.com', 'pending');
  `);
  const { quoStopIntakeConnected, sendQuoSms } = await import("../lib/integrations/quo");
  const { POST } = await import("../app/api/webhooks/quo/route");
  const { NextRequest } = await import("next/server");
  const deliver = async (payload: unknown, opts: { id?: string; signed?: boolean } = {}) => {
    const raw = JSON.stringify(payload);
    const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
    const t = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(t) };
    if (opts.signed !== false) headers["webhook-signature"] = sign(id, t, raw);
    const res = await POST(new NextRequest("http://localhost/api/webhooks/quo", { method: "POST", headers, body: raw }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const health = async () =>
    (await seed.execute({ sql: "SELECT * FROM quo_inbound_health WHERE tenant_id = ?", args: [OASIS] })).rows[0];

  assert.equal(await quoStopIntakeConnected(OASIS), false, "no verified delivery yet: automated texts stay off");
  const unsigned = await deliver({ id: "e0", type: "message.received", resource: { text: "STOP" }, context: { senderIdentifier: LEAD_PHONE } }, { signed: false });
  assert.equal(unsigned.status, 401, "an unsigned delivery is refused");
  assert.equal(await health(), undefined, "and writes nothing");

  const stop = await deliver({ id: "e1", type: "message.received", resource: { id: "m1", text: "Stop please", direction: "incoming" }, context: { senderIdentifier: LEAD_PHONE } });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.stop, true);
  const suppressed = await seed.execute({ sql: "SELECT reason, source FROM sunbiz_phone_suppressions WHERE tenant_id = ? AND phone_last10 = ?", args: [OASIS, "4165550123"] });
  assert.deepEqual(suppressed.rows.map((r) => [r.reason, r.source]), [["OPT_OUT", "quo_inbound"]], "the number is on the STOP list");
  const outbox = await seed.execute({ sql: "SELECT id, status FROM website_sales_meeting_notifications ORDER BY id", args: [] });
  assert.deepEqual(outbox.rows.map((r) => `${r.id}:${r.status}`), ["mail:pending", "t30:cancelled", "t5:cancelled"], "its queued meeting texts are cancelled; email is untouched");
  const h = await health();
  assert.ok(h?.last_inbound_at && h?.last_stop_at, "the intake proof is recorded");
  assert.equal(await quoStopIntakeConnected(OASIS), true, "a verified, readable inbound text opens automated texts");
  assert.equal(await quoStopIntakeConnected(OASIS, { env: {} }), false, "never without the signing key");

  // The canary: the next text to that number is refused before Quo is called.
  const refused = await sendQuoSms({ tenantId: OASIS, apiKey: "test", fromNumber: "+13653603976" }, { to: LEAD_PHONE, text: "OASIS AI: Reminder" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "recipient_opted_out");

  // START lifts an SMS opt-out.
  const start = await deliver({ id: "e2", type: "message.received", data: { object: { id: "m2", from: LEAD_PHONE, body: "START", direction: "incoming" } } });
  assert.equal(start.status, 200);
  assert.equal(start.body.start, true);
  const after = await seed.execute({ sql: "SELECT count(*) AS n FROM sunbiz_phone_suppressions WHERE tenant_id = ?", args: [OASIS] });
  assert.equal(Number(after.rows[0].n), 0);

  // An ordinary reply is recorded as intake proof but changes nothing.
  const hello = await deliver({ id: "e3", type: "message.received", resource: { text: "See you at 2!", direction: "incoming" }, context: { senderIdentifier: LEAD_PHONE } });
  assert.equal(hello.status, 200);
  assert.equal(hello.body.stop, false);

  // No key on the Worker: the route says it is not installed.
  delete process.env.QUO_WEBHOOK_SIGNING_KEY;
  const noKey = await deliver({ id: "e4", type: "message.received", resource: { text: "STOP" }, context: { senderIdentifier: LEAD_PHONE } });
  assert.equal(noKey.status, 503);

  console.log("quo-stop-intake: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
