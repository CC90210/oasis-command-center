/**
 * support-inbox-races.test.ts - two requests for ONE support@ message (or one
 * reply draft), started together against one local libSQL file, held at the
 * same statement until both have read the same state, then let through one
 * after the other, end in ONE consistent state.
 *
 * Pins (the independent review of PR #526, 2026-10-01):
 *   - two retries of an email whose planned ticket closed in between replace
 *     the plan ONCE (a compare-and-swap on the claim; the loser reads the
 *     winner's plan back and follows it): one replacement ticket, one
 *     acknowledgement, one founder alert, the same number in both answers;
 *   - two posts of one reply at once complete the claim once: one comment,
 *     one "client replied" alert (the other attempt answers as a repeat);
 *   - a plan replaced under an attempt never completes the claim: the
 *     attempt follows the stored plan, and the claim, the answer and the
 *     ledger name the same ticket;
 *   - a draft and a failure report for one email agree with the record
 *     whichever lands first. A failure report recorded while the draft's
 *     approval is being filed wins: the approval is withdrawn (cancelled, so
 *     nobody can approve it) and the draft is answered 409. An approval that
 *     exists before the report lands wins: the report answers 200
 *     already_filed and leaves no "reply by hand" note;
 *   - two copies of one draft are one approval.
 *
 * The turnstile holds each request's FIRST statement matching its pattern
 * until every party has reached its own, then releases them in the given
 * order, each after the previous one's statement finished: the interleaving
 * is real (two concurrent calls on one database) and the same every run.
 *
 * Run: node --conditions=react-server --import tsx tests/support-inbox-races.test.ts
 */
import "./_support-inbox-harness";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import {
  DESK_TENANT,
  ENV,
  answerOf,
  check,
  fakeNotify,
  finish,
  ingestBody,
  scalar,
  setupSupportDatabase,
  signedRequest,
  type WireBody,
} from "./_support-inbox-harness";

const DRAFT = "Hi,\n\nThanks for writing. We are looking at the export button now and will write again once we know more.\n\nThe OASIS team";
const CRITIC = { verdict: "ship", score: 8.5, issues: [], notes: "Clear and safe." };

type Turnstile = { enter(party: string): Promise<void>; leave(party: string): void };

/** Hold every party until all have arrived, then let them through one at a time, in `order`. */
function turnstile(order: string[], timeoutMs = 5_000): Turnstile {
  const arrived = new Set<string>();
  let allIn!: () => void;
  const everyone = new Promise<void>((resolve) => (allIn = resolve));
  const turns = new Map<string, { done: Promise<void>; end: () => void }>();
  for (const party of order) {
    let end!: () => void;
    const done = new Promise<void>((resolve) => (end = resolve));
    turns.set(party, { done, end });
  }
  const within = (p: Promise<void>, what: string) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`turnstile: ${what}`)), timeoutMs);
      p.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  return {
    async enter(party) {
      arrived.add(party);
      if (arrived.size === order.length) allIn();
      await within(everyone, `only ${[...arrived].join(", ")} reached the gate`);
      const i = order.indexOf(party);
      if (i > 0) await within(turns.get(order[i - 1])!.done, `${order[i - 1]} never finished its turn`);
    },
    leave(party) {
      turns.get(party)!.end();
    },
  };
}

const sqlOf = (s: InStatement | string) => (typeof s === "string" ? s : s.sql);

