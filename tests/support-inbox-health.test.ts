/**
 * support-inbox-health.test.ts — is support@ being read? The reader on CC's PC
 * posts a heartbeat after each sweep (/api/internal/support/heartbeat); the SLA
 * cron alerts ONCE when support@ has not been read for 20 minutes
 * (lib/delivery/support-inbox-health.ts), and forgets non-ticket mail after 30
 * days (lib/delivery/email-intake.ts purgeOldNonTicketMessages).
 *
 * Pins: the heartbeat is kept (latest wins; a read stamps last_ok_at with this
 * server's clock; a failed sweep keeps the last good read); a heartbeat whose
 * signed time is not newer than the stored one (a replay, a late delivery) is
 * answered 200 and changes nothing; the wording the
 * desk and /operations show ("not read for N minutes"); one Telegram and one
 * error event per stale stretch, a recovery re-arms it, a failed Telegram is
 * retried without a second event; a mailbox that never beat is not stale; the
 * SLA cron runs it; the 30-day purge keeps tickets' messages.
 *
 * Run: node --conditions=react-server --import tsx tests/support-inbox-health.test.ts
 */
import "./_support-inbox-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import * as ReactNS from "react";
import { createElement, isValidElement, type ReactNode } from "react";
import type { Client, InStatement } from "@libsql/client";
import {
  DESK_TENANT,
  ENV,
  MAILBOX,
  SUPPORT_MIGRATION_PATH,
  USERS,
  answerOf,
  check,
  emptyDatabase,
  fakeNotify,
  finish,
  ingestBody,
  login,
  scalar,
  setupSupportDatabase,
  signedRequest,
} from "./_support-inbox-harness";

// The desk page is rendered as tests/delivery-pages.test.ts renders it: the
// classic JSX runtime wants a global React, and next/link is only an anchor here.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
const linkPath = require.resolve("next/link");
require.cache[linkPath] = {
  id: linkPath,
  filename: linkPath,
  path: dirname(linkPath),
  loaded: true,
  children: [],
  paths: [],
  exports: { __esModule: true, default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children) },
} as unknown as NodeModule;

/** Every string reachable in an element tree (server function components rendered, client ones by their props). */
function textOf(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 60 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out, depth + 1);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    if (typeof node.type === "function") {
      try {
        const rendered = (node.type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) {
          textOf(rendered, out, depth + 1);
          return out;
        }
      } catch {
        /* a client component: its props below */
      }
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") textOf(v as ReactNode, out, depth + 1);
      else if (typeof v === "string") out.push(v);
    }
    return out;
  }
  return out;
}

