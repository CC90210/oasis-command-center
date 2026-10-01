/**
 * support-inbox-ingest.test.ts — an email to support@ becomes a ticket, a line
 * on a ticket, or nothing, exactly once (lib/delivery/email-intake.ts), driven
 * through the real ingest handler with requests signed the way the reader
 * signs them, against a local libSQL file carrying the real migrations.
 *
 * Pins: one ticket per message and the same number on a repeat; 409 for the
 * same key with other content; a retry after a crash finishes the first plan;
 * the reader's synthetic key for a message with no Message-ID; threading by
 * headers, subject tag and same-subject, only for a verified sender on the
 * thread; a closed ticket gets a follow-up, a resolved one reopens (with
 * ticket.reopened); non-ticket and machine mail never open or join a ticket;
 * a bounce of our own email is a note; a loop is nothing; an opt-out files the
 * ticket, sends nothing and records the sender on OASIS's list; the instant
 * acknowledgement goes only with the reader's permission AND this side's
 * checks, threaded, from the support lane, and the reconcile pass can only
 * send one that was decided; the per-sender limits; the client's
 * Conversations mirror for a linked client only; the SLA clock from arrival.
 *
 * Run: node --conditions=react-server --import tsx tests/support-inbox-ingest.test.ts
 */
import "./_support-inbox-harness";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import {
  DESK_TENANT,
  ENV,
  MAILBOX,
  answerOf,
  check,
  fakeNotify,
  finish,
  ingestBody,
  messageId,
  scalar,
  setupSupportDatabase,
  signedRequest,
  type WireBody,
} from "./_support-inbox-harness";

const JANE = "jane@harbourplumbing.test";