/** The database as one request sees it: its first statement matching `at` waits for its turn. */
function gated(db: Client, party: string, gate: Turnstile, at: RegExp): Client {
  let passed = false;
  const hold = async <T>(sqls: string[], run: () => Promise<T>): Promise<T> => {
    if (passed || !sqls.some((q) => at.test(q))) return run();
    passed = true;
    await gate.enter(party);
    try {
      return await run();
    } finally {
      gate.leave(party);
    }
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "execute") {
        return (stmt: InStatement | string, args?: unknown) =>
          hold([sqlOf(stmt)], () => (args === undefined ? target.execute(stmt as InStatement) : target.execute(stmt as string, args as never)));
      }
      if (prop === "batch") {
        return (stmts: Array<InStatement | string>, mode?: "write" | "read" | "deferred") => hold(stmts.map(sqlOf), () => target.batch(stmts, mode));
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Client;
}

/** The database as one request sees it: at its first statement matching `at`, `meanwhile` runs first. */
function pausedAt(db: Client, at: RegExp, meanwhile: () => Promise<void>): Client {
  let paused = false;
  const pause = async (sqls: string[]) => {
    if (paused || !sqls.some((q) => at.test(q))) return;
    paused = true;
    await meanwhile();
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "execute") {
        return async (stmt: InStatement | string, args?: unknown) => {
          await pause([sqlOf(stmt)]);
          return args === undefined ? target.execute(stmt as InStatement) : target.execute(stmt as string, args as never);
        };
      }
      if (prop === "batch") {
        return async (stmts: Array<InStatement | string>, mode?: "write" | "read" | "deferred") => {
          await pause(stmts.map(sqlOf));
          return target.batch(stmts, mode);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Client;
}

/** The database as a request that dies at its first batch matching `at` sees it. */
function crashAt(db: Client, at: RegExp): Client {
  let crashed = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: Array<InStatement | string>, mode?: "write" | "read" | "deferred") => {
          if (!crashed && stmts.some((s) => at.test(sqlOf(s)))) {
            crashed = true;
            throw new Error("simulated crash");
          }
          return target.batch(stmts, mode);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Client;
}

async function main() {
  const db = await setupSupportDatabase();
  const intake = await import("../lib/delivery/email-intake");
  const drafts = await import("../lib/delivery/support-drafts");
  const store = await import("../lib/delivery/store");

  let clock = new Date("2026-10-01T15:00:00.000Z");
  const tick = (m = 1) => (clock = new Date(clock.getTime() + m * 60_000));
  const notify = fakeNotify();
  const ingestWith = async (client: Client, body: WireBody, now: Date) =>
    answerOf(
      await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", body, now), {
        db: client,
        env: ENV,
        now,
        notify: notify.deps,
        schedule: notify.schedule,
      }),
    );
  const fileWith = async (client: Client, body: Record<string, unknown>, now: Date) =>
    answerOf(
      await drafts.handleSupportDraft(signedRequest("/api/internal/support/draft", body, now), {
        db: client,
        env: ENV,
        now,
        notify: notify.deps,
        schedule: notify.schedule,
      }),
    );

  console.log("support-inbox-races:");

  // -- Two retries of one email, its ticket closed in between --
  await check("two retries of one email whose ticket closed in between: ONE replacement ticket, ONE acknowledgement, ONE alert, the same number in both answers", async () => {
    const from = { address: "race@client.test", name: "Race" };
    const opened = await ingestWith(db, ingestBody({ message: { from, subject: "The export button" } }, clock), tick());
    await notify.drain();
    const first = opened.body.ticket as { id: string; number: string };
    // The client's reply is claimed with a plan to join that ticket, and the
    // request dies before the comment is written.
    const reply = ingestBody({ message: { from, subject: `Re: [${first.number}] The export button`, body_text: "It also fails for CSV." } }, clock);
    await assert.rejects(ingestWith(crashAt(db, /INSERT INTO ticket_comments/), reply, tick()), /simulated crash/);
    const key = createHash("sha256").update(String(reply.message.message_id), "utf8").digest("hex");
    const planned = JSON.parse(String(await scalar(db, "SELECT plan_json FROM support_email_messages WHERE direction = 'inbound' AND message_id_hash = ?", [key])));
    assert.equal(planned.disposition, "appended");
    assert.equal(planned.ticketId, first.id);
    // A person closes that ticket before the reader retries.
    await store.updateTicket(db, DESK_TENANT, first.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, tick());
    const emailsBefore = notify.emails.length;
    const telegramsBefore = notify.telegrams.length;

    // Two retries (a lost answer and the next pass), each held until BOTH have
    // planned a replacement ticket, then let through one after the other.
    const gate = turnstile(["a", "b"]);
    const now = tick();
    const [a, b] = await Promise.all(["a", "b"].map((p) => ingestWith(gated(db, p, gate, /^\s*UPDATE support_email_messages SET plan_json/), reply, now)));
    await notify.drain();

    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const ta = a.body.ticket as { id: string; number: string };
    const tb = b.body.ticket as { id: string; number: string };
    assert.equal(ta.number, tb.number, "both answers name the same ticket");
    assert.notEqual(ta.id, first.id, "the closed ticket is not reopened");
    const replacements = (
      await db.execute({ sql: "SELECT id FROM support_tickets WHERE tenant_id = ? AND client_email = ? AND id <> ?", args: [DESK_TENANT, from.address, first.id] })
    ).rows.map((r) => String(r.id));
    assert.deepEqual(replacements, [ta.id], "ONE replacement ticket");
    const claim = (await db.execute({ sql: "SELECT ticket_id, completed_at, plan_json FROM support_email_messages WHERE direction = 'inbound' AND message_id_hash = ?", args: [key] })).rows[0];
    assert.equal(claim.ticket_id, ta.id);
    assert.ok(claim.completed_at);
    assert.equal(JSON.parse(String(claim.plan_json)).ticketId, ta.id, "the stored plan is the one carried out");
    const acks = notify.emails.slice(emailsBefore).filter((m) => m.to === from.address);
    assert.equal(acks.length, 1, "ONE acknowledgement");
    assert.equal(acks[0].idempotencyKey, `support-ack:${ta.id}`);
    const alerts = notify.telegrams.slice(telegramsBefore).filter((t) => t.includes("New support ticket"));
    assert.equal(alerts.length, 1, "ONE founder alert");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM outcome_events WHERE event_key = 'ticket.message_received' AND idempotency_key = ?", [`tktmsg:${key}`])), 1);
  });

  await check("two posts of one reply at once: ONE comment, ONE 'client replied' alert, and only the attempt that completed the claim tells anyone", async () => {
    const from = { address: "pair@client.test", name: "Pair" };
    const opened = await ingestWith(db, ingestBody({ message: { from, subject: "Invoices page" } }, clock), tick());
    await notify.drain();
    const t = opened.body.ticket as { id: string; number: string };
    const reply = ingestBody({ message: { from, subject: `Re: [${t.number}] Invoices page`, body_text: "Still blank on Safari." } }, clock);
    const telegramsBefore = notify.telegrams.length;
    // Both have carried out the same plan and reach the completion together.
    const gate = turnstile(["a", "b"]);
    const now = tick();
    const [a, b] = await Promise.all(["a", "b"].map((p) => ingestWith(gated(db, p, gate, /completed_at = \?, updated_at = \?/), reply, now)));
    await notify.drain();
    assert.equal(a.body.disposition, "appended");
    assert.equal((a.body.ticket as { id: string }).id, t.id);
    assert.equal((b.body.ticket as { id: string }).id, t.id);
    assert.deepEqual([a.body.duplicate, b.body.duplicate].sort(), [false, true], "one attempt completed the claim, the other answers as a repeat");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ? AND author_type = 'client' AND body = ?", [t.id, "Still blank on Safari."])), 1);
    assert.equal(notify.telegrams.slice(telegramsBefore).filter((x) => x.includes(`Client replied by email on ${t.number}`)).length, 1, "ONE alert");
  });

  await check("a stale plan never completes the claim: an attempt that held the plan from before a replacement follows the stored one", async () => {
    const from = { address: "stale-plan@client.test", name: "Stale" };
    const opened = await ingestWith(db, ingestBody({ message: { from, subject: "Login loop" } }, clock), tick());
    await notify.drain();
    const first = opened.body.ticket as { id: string; number: string };
    const reply = ingestBody({ message: { from, subject: `Re: [${first.number}] Login loop`, body_text: "Same again today." } }, clock);
    await assert.rejects(ingestWith(crashAt(db, /INSERT INTO ticket_comments/), reply, tick()), /simulated crash/);
    const key = createHash("sha256").update(String(reply.message.message_id), "utf8").digest("hex");
    const stale = JSON.parse(String(await scalar(db, "SELECT plan_json FROM support_email_messages WHERE direction = 'inbound' AND message_id_hash = ?", [key])));
    assert.equal(stale.disposition, "appended");
    // While this retry holds the append plan, another attempt replaced it with
    // a new ticket (its ticket had closed), and then someone reopened that ticket.
    const replacementId = "7d1c9f0e-5b2a-4c8e-9f31-2a6b8d4e0c17";
    const replacement = {
      ...stale,
      disposition: "new_ticket",
      ticketId: replacementId,
      commentId: null,
      newTicket: {
        title: "Bug: Login loop",
        category: "bug",
        severity: "high",
        client_name: "Stale",
        client_email: from.address,
        project_id: null,
        client_tenant_id: null,
        client_match: "none",
        customer_id: null,
        assigned_to: null,
      },
      notes: [],
      ack: "skipped:not_wanted",
    };
    const retry = pausedAt(db, /^SELECT \* FROM support_tickets WHERE tenant_id = \? AND id = \?$/, async () => {
      await db.execute({
        sql: "UPDATE support_email_messages SET plan_json = ?, ticket_id = ?, comment_id = NULL, disposition = 'new_ticket', ack_status = ? WHERE message_id_hash = ?",
        args: [JSON.stringify(replacement), replacementId, replacement.ack, key],
      });
      await store.updateTicket(db, DESK_TENANT, first.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, clock);
      await store.updateTicket(db, DESK_TENANT, first.id, { status: "open" }, { userId: "u-cc", name: "CC" }, clock);
    });
    const a = await ingestWith(retry, reply, tick());
    await notify.drain();
    assert.equal((a.body.ticket as { id: string }).id, replacementId, "the answer is the stored plan's ticket");
    const claim = (await db.execute({ sql: "SELECT ticket_id, disposition, plan_json, completed_at FROM support_email_messages WHERE message_id_hash = ?", args: [key] })).rows[0];
    assert.ok(claim.completed_at);
    assert.equal(claim.ticket_id, replacementId);
    assert.equal(claim.disposition, "new_ticket");
    assert.equal(JSON.parse(String(claim.plan_json)).ticketId, claim.ticket_id, "the claim records the plan it holds");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM outcome_events WHERE idempotency_key = ? AND subject_id = ?", [`tktmsg:${key}`, replacementId])), 1, "the ledger names that ticket");
    // The email is on ONE ticket: the attempt that held the old plan wrote nothing on the old ticket.
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ? AND body LIKE '%Same again today.%'", [first.id])), 0, "no copy on the old ticket");
    assert.match(String(await scalar(db, "SELECT description FROM support_tickets WHERE id = ?", [replacementId])), /Same again today\./);
  });

  await check("an email whose ticket closes while two retries file it lands on ONE new ticket, never on the closed one", async () => {
    const from = { address: "kept@client.test", name: "Kept" };
    const opened = await ingestWith(db, ingestBody({ message: { from, subject: "Report totals" } }, clock), tick());
    await notify.drain();
    const first = opened.body.ticket as { id: string; number: string };
    const reply = ingestBody({ message: { from, subject: `Re: [${first.number}] Report totals`, body_text: "Totals are off by one." } }, clock);
    await assert.rejects(ingestWith(crashAt(db, /INSERT INTO ticket_comments/), reply, tick()), /simulated crash/);
    const key = createHash("sha256").update(String(reply.message.message_id), "utf8").digest("hex");
    // Retry A reads the open ticket and reaches its write. A person closes the
    // ticket; retry B reads it closed, finds no comment, and plans a new
    // ticket. A's write comes first: the ticket is closed by then, so it lands
    // nowhere, and the email goes to the new ticket, once.
    let aAtWrite!: () => void;
    const aReady = new Promise<void>((resolve) => (aAtWrite = resolve));
    const gate = turnstile(["a", "b"]);
    const retryA = pausedAt(gated(db, "a", gate, /INSERT INTO ticket_comments/), /INSERT INTO ticket_comments/, async () => aAtWrite());
    const retryB = gated(
      pausedAt(db, /^SELECT \* FROM support_tickets WHERE tenant_id = \? AND id = \?$/, async () => {
        await aReady;
        await store.updateTicket(db, DESK_TENANT, first.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, clock);
      }),
      "b",
      gate,
      /^\s*UPDATE support_email_messages SET plan_json/,
    );
    const now = tick();
    const [a, b] = await Promise.all([ingestWith(retryA, reply, now), ingestWith(retryB, reply, now)]);
    await notify.drain();
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const fresh = (a.body.ticket as { id: string }).id;
    assert.notEqual(fresh, first.id, "not the closed ticket");
    assert.equal((b.body.ticket as { id: string }).id, fresh, "both answers name the same ticket");
    const others = (await db.execute({ sql: "SELECT id FROM support_tickets WHERE tenant_id = ? AND client_email = ? AND id <> ?", args: [DESK_TENANT, from.address, first.id] })).rows.map((r) => String(r.id));
    assert.deepEqual(others, [fresh], "ONE new ticket");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ? AND author_type = 'client' AND body LIKE '%Totals are off by one.%'", [first.id])), 0, "no copy on the closed ticket");
    assert.equal(String(await scalar(db, "SELECT status FROM support_tickets WHERE id = ?", [first.id])), "closed", "the closed ticket stays closed");
    assert.match(String(await scalar(db, "SELECT description FROM support_tickets WHERE id = ?", [fresh])), /Totals are off by one\./);
    const claim = (await db.execute({ sql: "SELECT ticket_id, disposition, completed_at FROM support_email_messages WHERE message_id_hash = ?", args: [key] })).rows[0];
    assert.ok(claim.completed_at);
    assert.equal(claim.ticket_id, fresh);
    assert.equal(claim.disposition, "new_ticket");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM outcome_events WHERE idempotency_key = ?", [`tktmsg:${key}`])), 1);
  });

  await check("a ticket that closes between the read and the write sends the email to a new ticket, even with one attempt", async () => {
    const from = { address: "single@client.test", name: "Single" };
    const opened = await ingestWith(db, ingestBody({ message: { from, subject: "Invoice PDF" } }, clock), tick());
    await notify.drain();
    const first = opened.body.ticket as { id: string; number: string };
    const reply = ingestBody({ message: { from, subject: `Re: [${first.number}] Invoice PDF`, body_text: "Still blank." } }, clock);
    // The attempt reads the open ticket; a person closes it just before the write.
    const now = tick();
    const closing = pausedAt(db, /INSERT INTO ticket_comments/, async () => {
      await store.updateTicket(db, DESK_TENANT, first.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, now);
    });
    const a = await ingestWith(closing, reply, now);
    await notify.drain();
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const fresh = (a.body.ticket as { id: string }).id;
    assert.notEqual(fresh, first.id);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ? AND body LIKE '%Still blank.%'", [first.id])), 0);
    assert.match(String(await scalar(db, "SELECT description FROM support_tickets WHERE id = ?", [fresh])), /Still blank\./);
  });

  await check("a replacement planned while the ticket was closed is dropped when the ticket reopened and the email landed on it: ONE copy, on that ticket", async () => {
    const from = { address: "reopen@client.test", name: "Reopen" };
    const opened = await ingestWith(db, ingestBody({ message: { from, subject: "Calendar sync" } }, clock), tick());
    await notify.drain();
    const first = opened.body.ticket as { id: string; number: string };
    const reply = ingestBody({ message: { from, subject: `Re: [${first.number}] Calendar sync`, body_text: "Missed two events." } }, clock);
    await assert.rejects(ingestWith(crashAt(db, /INSERT INTO ticket_comments/), reply, tick()), /simulated crash/);
    const key = createHash("sha256").update(String(reply.message.message_id), "utf8").digest("hex");
    // A reads the open ticket and waits at its write. A person closes the
    // ticket; B reads it closed and plans a new one. Before B stores that plan
    // the person reopens the ticket, A's write lands on it, and B's
    // replacement must then be refused.
    let aAtWrite!: () => void;
    const aReady = new Promise<void>((resolve) => (aAtWrite = resolve));
    const gate = turnstile(["a", "b"]);
    const now = tick();
    const retryA = pausedAt(gated(db, "a", gate, /INSERT INTO ticket_comments/), /INSERT INTO ticket_comments/, async () => aAtWrite());
    const retryB = pausedAt(
      gated(
        pausedAt(db, /^SELECT \* FROM support_tickets WHERE tenant_id = \? AND id = \?$/, async () => {
          await aReady;
          await store.updateTicket(db, DESK_TENANT, first.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, now);
        }),
        "b",
        gate,
        /^\s*UPDATE support_email_messages SET plan_json/,
      ),
      /^\s*UPDATE support_email_messages SET plan_json/,
      async () => {
        await store.updateTicket(db, DESK_TENANT, first.id, { status: "open" }, { userId: "u-cc", name: "CC" }, now);
      },
    );
    const [a, b] = await Promise.all([ingestWith(retryA, reply, now), ingestWith(retryB, reply, now)]);
    await notify.drain();
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal((a.body.ticket as { id: string }).id, first.id);
    assert.equal((b.body.ticket as { id: string }).id, first.id);
    const others = (await db.execute({ sql: "SELECT id FROM support_tickets WHERE tenant_id = ? AND client_email = ? AND id <> ?", args: [DESK_TENANT, from.address, first.id] })).rows;
    assert.equal(others.length, 0, "no second ticket");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ? AND author_type = 'client' AND body = ?", [first.id, "Missed two events."])), 1);
    const claim = (await db.execute({ sql: "SELECT ticket_id, disposition FROM support_email_messages WHERE message_id_hash = ?", args: [key] })).rows[0];
    assert.equal(claim.ticket_id, first.id);
    assert.equal(claim.disposition, "appended");
  });

  await check("an attempt that lost never moves the ticket: a resolved ticket another attempt reopened, then a person resolved again, stays resolved", async () => {
    const from = { address: "loser@client.test", name: "Loser" };
    const opened = await ingestWith(db, ingestBody({ message: { from, subject: "Sync stalls" } }, clock), tick());
    await notify.drain();
    const first = opened.body.ticket as { id: string; number: string };
    await store.updateTicket(db, DESK_TENANT, first.id, { status: "resolved" }, { userId: "u-cc", name: "CC" }, tick());
    const reply = ingestBody({ message: { from, subject: `Re: [${first.number}] Sync stalls`, body_text: "It stalled again." } }, clock);
    await assert.rejects(ingestWith(crashAt(db, /INSERT INTO ticket_comments/), reply, tick()), /simulated crash/);
    const reopenedEvents = () => scalar(db, "SELECT COUNT(*) FROM outcome_events WHERE subject_id = ? AND event_key = 'ticket.reopened'", [first.id]).then(Number);
    // Attempt A read the RESOLVED ticket and reached its write. Meanwhile
    // attempt B files the email (the ticket reopens) and a person resolves it
    // again. A's write then lands nowhere and must not reopen the ticket.
    const now = tick();
    const seen: { b?: Awaited<ReturnType<typeof ingestWith>> } = {};
    const retryA = pausedAt(db, /INSERT INTO ticket_comments/, async () => {
      seen.b = await ingestWith(db, reply, now);
      assert.equal(String(await scalar(db, "SELECT status FROM support_tickets WHERE id = ?", [first.id])), "open", "B reopened it");
      await store.updateTicket(db, DESK_TENANT, first.id, { status: "resolved" }, { userId: "u-cc", name: "CC" }, now);
    });
    const a = await ingestWith(retryA, reply, now);
    await notify.drain();
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(seen.b?.status, 200);
    assert.equal((a.body.ticket as { id: string }).id, first.id);
    assert.equal(String(await scalar(db, "SELECT status FROM support_tickets WHERE id = ?", [first.id])), "resolved", "the person's resolution stands");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ? AND author_type = 'client' AND body = ?", [first.id, "It stalled again."])), 1, "ONE copy");
    assert.equal(await reopenedEvents(), 1, "ONE ticket.reopened, from B");
  });

  // -- A draft and a failure report for one email --
  const wanted = async (address: string) => {
    const a = await ingestWith(db, ingestBody({ message: { from: { address, name: "Client" }, subject: `Draft for ${address}` } }, clock), tick());
    await notify.drain();
    assert.equal(a.body.draft_wanted, true);
    return { recordId: String(a.body.message_record_id), ticket: a.body.ticket as { id: string; number: string } };
  };
  const draftOf = (r: { recordId: string; ticket: { id: string } }) => ({
    message_record_id: r.recordId,
    ticket_id: r.ticket.id,
    body: DRAFT,
    critic: CRITIC,
    model_ref: "claude-cli:opus",
  });
  const reportOf = (r: { recordId: string; ticket: { id: string } }) => ({
    message_record_id: r.recordId,
    ticket_id: r.ticket.id,
    model_ref: "claude-cli:opus",
    body: null,
    critic: null,
    failure: "draft_failed",
    reason: "model_unavailable",
    attempts: 3,
  });
  const liveApprovals = (recordId: string) =>
    scalar(
      db,
      "SELECT COUNT(*) FROM approvals WHERE tenant_id = ? AND idempotency_key = ? AND status IN ('pending', 'approved', 'executing', 'executed')",
      [DESK_TENANT, `support-draft:${recordId}`],
    ).then(Number);
  const handNotes = (ticketId: string) => scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ? AND body LIKE '%Reply by hand%'", [ticketId]).then(Number);
  const draftStatus = (recordId: string) =>
    db.execute({ sql: "SELECT draft_status, draft_approval_id FROM support_email_messages WHERE id = ?", args: [recordId] }).then((rs) => rs.rows[0]);

  await check("a failure report recorded while the draft's approval is being filed wins: the approval is withdrawn, the draft is answered 409", async () => {
    const r = await wanted("lost-draft@client.test");
    const telegramsBefore = notify.telegrams.length;
    // Both read the record (no draft, no failure); the report writes first,
    // then the draft files its approval.
    const gate = turnstile(["report", "draft"]);
    const now = tick();
    const [draft, report] = await Promise.all([
      fileWith(gated(db, "draft", gate, /INSERT INTO approvals/), draftOf(r), now),
      fileWith(gated(db, "report", gate, /SET draft_status = 'failed'/), reportOf(r), now),
    ]);
    await notify.drain();
    assert.equal(report.status, 200);
    assert.equal(report.body.status, "reported");
    assert.equal(draft.status, 409, JSON.stringify(draft.body));
    assert.equal(draft.body.error, "draft_failure_reported");
    const rec = await draftStatus(r.recordId);
    assert.equal(rec.draft_status, "failed");
    assert.equal(rec.draft_approval_id, null);
    assert.equal(await liveApprovals(r.recordId), 0, "nothing the record does not name is left for anyone to approve");
    const approval = (await db.execute({ sql: "SELECT id, status FROM approvals WHERE idempotency_key = ?", args: [`support-draft:${r.recordId}`] })).rows[0];
    assert.equal(approval.status, "cancelled");
    const events = (await db.execute({ sql: "SELECT event FROM approval_events WHERE approval_id = ? ORDER BY created_at, rowid", args: [String(approval.id)] })).rows.map((e) => e.event);
    assert.deepEqual(events, ["created", "cancelled"]);
    assert.equal(await handNotes(r.ticket.id), 1, "the ticket says: reply by hand");
    assert.ok(!notify.telegrams.slice(telegramsBefore).some((t) => t.includes(`Draft ready on ${r.ticket.number}`)), "no 'draft ready' for a withdrawn draft");
  });

  await check("a draft whose approval exists before the failure report lands wins: the report answers 200 already_filed and leaves no note", async () => {
    const r = await wanted("won-draft@client.test");
    // The draft has filed its approval and is about to record it; the report
    // reads no draft on the record and writes first.
    const gate = turnstile(["report", "draft"]);
    const now = tick();
    const [draft, report] = await Promise.all([
      fileWith(gated(db, "draft", gate, /SET draft_status = 'filed'/), draftOf(r), now),
      fileWith(gated(db, "report", gate, /SET draft_status = 'failed'/), reportOf(r), now),
    ]);
    await notify.drain();
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    assert.equal(draft.body.status, "filed");
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.equal(report.body.status, "already_filed");
    assert.equal(report.body.approval_id, draft.body.approval_id);
    const rec = await draftStatus(r.recordId);
    assert.equal(rec.draft_status, "filed");
    assert.equal(rec.draft_approval_id, draft.body.approval_id);
    assert.equal(await liveApprovals(r.recordId), 1);
    assert.equal(await handNotes(r.ticket.id), 0, "no 'reply by hand' on a ticket with a draft to approve");
  });

  await check("two copies of one draft, released together: ONE approval, both answered 200", async () => {
    const r = await wanted("twice@client.test");
    const gate = turnstile(["one", "two"]);
    const now = tick();
    const [one, two] = await Promise.all(["one", "two"].map((p) => fileWith(gated(db, p, gate, /INSERT INTO approvals/), draftOf(r), now)));
    await notify.drain();
    assert.equal(one.status, 200);
    assert.equal(two.status, 200);
    assert.equal(one.body.approval_id, two.body.approval_id);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM approvals WHERE idempotency_key = ?", [`support-draft:${r.recordId}`])), 1);
    assert.equal((await draftStatus(r.recordId)).draft_approval_id, one.body.approval_id);
  });

  finish("support-inbox-races");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
