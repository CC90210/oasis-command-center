import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DeliveryStateUnknownError,
  markScheduledSendDeliveryUnknown,
  markScheduledSendRetryOrFail,
  markScheduledSendSent,
  recoverStaleScheduledSendClaims,
  releaseUnstartedScheduledSendClaims,
  scheduledSendIdempotencyKey,
} from "../lib/scheduled-sends/delivery-safety";
import { createTursoPostgrest } from "../lib/turso-postgrest";

async function main() {
  const client = createClient({ url: "file::memory:?cache=shared" });
  await client.execute(`
    CREATE TABLE scheduled_sends (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      channel TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      last_error TEXT,
      sent_at TEXT
    )
  `);
  const db = createTursoPostgrest(client) as unknown as SupabaseClient;
  const insert = async (
    id: string,
    status: string,
    channel: "email" | "sms",
    claimedAt: string | null,
    attempts = 0,
  ) => {
    await client.execute({
      sql: `INSERT INTO scheduled_sends
              (id, status, channel, attempts, claimed_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, status, channel, attempts, claimedAt],
    });
  };
  const row = async (id: string) => {
    const result = await client.execute({
      sql: "SELECT * FROM scheduled_sends WHERE id = ?",
      args: [id],
    });
    return result.rows[0];
  };

  assert.equal(
    scheduledSendIdempotencyKey("row-1"),
    "scheduled-send:row-1",
    "every confirmed retry must reuse the row's stable transport identity",
  );

  await insert("email-old", "sending", "email", "2026-09-14T15:00:00.000Z");
  await insert("email-fresh", "sending", "email", "2026-09-14T15:59:00.000Z");
  await insert("sms-old", "sending", "sms", "2026-09-14T15:00:00.000Z");
  const recovery = await recoverStaleScheduledSendClaims({
    db,
    staleBeforeIso: "2026-09-14T15:45:00.000Z",
  });
  assert.deepEqual(recovery, { emailDeliveryUnknown: 1, smsDeliveryUnknown: 1 });
  assert.equal((await row("email-old")).status, "failed");
  assert.equal((await row("email-old")).attempts, 1);
  assert.match(String((await row("email-old")).last_error), /^delivery_unknown:/);
  assert.equal((await row("email-old")).claimed_at, null);
  assert.equal((await row("email-fresh")).status, "sending");
  assert.equal((await row("sms-old")).status, "failed");
  assert.match(String((await row("sms-old")).last_error), /^delivery_unknown:/);
  assert.equal((await row("sms-old")).claimed_at, null);

  await insert("unstarted-own", "sending", "email", "2026-09-14T16:00:00.000Z");
  await insert("unstarted-other", "sending", "email", "2026-09-14T16:01:00.000Z");
  assert.equal(
    await releaseUnstartedScheduledSendClaims({
      db,
      ids: ["unstarted-own", "unstarted-other"],
      claimedAt: "2026-09-14T16:00:00.000Z",
    }),
    1,
    "a worker releases only its own unstarted lease",
  );
  assert.equal((await row("unstarted-own")).status, "pending");
  assert.equal((await row("unstarted-own")).claimed_at, null);
  assert.equal((await row("unstarted-other")).status, "sending");

  await insert("provider-unknown", "sending", "email", "2026-09-14T16:00:00.000Z");
  await markScheduledSendDeliveryUnknown(
    db,
    { id: "provider-unknown", attempts: 0 },
    "provider response lost",
  );
  assert.equal((await row("provider-unknown")).status, "failed");
  assert.match(String((await row("provider-unknown")).last_error), /^delivery_unknown:/);

  await insert("confirmed-failure", "sending", "email", "2026-09-14T16:00:00.000Z");
  assert.equal(
    await markScheduledSendRetryOrFail(
      db,
      { id: "confirmed-failure", attempts: 0 },
      "send_failed: mailbox rejected",
    ),
    true,
  );
  assert.equal((await row("confirmed-failure")).status, "pending");
  assert.equal((await row("confirmed-failure")).attempts, 1);

  await insert("sent-terminal", "sending", "email", "2026-09-14T16:00:00.000Z");
  await markScheduledSendSent(db, "sent-terminal");
  assert.equal(
    await markScheduledSendRetryOrFail(
      db,
      { id: "sent-terminal", attempts: 0 },
      "late nudge failure",
    ),
    false,
    "the sending-state compare-and-set must not revert a sent row",
  );
  assert.equal((await row("sent-terminal")).status, "sent");

  await assert.rejects(
    () => markScheduledSendSent(db, "sent-terminal"),
    DeliveryStateUnknownError,
    "a second terminal transition must fail closed instead of pretending it persisted",
  );

  const route = readFileSync("app/api/cron/dispatch-scheduled-sends/route.ts", "utf8");
  assert.match(route, /\.update\(\{ status: "sending", claimed_at: nowIso \}\)/);
  assert.doesNotMatch(route, /\.lt\("scheduled_for", staleBeforeIso\)/);
  assert.match(
    route,
    /sendGmailAppPasswordAsOperator\(\{[\s\S]*?idempotencyKey,[\s\S]*?\}\)/,
  );
  assert.match(route, /sendGmailAsOperator\(\{[\s\S]*?idempotencyKey,[\s\S]*?\}\)/);
  assert.match(
    route,
    /sendResult\.reason === "delivery_unknown"[\s\S]*?markDeliveryUnknown/,
  );
  assert.match(
    route,
    /err\.code === "network_error"[\s\S]*?\^http_5\\d\\d\$[\s\S]*?markDeliveryUnknown/,
    "ambiguous SMS transport failures must never be auto-retried",
  );
  const processEmailAt = route.indexOf("async function processEmail");
  const sentAt = route.indexOf("await markScheduledSendSent(db, row.id)", processEmailAt);
  const logAt = route.indexOf("await logInteraction(db", sentAt);
  const nudgeAt = route.indexOf("await nudgeConversations", sentAt);
  assert.ok(sentAt >= 0 && logAt > sentAt && nudgeAt > logAt);
  assert.match(
    route,
    /err instanceof DeliveryStateUnknownError[\s\S]*?markRetryOrFail/,
    "unknown delivery persistence failures must bypass automatic retry",
  );
  assert.match(
    route,
    /const unstarted = claimed\.slice\(processed\)[\s\S]*?releaseUnstartedScheduledSendClaims\([\s\S]*?claimedAt: nowIso/,
    "a time-budget exit must release every row that never crossed the provider boundary",
  );

  const pgMigration = readFileSync("database/173_scheduled_sends_claimed_at.sql", "utf8");
  const tursoMigration = readFileSync(
    "database/turso/173_scheduled_sends_claimed_at.turso.sql",
    "utf8",
  );
  assert.match(pgMigration, /add column if not exists claimed_at timestamptz/i);
  assert.match(tursoMigration, /add column "claimed_at" TEXT/i);

  console.log("scheduled send delivery safety ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