async function main() {
  const db = await setupSupportDatabase();
  const intake = await import("../lib/delivery/email-intake");
  const store = await import("../lib/delivery/store");
  const thread = await import("../lib/delivery/email-thread");
  const { reconcileSupportIntake } = await import("../lib/delivery/support-intake");

  // Jane is one of OASIS's clients (a client record with her address).
  await db.execute({
    sql: `INSERT INTO customers (id, tenant_id, display_name, primary_email, lifecycle, created_at, updated_at)
          VALUES ('cust-jane', ?, 'Harbour Plumbing', ?, 'active', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    args: [DESK_TENANT, JANE],
  });

  let clock = new Date("2026-10-01T15:00:00.000Z");
  const tick = (minutes = 1) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
    return clock;
  };
  let notify = fakeNotify();
  const post = async (body: WireBody, o: { db?: Client; drop?: boolean } = {}) => {
    const now = tick();
    const res = await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", body, now), {
      db: o.db ?? db,
      env: ENV,
      now,
      notify: notify.deps,
      schedule: o.drop ? () => {} : notify.schedule,
    });
    const a = await answerOf(res);
    await notify.drain();
    return a;
  };
  const ticketCount = () => scalar(db, "SELECT COUNT(*) FROM support_tickets WHERE tenant_id = ?", [DESK_TENANT]).then(Number);
  const ticketOf = (a: { body: Record<string, unknown> }) => a.body.ticket as { id: string; number: string; status: string } | null;
  const row = async (sql: string, args: Array<string | number | null>) => (await db.execute({ sql, args })).rows[0] as unknown as Record<string, unknown>;

  console.log("support-inbox-ingest:");

  // ── A new ticket, its acknowledgement, a repeat ─────────────────────────
  const first = ingestBody({}, clock);
  let firstTicket = { id: "", number: "" };
  await check("a verified client's email opens ONE ticket on OASIS's desk, linked to their client record", async () => {
    const a = await post(first);
    assert.equal(a.status, 200);
    assert.equal(a.body.disposition, "new_ticket");
    const t = ticketOf(a)!;
    assert.match(t.number, /^T-\d{4,9}$/);
    firstTicket = t;
    const r = await row("SELECT * FROM support_tickets WHERE id = ?", [t.id]);
    assert.equal(r.tenant_id, DESK_TENANT, "the tenant comes from the receiving mailbox");
    assert.equal(r.source, "email");
    assert.equal(r.category, "bug");
    assert.equal(r.severity, "high", "urgency high -> severity high");
    assert.equal(r.title, "Bug: Contact form on my site returns an error");
    assert.equal(r.description, first.message.body_text);
    assert.equal(r.client_email, JANE);
    assert.equal(r.customer_id, "cust-jane", "a verified sender is linked to their client record");
    const claim = await row("SELECT * FROM support_email_messages WHERE id = ?", [String(a.body.message_record_id)]);
    assert.equal(claim.ticket_id, t.id);
    assert.ok(claim.completed_at);
    assert.equal(claim.sender_verified, 1);
    const note = await row("SELECT * FROM ticket_comments WHERE ticket_id = ? AND author_type = 'system'", [t.id]);
    assert.equal(note.is_internal, 1, "the routing note is internal");
    assert.match(String(note.body), /Sender verified/);
    const ledger = (await db.execute({ sql: "SELECT event_key, payload_json FROM outcome_events WHERE subject_id = ? ORDER BY event_key", args: [t.id] })).rows;
    assert.deepEqual(ledger.map((l) => l.event_key), ["ticket.message_received", "ticket.opened"]);
    assert.deepEqual(JSON.parse(String(ledger[0].payload_json)), { disposition: "new_ticket", facet: "bug", sender: "verified", urgency: "high" });
    assert.equal(JSON.parse(String(ledger[1].payload_json)).channel, "email");
  });

  await check("the acknowledgement: permitted, verified, new -> ONE email from the support lane, threaded on the client's message", async () => {
    const acks = notify.emails.filter((m) => m.to === JANE);
    assert.equal(acks.length, 1, JSON.stringify(notify.emails.map((m) => m.to)));
    const ack = acks[0];
    assert.equal(ack.subject, `Re: Contact form on my site returns an error [${firstTicket.number}]`);
    assert.equal(ack.inReplyTo, first.message.message_id);
    assert.ok((ack.references ?? []).includes(first.message.message_id as string));
    assert.equal(ack.autoSubmitted, "auto-replied");
    assert.equal(ack.idempotencyKey, `support-ack:${firstTicket.id}`);
    assert.ok(!ack.ownTicketReply, "the acknowledgement is never exempt from the opt-out list");
    assert.match(ack.body, new RegExp(firstTicket.number));
    assert.ok(!ack.body.includes("contact form on /contact"), "it never echoes what the client wrote");
    assert.equal(await scalar(db, "SELECT client_ack_status FROM support_tickets WHERE id = ?", [firstTicket.id]), "email: sent");
    const out = await row("SELECT * FROM support_email_messages WHERE direction = 'outbound' AND ticket_id = ?", [firstTicket.id]);
    assert.equal(out.message_id, thread.deskMessageId(`support-ack:${firstTicket.id}`), "recorded so the client's reply threads back");
    assert.ok(notify.telegrams.some((t) => t.includes(firstTicket.number)), "the founders were alerted");
  });

  await check("a repeat of the same message is the same answer: same number, no second ticket, no second acknowledgement", async () => {
    const before = await ticketCount();
    const emails = notify.emails.length;
    const a = await post(first);
    assert.equal(a.status, 200);
    assert.equal(a.body.duplicate, true);
    assert.equal(ticketOf(a)!.number, firstTicket.number);
    assert.equal(await ticketCount(), before);
    assert.equal(notify.emails.length, emails);
  });

  await check("the same key with other content is 409 (never filed over the first)", async () => {
    const other = { ...first, message: { ...first.message, body_text: "Something else entirely." } };
    const a = await post(other);
    assert.equal(a.status, 409);
    assert.equal(a.body.error, "message_id_conflict");
  });

  await check("ack_wanted false: never acknowledged, whatever else is true", async () => {
    const a = await post(ingestBody({ ack_wanted: false, message: { from: { address: "second@client.test", name: "Second" }, subject: "A second question" } }, clock));
    assert.equal(a.body.disposition, "new_ticket");
    assert.equal(a.body.ack, "skipped:not_wanted");
    assert.equal(notify.emails.filter((m) => m.to === "second@client.test").length, 0);
    assert.match(String(await scalar(db, "SELECT client_ack_status FROM support_tickets WHERE id = ?", [ticketOf(a)!.id])), /^email: not sent/);
  });

  await check("an unverified sender: a ticket, no acknowledgement, no client link, even with ack_wanted true", async () => {
    // A client record exists for this address: an unverified sender is still not linked to it.
    await db.execute({
      sql: `INSERT INTO customers (id, tenant_id, display_name, primary_email, lifecycle, created_at, updated_at)
            VALUES ('cust-unv', ?, 'Unverified Co', 'unverified@client.test', 'active', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
      args: [DESK_TENANT],
    });
    const a = await post(ingestBody({ message: { from: { address: "unverified@client.test", name: "U" }, subject: "Please help", auth: { aligned: false, dmarc: "fail" } } }, clock));
    assert.equal(a.body.disposition, "new_ticket");
    assert.equal(a.body.ack, "skipped:sender_not_verified");
    const t = ticketOf(a)!;
    assert.equal(await scalar(db, "SELECT customer_id FROM support_tickets WHERE id = ?", [t.id]), null);
    assert.equal(notify.emails.filter((m) => m.to === "unverified@client.test").length, 0);
  });

  // ── Threading ────────────────────────────────────────────────────────────
  const ackId = thread.deskMessageId(`support-ack:${firstTicket.id}`);
  await check("a reply to our acknowledgement (In-Reply-To = its Message-ID) joins the ticket as the client's comment", async () => {
    const before = await ticketCount();
    const body = ingestBody({ message: { in_reply_to: ackId, references: [first.message.message_id as string, ackId], subject: "Re: Contact form", body_text: "It also fails on mobile." } }, clock);
    const a = await post(body);
    assert.equal(a.body.disposition, "appended");
    assert.equal(ticketOf(a)!.number, firstTicket.number);
    assert.equal(await ticketCount(), before);
    const c = await row("SELECT * FROM ticket_comments WHERE ticket_id = ? AND author_type = 'client'", [firstTicket.id]);
    assert.equal(c.body, "It also fails on mobile.");
    assert.equal(c.channel, "email");
    assert.equal(c.is_internal, 0);
    assert.equal(a.body.ack, "skipped:not_a_new_ticket");
    assert.ok(notify.telegrams.some((t) => t.includes(`Client replied by email on ${firstTicket.number}`)));
  });

  await check("the subject tag threads a reply whose mail client dropped the headers", async () => {
    const a = await post(ingestBody({ message: { subject: `Re: [${firstTicket.number}] still broken`, body_text: "Any news?" } }, clock));
    assert.equal(a.body.disposition, "appended");
    assert.equal(ticketOf(a)!.id, firstTicket.id);
  });

  await check("a stranger who quotes the ticket opens a NEW one: their words never land on another client's ticket", async () => {
    const comments = Number(await scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ?", [firstTicket.id]));
    const a = await post(ingestBody({ message: { from: { address: "sam@stranger.test", name: "Sam" }, subject: `[${firstTicket.number}] I have thoughts`, in_reply_to: ackId } }, clock));
    assert.equal(a.body.disposition, "new_ticket");
    assert.notEqual(ticketOf(a)!.id, firstTicket.id);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ?", [firstTicket.id])), comments);
    const note = await row("SELECT body FROM ticket_comments WHERE ticket_id = ? AND author_type = 'system'", [ticketOf(a)!.id]);
    assert.match(String(note.body), new RegExp(`referred to ${firstTicket.number}, but the sender is not on that ticket`));
  });

  await check("an unverified sender never joins a ticket, even its own requester's address quoting the tag", async () => {
    const a = await post(ingestBody({ message: { subject: `Re: [${firstTicket.number}]`, auth: { aligned: false } } }, clock));
    assert.equal(a.body.disposition, "new_ticket");
    assert.notEqual(ticketOf(a)!.id, firstTicket.id);
  });

  await check("same verified sender, same subject, an open ticket from the last 7 days: that ticket", async () => {
    const from = { address: "finance@client.test", name: "Finance" };
    const opened = await post(ingestBody({ message: { from, subject: "Invoice question", body_text: "Where is my invoice?" }, classification: { facet: "billing" } }, clock));
    const again = await post(ingestBody({ message: { from, subject: "RE: invoice   QUESTION", body_text: "Following up." }, classification: { facet: "billing" } }, clock));
    assert.equal(again.body.disposition, "appended");
    assert.equal(ticketOf(again)!.id, ticketOf(opened)!.id);
    // Another sender with the same subject is not on that ticket.
    const other = await post(ingestBody({ message: { from: { address: "other@client.test", name: "O" }, subject: "Invoice question" }, classification: { facet: "billing" } }, clock));
    assert.equal(other.body.disposition, "new_ticket");
  });

  await check("a resolved ticket reopens when the client emails, and the ledger records ticket.reopened", async () => {
    await store.updateTicket(db, DESK_TENANT, firstTicket.id, { status: "resolved" }, { userId: "u-cc", name: "CC" }, tick());
    const a = await post(ingestBody({ message: { subject: `Re: [${firstTicket.number}]`, body_text: "It broke again." } }, clock));
    assert.equal(a.body.disposition, "appended");
    assert.equal(ticketOf(a)!.status, "open");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM outcome_events WHERE subject_id = ? AND event_key = 'ticket.reopened'", [firstTicket.id])), 1);
  });

  await check("a closed ticket is never reopened by email: a follow-up ticket, a note on the old one", async () => {
    await store.updateTicket(db, DESK_TENANT, firstTicket.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, tick());
    const a = await post(ingestBody({ message: { subject: `Re: [${firstTicket.number}] one more thing`, body_text: "One more thing." } }, clock));
    assert.equal(a.body.disposition, "follow_up");
    const t = ticketOf(a)!;
    assert.notEqual(t.id, firstTicket.id);
    assert.match(String(await scalar(db, "SELECT title FROM support_tickets WHERE id = ?", [t.id])), new RegExp(`^Follow-up to ${firstTicket.number}: `));
    assert.equal(await scalar(db, "SELECT status FROM support_tickets WHERE id = ?", [firstTicket.id]), "closed");
    const notes = (await db.execute({ sql: "SELECT body, is_internal FROM ticket_comments WHERE ticket_id = ? AND author_type = 'system'", args: [firstTicket.id] })).rows;
    const followNote = notes.find((n) => /follow-up ticket/.test(String(n.body)));
    assert.ok(followNote, "the old ticket says where the client's message went");
    assert.equal(followNote.is_internal, 1);
  });

  // ── Not a ticket ─────────────────────────────────────────────────────────
  await check("non-ticket mail is 2xx with no ticket, and keeps only the sender's domain", async () => {
    const before = await ticketCount();
    for (const kind of ["bulk", "platform", "sales_lead", "spam", "automated", "internal", "empty"]) {
      const a = await post(ingestBody({ message: { from: { address: `news@${kind}.example`, name: "News" } }, classification: { is_support_request: false, non_ticket_kind: kind } }, clock));
      assert.equal(a.status, 200, kind);
      assert.equal(a.body.disposition, "not_a_ticket", kind);
      assert.equal(a.body.ticket, null, kind);
      const claim = await row("SELECT from_address, subject FROM support_email_messages WHERE id = ?", [String(a.body.message_record_id)]);
      assert.equal(claim.from_address, `@${kind}.example`);
      assert.equal(claim.subject, null);
    }
    assert.equal(await ticketCount(), before);
    assert.ok(notify.telegrams.some((t) => t.includes("[HOT-LEAD]")), "a sales lead is told to the founders");
  });

  await check("machine mail never opens or joins a ticket: an out-of-office answer to our acknowledgement is nothing", async () => {
    const from = { address: "fresh@client.test", name: "Fresh" };
    const t2 = await post(ingestBody({ message: { from, subject: "Fresh issue" } }, clock));
    const ack = thread.deskMessageId(`support-ack:${ticketOf(t2)!.id}`);
    await store.updateTicket(db, DESK_TENANT, ticketOf(t2)!.id, { status: "resolved" }, { userId: "u-cc", name: "CC" }, tick());
    const a = await post(ingestBody({ message: { from, in_reply_to: ack, subject: "Out of office", auto_submitted: true } }, clock));
    assert.equal(a.body.disposition, "not_a_ticket");
    assert.equal(await scalar(db, "SELECT status FROM support_tickets WHERE id = ?", [ticketOf(t2)!.id]), "resolved", "not reopened");
  });

  await check("a bounce of OUR email becomes an internal note on that ticket; an unmatched one is nothing", async () => {
    const t = await post(ingestBody({ message: { from: { address: "bounce@client.test", name: "B" }, subject: "Bounce me" } }, clock));
    const ack = thread.deskMessageId(`support-ack:${ticketOf(t)!.id}`);
    const a = await post(
      ingestBody(
        { message: { from: { address: "mailer-daemon@googlemail.com", name: null }, references: [ack.toLowerCase()], subject: "Delivery Status Notification (Failure)", auto_submitted: true, auth: { aligned: false } }, classification: { is_support_request: false, non_ticket_kind: "bounce" } },
        clock,
      ),
    );
    assert.equal(a.body.disposition, "bounce_noted");
    assert.equal(ticketOf(a)!.id, ticketOf(t)!.id);
    const note = await row("SELECT body, is_internal FROM ticket_comments WHERE ticket_id = ? AND author_type = 'system' ORDER BY created_at DESC LIMIT 1", [ticketOf(t)!.id]);
    assert.match(String(note.body), /delivery failure report/);
    assert.equal(note.is_internal, 1);
    const none = await post(ingestBody({ message: { from: { address: "mailer-daemon@googlemail.com", name: null }, references: ["<nothing@nowhere>"], auto_submitted: true }, classification: { is_support_request: false, non_ticket_kind: "bounce" } }, clock));
    assert.equal(none.body.disposition, "not_a_ticket");
  });

  await check("mail from support@ itself (or a plus-address of it) is a loop: never a ticket", async () => {
    for (const address of [MAILBOX, "support+desk@oasisai.work"]) {
      const a = await post(ingestBody({ message: { from: { address, name: "OASIS AI Support" } } }, clock));
      assert.equal(a.body.disposition, "not_a_ticket");
      assert.equal(a.body.reason, "loop");
    }
  });

  // ── Opt-out ──────────────────────────────────────────────────────────────
  await check("an opt-out files the ticket, sends nothing, and records the sender on OASIS's opt-out list once", async () => {
    const body = ingestBody({ ack_wanted: true, message: { from: { address: "stop@client.test", name: "Stop" }, subject: "STOP", body_text: "STOP" }, classification: { opt_out: true, facet: "other" } }, clock);
    const a = await post(body);
    assert.equal(a.body.disposition, "new_ticket", "a person still reads it");
    assert.equal(a.body.ack, "skipped:opt_out");
    assert.equal(a.body.draft_wanted, false);
    assert.equal(a.body.opt_out_recorded, true);
    assert.equal(notify.emails.filter((m) => m.to === "stop@client.test").length, 0);
    const s = await row("SELECT * FROM email_suppressions WHERE email = 'stop@client.test'", []);
    assert.equal(s.tenant_id, DESK_TENANT, "OASIS's own list, the one every sender checks");
    assert.equal(s.brand, "OASIS AI");
    assert.equal(s.source, "support_inbox");
    await post(ingestBody({ message: { from: { address: "stop@client.test", name: "Stop" }, subject: "STOP again" }, classification: { opt_out: true } }, clock));
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM email_suppressions WHERE email = 'stop@client.test'")), 1);
  });

  // ── Limits ───────────────────────────────────────────────────────────────
  await check("past three new tickets in ten minutes, a sender's next email joins their newest open ticket", async () => {
    const from = { address: "busy@client.test", name: "Busy" };
    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push(ticketOf(await post(ingestBody({ message: { from, subject: `Topic ${i}` } }, clock)))!.id);
    const fourth = await post(ingestBody({ message: { from, subject: "Topic 3" } }, clock));
    assert.equal(fourth.body.disposition, "appended");
    assert.equal(ticketOf(fourth)!.id, made[2]);
  });

  await check("a fourth acknowledgement to one address inside ten minutes is skipped (sender_limit)", async () => {
    const from = { address: "acks@client.test", name: "Acks" };
    for (let i = 0; i < 3; i++) {
      const a = await post(ingestBody({ message: { from, subject: `Q${i}` } }, clock));
      assert.equal(a.body.ack, "scheduled");
      await store.updateTicket(db, DESK_TENANT, ticketOf(a)!.id, { status: "resolved" }, { userId: "u-cc", name: "CC" }, clock);
    }
    const a = await post(ingestBody({ message: { from, subject: "Q3" } }, clock));
    assert.equal(a.body.disposition, "new_ticket");
    assert.equal(a.body.ack, "skipped:sender_limit");
  });

  // ── Send mode, reconcile, resume, keys ──────────────────────────────────
  await check("dry run: a decided acknowledgement sends nothing while email sending is off", async () => {
    notify = fakeNotify({ live: false });
    const a = await post(ingestBody({ message: { from: { address: "dry@client.test", name: "Dry" } } }, clock));
    assert.equal(a.body.ack, "scheduled");
    assert.equal(notify.emails.filter((m) => m.to === "dry@client.test").length, 0);
    assert.match(String(await scalar(db, "SELECT client_ack_status FROM support_tickets WHERE id = ?", [ticketOf(a)!.id])), /dry run/);
    notify = fakeNotify();
  });

  await check("the reconcile pass sends a lost acknowledgement only when one was decided", async () => {
    const meant = await post(ingestBody({ message: { from: { address: "lost@client.test", name: "Lost" } } }, clock), { drop: true });
    const refused = await post(ingestBody({ message: { from: { address: "spoof@client.test", name: "Spoof" }, auth: { aligned: false } } }, clock), { drop: true });
    // As if the request died before its finish: no claim stamp on the ticket.
    await db.execute({ sql: "UPDATE support_tickets SET client_ack_at = NULL, client_ack_status = NULL WHERE id = ?", args: [ticketOf(refused)!.id] });
    await reconcileSupportIntake(db, notify.deps, tick(5));
    assert.equal(notify.emails.filter((m) => m.to === "lost@client.test").length, 1, "the decided acknowledgement goes");
    assert.equal(notify.emails.filter((m) => m.to === "spoof@client.test").length, 0, "the refused one never does");
    assert.match(String(await scalar(db, "SELECT client_ack_status FROM support_tickets WHERE id = ?", [ticketOf(refused)!.id])), /not sent/);
    assert.equal(ticketOf(meant)!.status, "open");
  });

  await check("a retry after a crash finishes the SAME plan: one ticket, the planned id", async () => {
    let crashed = false;
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: unknown, mode: unknown) => {
            if (!crashed && JSON.stringify(stmts).includes("completed_at = ?, updated_at = ?")) {
              crashed = true;
              throw new Error("simulated crash before the finish");
            }
            return (target.batch as (a: unknown, b: unknown) => Promise<unknown>)(stmts, mode);
          };
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as Client;
    const body = ingestBody({ message: { from: { address: "crash@client.test", name: "Crash" } } }, clock);
    const now = tick();
    await assert.rejects(
      intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", body, now), { db: flaky, env: ENV, now, notify: notify.deps, schedule: notify.schedule }),
      /simulated crash/,
    );
    const planned = JSON.parse(String(await scalar(db, "SELECT plan_json FROM support_email_messages WHERE from_address = 'crash@client.test'"))).ticketId;
    const a = await post(body);
    assert.equal(a.status, 200);
    assert.equal(ticketOf(a)!.id, planned);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM support_tickets WHERE client_email = 'crash@client.test'")), 1);
  });

  await check("a message with no Message-ID is keyed exactly as the reader keys it, and deduped on it", async () => {
    const body = ingestBody({ message: { message_id: null, from: { address: "noid@client.test", name: "No Id" } } }, clock);
    const a = await post(body);
    const m = body.message;
    const expected = createHash("sha256").update([m.received_at, m.from.address, m.subject, m.body_text].join("\n"), "utf8").digest("hex");
    assert.equal(await scalar(db, "SELECT message_id_hash FROM support_email_messages WHERE id = ?", [String(a.body.message_record_id)]), expected);
    const again = await post(body);
    assert.equal(again.body.duplicate, true);
    assert.equal(ticketOf(again)!.number, ticketOf(a)!.number);
  });

  await check("a Message-ID is keyed by sha256 of the id exactly as sent", async () => {
    const id = messageId("Key");
    const a = await post(ingestBody({ message: { message_id: id, from: { address: "key@client.test", name: "Key" } } }, clock));
    assert.equal(await scalar(db, "SELECT message_id_hash FROM support_email_messages WHERE id = ?", [String(a.body.message_record_id)]), createHash("sha256").update(id, "utf8").digest("hex"));
  });

  await check("a linked client's email is mirrored into their Conversations once; anyone else's never", async () => {
    const mirrored = Number(await scalar(db, "SELECT COUNT(*) FROM lead_interactions WHERE provider = 'support_inbox'"));
    const linked = Number(
      await scalar(
        db,
        `SELECT COUNT(*) FROM support_email_messages m JOIN support_tickets t ON t.id = m.ticket_id
         WHERE m.direction = 'inbound' AND m.disposition IN ('new_ticket','appended','follow_up') AND t.customer_id IS NOT NULL`,
      ),
    );
    assert.ok(linked >= 4, `jane's emails on her linked tickets (${linked})`);
    assert.equal(mirrored, linked, "one row per filed email on a linked client's ticket, none for anyone else");
    const meta = JSON.parse(String(await scalar(db, "SELECT metadata FROM lead_interactions WHERE provider = 'support_inbox' LIMIT 1")));
    assert.equal(meta.customer_id, "cust-jane");
    assert.equal(await scalar(db, "SELECT last_direction FROM conversation_threads WHERE thread_key = ?", [`email:${JANE}`]), "inbound");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM lead_interactions WHERE provider = 'support_inbox' AND from_email = 'sam@stranger.test'")), 0);
  });

  await check("the SLA clock starts when the mail arrived, never more than 14 days back", async () => {
    const now = clock;
    const twoHours = new Date(now.getTime() - 2 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const a = await post(ingestBody({ message: { received_at: twoHours, from: { address: "late@client.test", name: "Late" } }, classification: { urgency: "high" } }, now));
    const t = await row("SELECT created_at, sla_target FROM support_tickets WHERE id = ?", [ticketOf(a)!.id]);
    assert.equal(Date.parse(String(t.created_at)), Date.parse(twoHours));
    assert.equal(Date.parse(String(t.sla_target)), Date.parse(twoHours) + 4 * 3_600_000);
    const old = await post(ingestBody({ message: { received_at: "2026-08-01T00:00:00Z", from: { address: "old@client.test", name: "Old" } } }, clock));
    const created = Date.parse(String(await scalar(db, "SELECT created_at FROM support_tickets WHERE id = ?", [ticketOf(old)!.id])));
    assert.ok(Math.abs(created - (clock.getTime() - 14 * 86_400_000)) < 5 * 60_000, "clamped to 14 days back");
  });

  await check("the instant acknowledgement for a verified sender is exactly once across after() and the reconcile pass", async () => {
    const a = await post(ingestBody({ message: { from: { address: "once@client.test", name: "Once" } } }, clock));
    await reconcileSupportIntake(db, notify.deps, tick(5));
    assert.equal(notify.emails.filter((m) => m.to === "once@client.test").length, 1);
    assert.equal(await scalar(db, "SELECT ack_status FROM support_email_messages WHERE id = ?", [String(a.body.message_record_id)]), "sent");
  });

  finish("support-inbox-ingest");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
