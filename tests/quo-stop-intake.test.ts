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
const QUO_NUMBER = "+13653603976";
const LEAD_PHONE = "+14165550123";

/** Quo's versioned envelope (https://www.quo.com/docs/2026-03-30/webhooks-event-payloads). */
function received(eventId: string, text: string, createdAt: string, from = LEAD_PHONE) {
  return {
    id: eventId,
    apiVersion: "2026-03-30",
    createdAt,
    type: "message.received",
    data: {
      resource: { id: `msg-${eventId}`, text, direction: "incoming", createdAt },
      context: { senderIdentifier: from, recipientIdentifiers: [QUO_NUMBER] },
      links: { quo: null },
    },
  };
}

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

  // Quo's real versioned envelope (resource/context under data), and the legacy shape.
  assert.deepEqual(
    parseQuoEvent(received("e1", "STOP", "2026-10-28T23:00:00.000Z")),
    {
      eventId: "e1", type: "message.received", direction: "incoming", from: LEAD_PHONE, text: "STOP",
      messageId: "msg-e1", to: QUO_NUMBER, occurredAt: "2026-10-28T23:00:00.000Z",
    },
  );
  assert.deepEqual(
    parseQuoEvent({ id: "e2", type: "message.received", data: { object: { id: "m2", from: LEAD_PHONE, to: ["+13653603976"], body: "stop", direction: "incoming", createdAt: "2026-10-28T23:01:00Z" } } }),
    { eventId: "e2", type: "message.received", direction: "incoming", from: LEAD_PHONE, text: "stop", messageId: "m2", to: QUO_NUMBER, occurredAt: "2026-10-28T23:01:00.000Z" },
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

  assert.equal(await quoStopIntakeConnected(OASIS, QUO_NUMBER), false, "no verified delivery yet: automated texts stay off");
  const unsigned = await deliver(received("e0", "STOP", "2026-10-28T22:59:00.000Z"), { signed: false });
  assert.equal(unsigned.status, 401, "an unsigned delivery is refused");
  assert.equal(await health(), undefined, "and writes nothing");

  const stop = await deliver(received("e1", "Stop please", "2026-10-28T23:10:00.000Z"), { id: "delivery-stop" });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.stop, true);
  const suppressed = await seed.execute({ sql: "SELECT reason, source FROM sunbiz_phone_suppressions WHERE tenant_id = ? AND phone_last10 = ?", args: [OASIS, "4165550123"] });
  assert.deepEqual(suppressed.rows.map((r) => [r.reason, r.source]), [["OPT_OUT", "quo_inbound"]], "the number is on the STOP list");
  const outbox = await seed.execute({ sql: "SELECT id, status FROM website_sales_meeting_notifications ORDER BY id", args: [] });
  assert.deepEqual(outbox.rows.map((r) => `${r.id}:${r.status}`), ["mail:pending", "t30:cancelled", "t5:cancelled"], "its queued meeting texts are cancelled; email is untouched");
  const h = await health();
  assert.ok(h?.last_inbound_at && h?.last_stop_at, "the intake proof is recorded");
  assert.equal(await quoStopIntakeConnected(OASIS, QUO_NUMBER), true, "a verified, readable inbound text opens automated texts for that line");
  assert.equal(await quoStopIntakeConnected(OASIS, "+14165559999"), false, "never for a line the proof did not reach (Codex review of #776)");
  assert.equal(await quoStopIntakeConnected(OASIS, QUO_NUMBER, { env: {} }), false, "never without the signing key");

  // The canary: the next text to that number is refused before Quo is called.
  const refused = await sendQuoSms({ tenantId: OASIS, apiKey: "test", fromNumber: "+13653603976" }, { to: LEAD_PHONE, text: "OASIS AI: Reminder" });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "recipient_opted_out");

  // ORDER (Codex review of #776): an OLDER START arriving late never lifts the newer STOP.
  const staleStart = await deliver(received("e-old", "START", "2026-10-28T23:05:00.000Z"));
  assert.equal(staleStart.status, 200);
  assert.equal(staleStart.body.stale, true);
  const stillOptedOut = await seed.execute({ sql: "SELECT count(*) AS n FROM sunbiz_phone_suppressions WHERE tenant_id = ?", args: [OASIS] });
  assert.equal(Number(stillOptedOut.rows[0].n), 1, "the newer STOP stands");
  // A replay of the SAME STOP delivery still goes through (idempotent finish of a failed write).
  const replay = await deliver(received("e1", "Stop please", "2026-10-28T23:10:00.000Z"), { id: "delivery-stop" });
  assert.equal(replay.body.stop, true);
  // A NEWER START lifts it.
  const start = await deliver({ id: "e2", type: "message.received", createdAt: "2026-10-28T23:20:00Z", data: { object: { id: "m2", from: LEAD_PHONE, body: "START", direction: "incoming", createdAt: "2026-10-28T23:20:00Z" } } });
  assert.equal(start.status, 200);
  assert.equal(start.body.start, true);
  const after = await seed.execute({ sql: "SELECT count(*) AS n FROM sunbiz_phone_suppressions WHERE tenant_id = ?", args: [OASIS] });
  assert.equal(Number(after.rows[0].n), 0);
  // And an older STOP replayed after that START does not re-suppress.
  const oldStop = await deliver(received("e-older-stop", "STOP", "2026-10-28T23:15:00.000Z"));
  assert.equal(oldStop.body.stale, true);
  const stillLifted = await seed.execute({ sql: "SELECT count(*) AS n FROM sunbiz_phone_suppressions WHERE tenant_id = ?", args: [OASIS] });
  assert.equal(Number(stillLifted.rows[0].n), 0);

  // Overlapping deliveries (Codex review of #776): the order claim and the
  // STOP-list change are ONE write transaction, so an older START can never
  // undo a newer STOP between its claim and its write. The out-of-order cases
  // above prove the ordering; a parallel run on a local SQLite file only
  // measures that file's locking, not Turso's.
  const routeSource = readFileSync("app/api/webhooks/quo/route.ts", "utf8");
  const txStart = routeSource.indexOf('const tx = await getTursoClient().transaction("write");');
  const claimAt = routeSource.indexOf("INSERT INTO quo_inbound_consent", txStart);
  const suppressAt = routeSource.indexOf("INSERT INTO sunbiz_phone_suppressions", txStart);
  const releaseAt = routeSource.indexOf("FROM sunbiz_phone_suppressions WHERE tenant_id = ? AND phone_last10 = ? AND reason", txStart);
  const commitAt = routeSource.indexOf("await tx.commit();", txStart);
  assert.ok(txStart > 0 && txStart < claimAt && claimAt < suppressAt && claimAt < releaseAt, "the claim comes first, inside the transaction");
  assert.ok(suppressAt < commitAt && releaseAt < commitAt, "the STOP-list change commits with the claim");
  assert.doesNotMatch(routeSource, /applyInboundSmsStop\(|releasePhoneSuppression\(/, "no STOP-list write outside the transaction");

  // An ordinary reply is recorded as intake proof but changes nothing.
  const hello = await deliver(received("e3", "See you at 2!", "2026-10-28T23:30:00.000Z"));
  assert.equal(hello.status, 200);
  assert.equal(hello.body.stop, false);

  // No key on the Worker: the route says it is not installed.
  delete process.env.QUO_WEBHOOK_SIGNING_KEY;
  const noKey = await deliver(received("e4", "STOP", "2026-10-28T23:40:00.000Z"));
  assert.equal(noKey.status, 503);

  console.log("quo-stop-intake: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