async function main() {
  const db = await setupSupportDatabase();
  const health = await import("../lib/delivery/support-inbox-health");
  const intake = await import("../lib/delivery/email-intake");
  const { runSlaCheck, slaRunOk } = await import("../lib/delivery/sla-cron");

  const beat = async (at: Date, over: Record<string, unknown> = {}) => {
    const body = { mailbox: MAILBOX, producer: "bea", phase: "ingest", ok: true, error_code: null, at: at.toISOString(), last_ok_at: null, consecutive_failures: 0, counts: { found: 2, ingested: 2 }, ...over };
    return answerOf(await health.handleSupportHeartbeat(signedRequest("/api/internal/support/heartbeat", body, at), { db, env: ENV, now: at }));
  };
  const status = async () => (await health.loadInboxStatus(db, DESK_TENANT))!.row!;
  const T0 = new Date("2026-10-01T12:00:00.000Z");
  const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

  console.log("support-inbox-health:");

  await check("before the reader has ever run there is nothing to alert about", async () => {
    assert.equal((await health.loadInboxStatus(db, DESK_TENANT))!.row, null);
    assert.equal(health.inboxHealth(MAILBOX, null, T0).state, "not_started");
    const n = fakeNotify();
    const r = await health.alertStaleSupportInboxes(db, n.deps, at(600));
    assert.deepEqual(r.alerted, []);
    assert.equal(n.telegrams.length, 0);
  });

  await check("a heartbeat is kept: a read stamps last_ok_at with this server's clock; a failed sweep keeps the last good read", async () => {
    const a = await beat(at(0));
    assert.equal(a.status, 200);
    assert.equal(a.body.stale_after_minutes, 20);
    let s = await status();
    assert.equal(s.ok, true);
    assert.equal(s.last_ok_at, at(0).toISOString());
    assert.equal(s.tenant_id, DESK_TENANT, "the desk comes from the mailbox");
    await beat(at(4), { ok: false, error_code: "imap_auth_failed", consecutive_failures: 1, at: "2020-01-01T00:00:00Z" });
    s = await status();
    assert.equal(s.ok, false);
    assert.equal(s.last_error, "imap_auth_failed");
    assert.equal(s.last_ok_at, at(0).toISOString(), "a failed sweep did not read the mailbox");
    assert.equal(s.last_sweep_at, at(4).toISOString(), "the server's clock, never the producer's");
  });

  await check("the producer named in the body must be the one that signed", async () => {
    const a = await beat(at(5), { producer: "maven" });
    assert.equal(a.status, 422);
  });

  await check("what the desk and /operations say: last read N minutes ago, failing, or not read for N minutes", async () => {
    const s = await status();
    assert.equal(health.inboxHealth(MAILBOX, s, at(10)).state, "failing");
    assert.match(health.inboxHealth(MAILBOX, s, at(10)).sentence, /imap_auth_failed/);
    const stale = health.inboxHealth(MAILBOX, s, at(27));
    assert.equal(stale.state, "stale");
    assert.equal(stale.minutesSinceRead, 27);
    assert.match(stale.sentence, /^support@oasisai\.work not read for 27 minutes\./);
    const fresh = health.inboxHealth(MAILBOX, { ...s, ok: true, last_error: null, last_ok_at: at(26).toISOString() }, at(27));
    assert.equal(fresh.state, "reading");
    assert.equal(fresh.sentence, "support@oasisai.work last read 1 minute ago.");
    assert.equal(health.inboxHealth(MAILBOX, { ...s, ok: true, last_ok_at: at(7).toISOString() }, at(27)).state, "stale", "20 minutes exactly is stale");
    assert.equal(health.inboxHealth(MAILBOX, { ...s, ok: true, last_ok_at: at(8).toISOString() }, at(27)).state, "reading", "19 minutes is not");
  });

  await check("stale for 20 minutes: ONE Telegram and ONE error event per stretch, whatever the number of cron runs", async () => {
    const n = fakeNotify();
    const first = await health.alertStaleSupportInboxes(db, n.deps, at(25));
    assert.deepEqual(first.alerted, [MAILBOX]);
    await health.alertStaleSupportInboxes(db, n.deps, at(40));
    await health.alertStaleSupportInboxes(db, n.deps, at(55));
    assert.equal(n.telegrams.length, 1);
    assert.match(n.telegrams[0], /not read for 25 minutes/);
    assert.equal(n.events.length, 1);
    assert.equal(n.events[0].eventType, "SUPPORT_INBOX_STALE");
    assert.equal(n.events[0].severity, "error", "counted under 'needs you' on /operations and /health");
    assert.equal(n.events[0].tenantId, DESK_TENANT);
    assert.match(String(n.events[0].payload.note), /not read for 25 minutes/);
  });

  await check("a successful read ends the stretch; the next stretch alerts again", async () => {
    await beat(at(60));
    assert.equal((await status()).alerted_at, null);
    const n = fakeNotify();
    assert.deepEqual((await health.alertStaleSupportInboxes(db, n.deps, at(70))).alerted, [], "10 minutes is not stale");
    assert.deepEqual((await health.alertStaleSupportInboxes(db, n.deps, at(81))).alerted, [MAILBOX]);
    assert.equal(n.telegrams.length, 1);
  });

  await check("a Telegram that fails is retried on the next run, without a second event", async () => {
    await beat(at(90));
    const failing = fakeNotify();
    failing.deps.telegram = async () => ({ ok: false, reason: "telegram down" });
    const r = await health.alertStaleSupportInboxes(db, failing.deps, at(115));
    assert.equal(r.failures.length, 1);
    assert.equal((await status()).alerted_at, null, "the claim is given back");
    assert.equal(failing.events.length, 1);
    const working = fakeNotify();
    const retry = await health.alertStaleSupportInboxes(db, working.deps, at(130));
    assert.deepEqual(retry.alerted, [MAILBOX]);
    assert.equal(working.events.length, 0, "the event was already published for this stretch");
    assert.equal(working.telegrams.length, 1);
  });

  await check("the SLA cron runs the stale check and the 30-day purge", async () => {
    await beat(at(140));
    const n = fakeNotify();
    const r = await runSlaCheck(db, n.deps, at(165));
    assert.deepEqual(r.support_inbox.alerted, [MAILBOX]);
    assert.equal(typeof r.support_inbox.purged, "number");
    assert.deepEqual(r.support_inbox.errors, []);
    assert.equal(slaRunOk(r), true);
  });

  await check("a support inbox step that throws keeps the rest of the SLA pass, lets the other step run, and fails the run", async () => {
    const failingAt = (pattern: RegExp) =>
      new Proxy(db, {
        get(target, prop) {
          if (prop === "execute") {
            return async (stmt: InStatement | string, args?: unknown) => {
              if (pattern.test(typeof stmt === "string" ? stmt : stmt.sql)) throw new Error("disk I/O error");
              return args === undefined ? target.execute(stmt as InStatement) : target.execute(stmt as string, args as never);
            };
          }
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }) as Client;
    const n = fakeNotify();
    const staleFails = await runSlaCheck(failingAt(/FROM support_mailbox_status/), n.deps, at(170));
    assert.deepEqual(staleFails.support_inbox.errors, ["stale_check: disk I/O error"]);
    assert.equal(typeof staleFails.support_inbox.purged, "number", "the purge still ran");
    assert.ok(Array.isArray(staleFails.alert_failures) && staleFails.reconcile, "the breach pass and reconcile results are kept");
    assert.equal(slaRunOk(staleFails), false);
    const purgeFails = await runSlaCheck(failingAt(/DELETE FROM support_email_messages/), n.deps, at(171));
    assert.deepEqual(purgeFails.support_inbox.errors, ["purge: disk I/O error"]);
    assert.equal(purgeFails.support_inbox.purged, 0);
    assert.equal(typeof purgeFails.support_inbox.checked, "number", "the stale check still ran");
    assert.equal(slaRunOk(purgeFails), false);
  });

  await check("a 'support@ not read' alert that could not be sent keeps the run red until a later run sends it", async () => {
    await beat(at(172));
    const down = fakeNotify();
    down.deps.telegram = async () => ({ ok: false, reason: "telegram down" });
    const failed = await runSlaCheck(db, down.deps, at(195));
    assert.equal(failed.support_inbox.failures.length, 1, "the alert was due and could not go out");
    assert.deepEqual(failed.support_inbox.errors, []);
    assert.equal(slaRunOk(failed), false);
    const sent = await runSlaCheck(db, fakeNotify().deps, at(196));
    assert.deepEqual(sent.support_inbox.alerted, [MAILBOX]);
    assert.equal(slaRunOk(sent), true);
  });

  await check("a replayed or late heartbeat never overwrites a newer one: answered 200 ok, recorded false, nothing changed", async () => {
    const send = async (body: Record<string, unknown>, signedAt: Date, now: Date) =>
      answerOf(await health.handleSupportHeartbeat(signedRequest("/api/internal/support/heartbeat", body, signedAt), { db, env: ENV, now }));
    const read = { mailbox: MAILBOX, producer: "bea", phase: "ingest", ok: true, error_code: null, at: at(200).toISOString(), last_ok_at: null, consecutive_failures: 0, counts: { found: 1 } };
    const failed = { ...read, ok: false, error_code: "imap_unavailable", consecutive_failures: 1, at: at(201).toISOString() };
    const first = await send(read, at(200), at(200));
    assert.equal(first.body.recorded, true);
    const second = await send(failed, at(201), at(201));
    assert.equal(second.body.recorded, true);
    // A stale stretch's alert claim, which only a NEWER successful read may end.
    await db.execute({ sql: "UPDATE support_mailbox_status SET alerted_at = ?, alert_status = ? WHERE mailbox = ?", args: [at(201).toISOString(), "telegram: sent (test)", MAILBOX] });
    const before = await status();
    // The captured successful heartbeat, sent again byte for byte inside the 300 s window.
    const replay = await send(read, at(200), at(203));
    assert.equal(replay.status, 200, "never an error the reader would retry or read as a broken desk");
    assert.equal(replay.body.ok, true);
    assert.equal(replay.body.recorded, false);
    assert.equal(replay.body.reason, "not_newer");
    // An older heartbeat delivered late, and the newest one sent twice.
    assert.equal((await send({ ...read, counts: { found: 7 } }, new Date(at(200).getTime() + 30_000), at(204))).body.recorded, false);
    assert.equal((await send(failed, at(201), at(204))).body.recorded, false);
    assert.deepEqual(await status(), before, "the failure stands: still failing, last read and alert claim untouched");
    assert.equal(before.ok, false);
    // A newer heartbeat is recorded as always.
    const newer = await send({ ...read, at: at(206).toISOString() }, at(206), at(206));
    assert.equal(newer.body.recorded, true);
    const after = await status();
    assert.equal(after.ok, true);
    assert.equal(after.last_ok_at, at(206).toISOString());
    assert.equal(after.alerted_at, null, "a newer read ends the stretch");
  });

  await check("a database whose heartbeat table lacks the signed-time column answers 503 not_installed, like a missing table", async () => {
    // Just what the heartbeat route reads: the migration under test on a bare
    // ticket_comments. As written it takes the heartbeat; without the column
    // (an earlier copy of the migration) it is not installed.
    const installed = async (renameColumn: boolean) => {
      const bare = emptyDatabase();
      await bare.execute("CREATE TABLE ticket_comments (id TEXT PRIMARY KEY)");
      await bare.executeMultiple(readFileSync(SUPPORT_MIGRATION_PATH, "utf8"));
      if (renameColumn) await bare.execute("ALTER TABLE support_mailbox_status RENAME COLUMN signed_at TO signed_at_renamed");
      const body = { mailbox: MAILBOX, producer: "bea", phase: "ingest", ok: true, error_code: null, at: at(0).toISOString(), last_ok_at: null, consecutive_failures: 0, counts: {} };
      return answerOf(await health.handleSupportHeartbeat(signedRequest("/api/internal/support/heartbeat", body, at(0)), { db: bare, env: ENV, now: at(0) }));
    };
    const whole = await installed(false);
    assert.equal(whole.status, 200, JSON.stringify(whole.body));
    assert.equal(whole.body.recorded, true);
    const older = await installed(true);
    assert.equal(older.status, 503);
    assert.equal(older.body.error, "not_installed");
  });

  await check("non-ticket mail is forgotten after 30 days; a ticket's messages are kept", async () => {
    const now = new Date("2026-10-01T12:00:00.000Z");
    const deps = { db, env: ENV, now, notify: fakeNotify().deps, schedule: () => {} };
    const spam = await answerOf(
      await intake.handleSupportIngest(
        signedRequest("/api/internal/support/ingest", ingestBody({ message: { from: { address: "x@spam.example", name: null } }, classification: { is_support_request: false, non_ticket_kind: "spam" } }, now), now),
        deps,
      ),
    );
    const real = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", ingestBody({}, now), now), deps));
    assert.equal(await intake.purgeOldNonTicketMessages(db, new Date(now.getTime() + 29 * 86_400_000)), 0);
    assert.equal(await intake.purgeOldNonTicketMessages(db, new Date(now.getTime() + 31 * 86_400_000)), 1);
    assert.equal(await scalar(db, "SELECT COUNT(*) FROM support_email_messages WHERE id = ?", [String(spam.body.message_record_id)]), 0);
    assert.equal(await scalar(db, "SELECT COUNT(*) FROM support_email_messages WHERE id = ?", [String(real.body.message_record_id)]), 1);
  });

  await check("OASIS's Support desk says when support@ was last read, and warns when it has not been for 20 minutes", async () => {
    const tickets = (await import("../app/tickets/page")).default;
    await login(USERS.cc);
    const text = async () => textOf(await tickets({ searchParams: Promise.resolve({}) })).join("\n");
    await beat(new Date(Date.now() - 3 * 60_000));
    assert.match(await text(), /support@oasisai\.work last read 3 minutes ago\./);
    await beat(new Date(Date.now() - 45 * 60_000));
    await db.execute({ sql: "UPDATE support_mailbox_status SET last_ok_at = ? WHERE mailbox = ?", args: [new Date(Date.now() - 45 * 60_000).toISOString(), MAILBOX] });
    assert.match(await text(), /support@oasisai\.work not read for 45 minutes\. The reader runs on CC's PC/);
  });

  finish("support-inbox-health");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
