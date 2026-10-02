/**
 * support-inbox-drafts.test.ts — reply drafts for email tickets: which emails
 * the reader is asked to draft (/pending-drafts), how a draft is filed
 * (/draft: ONE reply_ticket approval in Client Success, or a "reply by hand"
 * note on a failure report), and what an approved draft does
 * (lib/os/approvals/executors.ts reply_ticket), driven through the real
 * handlers and the real approvals store and executor.
 *
 * Pins: wanted, unfiled, unfailed and newest-on-the-ticket only, with every
 * field the drafter reads; one approval per message record, repeats absorbed
 * (same words 200, other words 409, a repeated failure report 200); a newer
 * message's draft supersedes the pending one; a draft for an address no
 * verified email came from (a teammate's forward) is a private note flagged
 * "Recipient not verified", never an approval; the executor posts the reply as
 * the approver's public comment (first response, ticket.first_response),
 * emails it threaded on the client's latest message from the support lane with
 * no approver Cc, as a reply to their own ticket; it refuses a stale draft, a
 * closed ticket, a changed recipient, an unverified recipient, an approval the
 * record does not name as its draft and a missing mailbox before anything is
 * posted, and a dry run posts and sends nothing.
 *
 * Run: node --conditions=react-server --import tsx tests/support-inbox-drafts.test.ts
 */
import "./_support-inbox-harness";
import assert from "node:assert/strict";
import {
  CLIENT_A,
  DESK_TENANT,
  ENV,
  MAILBOX,
  USERS,
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

const JANE = "jane@harbourplumbing.test";
const DRAFT = "Hi Jane,\n\nThanks for the details. We are looking at the contact form now and will write again once we know more.\n\nThe OASIS team";
const CRITIC = { verdict: "ship", score: 8.5, issues: [], notes: "Clear and safe." };

async function main() {
  const db = await setupSupportDatabase();
  const intake = await import("../lib/delivery/email-intake");
  const drafts = await import("../lib/delivery/support-drafts");
  const store = await import("../lib/delivery/store");
  const thread = await import("../lib/delivery/email-thread");
  const approvals = await import("../lib/os/approvals/store");
  const rules = await import("../lib/os/approvals/rules");
  const { executeApproval } = await import("../lib/os/approvals/execute");
  const executors = await import("../lib/os/approvals/executors");

  await db.execute({
    sql: `INSERT INTO customers (id, tenant_id, display_name, primary_email, lifecycle, created_at, updated_at)
          VALUES ('cust-jane', ?, 'Harbour Plumbing', ?, 'active', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
    args: [DESK_TENANT, JANE],
  });

  let clock = new Date("2026-10-01T15:00:00.000Z");
  const tick = (m = 1) => (clock = new Date(clock.getTime() + m * 60_000));
  const notify = fakeNotify();
  const deps = () => ({ db, env: ENV, now: clock, notify: notify.deps, schedule: notify.schedule });
  const ingest = async (body: WireBody) => {
    tick();
    const a = await answerOf(await intake.handleSupportIngest(signedRequest("/api/internal/support/ingest", body, clock), deps()));
    await notify.drain();
    assert.equal(a.status, 200, JSON.stringify(a.body));
    return a.body as { message_record_id: string; ticket: { id: string; number: string } | null; disposition: string; draft_wanted: boolean };
  };
  const pending = async (limit = 10) => {
    tick();
    const a = await answerOf(await drafts.handlePendingDrafts(signedRequest("/api/internal/support/pending-drafts", { mailbox: MAILBOX, limit }, clock), deps()));
    assert.equal(a.status, 200);
    return a.body.drafts as Array<Record<string, unknown>>;
  };
  const file = async (body: Record<string, unknown>) => {
    tick();
    const a = await answerOf(await drafts.handleSupportDraft(signedRequest("/api/internal/support/draft", body, clock), deps()));
    await notify.drain();
    return a;
  };
  const draftFor = (rec: { message_record_id: string; ticket: { id: string } | null }, body = DRAFT) => ({
    message_record_id: rec.message_record_id,
    ticket_id: rec.ticket!.id,
    body,
    critic: CRITIC,
    model_ref: "claude-cli:opus",
  });

  const founder = rules.approvalScopeFor({
    tenantId: DESK_TENANT,
    userId: USERS.cc.id,
    persona: "founder",
    canAct: true,
    openDepartments: new Set(rules.DEPARTMENT_KEYS),
  });
  const sent: Array<Record<string, unknown>> = [];
  const execDeps = (over: Record<string, unknown> = {}) =>
    ({
      publishEvent: async () => {},
      isDryRun: () => false,
      sendEmail: async (args: Record<string, unknown>) => {
        sent.push(args);
        return { ok: true, provider: "oasis_shared_gmail", gmail_message_id: `<sent-${sent.length}@oasisai.work>`, from_address: MAILBOX };
      },
      emailSuppression: async () => ({ suppressed: false, checkFailed: false }),
      marketingDb: () => {
        throw new Error("not used");
      },
      marketingSql: () => {
        throw new Error("not used");
      },
      foundersTenantIds: () => [DESK_TENANT],
      signerFor: () => null,
      supportMailboxFrom: async () => MAILBOX,
      ...over,
    }) as never;
  const approve = async (approvalId: string, over: Record<string, unknown> = {}) => {
    const a = await approvals.getApprovalInTenant(db, DESK_TENANT, approvalId);
    const d = await approvals.decideApproval(db, founder, approvalId, { kind: "approve", payloadHash: a!.payload_hash }, new Date());
    assert.ok(d.ok, JSON.stringify(d));
    const x = await executeApproval(db, { tenantId: DESK_TENANT, approvalId, approver: { userId: USERS.cc.id, email: USERS.cc.email } }, execDeps(over));
    assert.ok(x.ok);
    return x.approval;
  };

  console.log("support-inbox-drafts:");

  const main1 = await ingest(ingestBody({}, clock));
  const optOut = await ingest(ingestBody({ message: { from: { address: "stop@client.test", name: "S" }, subject: "STOP" }, classification: { opt_out: true } }, clock));
  const degraded = await ingest(ingestBody({ message: { from: { address: "deg@client.test", name: "D" } }, classification: { fallback: true, facet: "other" } }, clock));
  const unverified = await ingest(ingestBody({ message: { from: { address: "unv@client.test", name: "U" }, auth: { aligned: false } } }, clock));
  const other = await ingest(ingestBody({ message: { from: { address: "q@client.test", name: "Q" } }, classification: { facet: "other" } }, clock));

  await check("pending-drafts: only the emails that want a draft, with every field the drafter reads", async () => {
    assert.equal(main1.draft_wanted, true);
    for (const r of [optOut, degraded, unverified, other]) assert.equal(r.draft_wanted, false);
    const list = await pending();
    assert.deepEqual(list.map((d) => d.message_record_id), [main1.message_record_id]);
    const item = list[0];
    assert.deepEqual(item.ticket, {
      id: main1.ticket!.id,
      number: main1.ticket!.number,
      category: "bug",
      severity: "high",
      title: "Bug: Contact form on my site returns an error",
      status: "open",
    });
    assert.equal(item.facet, "bug");
    assert.equal(item.subject, "Contact form on my site returns an error");
    assert.equal(item.client_first_name, "Jane");
    assert.equal(item.project_title, null);
    assert.match(String(item.latest_message), /contact form on \/contact/);
    assert.deepEqual(item.recent_public_comments, []);
    assert.equal(item.opt_out, false);
    assert.equal(item.fallback, false);
    assert.equal((await pending(1)).length, 1, "at most `limit`");
  });

  let approvalId = "";
  await check("a draft becomes ONE reply_ticket approval in Client Success, filed by the customer-support agent", async () => {
    const a = await file(draftFor(main1));
    assert.equal(a.status, 200);
    assert.equal(a.body.status, "filed");
    approvalId = String(a.body.approval_id);
    const row = await approvals.getApprovalInTenant(db, DESK_TENANT, approvalId);
    assert.equal(row!.action_kind, "reply_ticket");
    assert.equal(row!.department_key, "client_success");
    assert.equal(row!.requested_by_type, "agent");
    assert.equal(row!.requested_by_id, "customer-support");
    assert.equal(row!.target_ref, `ticket:${main1.ticket!.id}`);
    assert.equal(row!.idempotency_key, `support-draft:${main1.message_record_id}`);
    assert.equal(row!.status, "pending");
    assert.equal(Date.parse(String(row!.expires_at)) - Date.parse(String(row!.created_at)), 72 * 3_600_000, "expires after 72 hours");
    assert.match(row!.title, new RegExp(`^Reply to ${main1.ticket!.number} \\(Bug, High\\): Contact form`));
    const p = JSON.parse(row!.payload_json);
    assert.equal(p.to, JANE);
    assert.equal(p.subject, `Re: Contact form on my site returns an error [${main1.ticket!.number}]`);
    assert.equal(p.body, DRAFT);
    assert.equal(p.critic.verdict, "ship");
    assert.equal(p.model_ref, "claude-cli:opus");
    assert.equal(await scalar(db, "SELECT draft_status FROM support_email_messages WHERE id = ?", [main1.message_record_id]), "filed");
    assert.equal((await pending()).length, 0, "a filed email is never offered again");
    assert.ok(notify.telegrams.some((t) => t.includes(`Draft ready on ${main1.ticket!.number}`)), "a high ticket's draft is announced once");
  });

  await check("repeats are absorbed: the same words are the same approval (200), other words are 409", async () => {
    const same = await file(draftFor(main1));
    assert.equal(same.status, 200);
    assert.equal(same.body.approval_id, approvalId);
    assert.equal(same.body.status, "already_filed");
    const changed = await file(draftFor(main1, `${DRAFT}\n\nP.S. One more line.`));
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error, "draft_already_filed");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM approvals WHERE target_ref = ?", [`ticket:${main1.ticket!.id}`])), 1);
  });

  await check("a draft is refused when it is not wanted, not this ticket's, or too short (422), and for a closed ticket (409)", async () => {
    const notWanted = await file({ ...draftFor(other) });
    assert.equal(notWanted.status, 422);
    assert.equal(notWanted.body.error, "draft_not_wanted");
    const mismatch = await file({ ...draftFor(main1), ticket_id: other.ticket!.id });
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.body.error, "ticket_mismatch");
    const unknown = await file({ ...draftFor(main1), message_record_id: "no-such-record" });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.error, "unknown_message_record");
    const short = await file({ ...draftFor(main1), body: "Too short." });
    assert.equal(short.status, 422);
    const closedRec = await ingest(ingestBody({ message: { from: { address: "closed@client.test", name: "C" } } }, clock));
    await store.updateTicket(db, DESK_TENANT, closedRec.ticket!.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, tick());
    const closed = await file(draftFor(closedRec));
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error, "ticket_closed");
  });

  await check("a failure report leaves 'reply by hand' on the ticket once; repeats answer 200; a later draft is 409", async () => {
    const rec = await ingest(ingestBody({ message: { from: { address: "fail@client.test", name: "F" } } }, clock));
    const report = { message_record_id: rec.message_record_id, ticket_id: rec.ticket!.id, model_ref: "claude-cli:opus", body: null, critic: null, failure: "draft_failed", reason: "lint:money+timeline", attempts: 3 };
    const a = await file(report);
    assert.equal(a.status, 200);
    assert.equal(a.body.status, "reported");
    const again = await file(report);
    assert.equal(again.status, 200);
    assert.equal(again.body.status, "already_reported");
    const notes = (await db.execute({ sql: "SELECT body, is_internal FROM ticket_comments WHERE ticket_id = ? AND body LIKE '%Reply by hand%'", args: [rec.ticket!.id] })).rows;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].is_internal, 1);
    assert.ok(!(await pending()).some((d) => d.message_record_id === rec.message_record_id));
    const late = await file(draftFor(rec));
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "draft_failure_reported");
  });

  await check("a newer message on the ticket: only it is offered, and its draft supersedes the pending one", async () => {
    const rec = await ingest(ingestBody({ message: { from: { address: "two@client.test", name: "Two" }, subject: "Two step" } }, clock));
    const first = await file(draftFor(rec));
    const next = await ingest(ingestBody({ message: { from: { address: "two@client.test", name: "Two" }, subject: `Re: [${rec.ticket!.number}]`, body_text: "Also the footer is wrong." } }, clock));
    assert.equal(next.disposition, "appended");
    const offered = (await pending()).map((d) => d.message_record_id);
    assert.ok(offered.includes(next.message_record_id));
    assert.ok(!offered.includes(rec.message_record_id));
    const second = await file(draftFor(next));
    assert.equal(second.status, 200);
    const old = await approvals.getApprovalInTenant(db, DESK_TENANT, String(first.body.approval_id));
    const fresh = await approvals.getApprovalInTenant(db, DESK_TENANT, String(second.body.approval_id));
    assert.equal(old!.status, "cancelled");
    assert.equal(fresh!.supersedes_id, old!.id);
    assert.equal(fresh!.status, "pending");
    // An old draft posted after the newer message arrived is refused, not filed.
    const stale = await ingest(ingestBody({ message: { from: { address: "three@client.test", name: "Three" }, subject: "Three" } }, clock));
    await ingest(ingestBody({ message: { from: { address: "three@client.test", name: "Three" }, subject: `Re: [${stale.ticket!.number}]`, body_text: "More." } }, clock));
    const late = await file(draftFor(stale));
    assert.equal(late.status, 409);
    assert.equal(late.body.error, "superseded_by_newer_message");
  });

  await check("a teammate's forward is drafted for, but its draft is never an approval: a private note, 'Recipient not verified', naming the address", async () => {
    const fwd = await ingest(
      ingestBody({ message: { from: { address: "client@forwarded.test", name: null }, auth: { spf: null, dkim: null, dmarc: null, aligned: false }, forwarded_by: "teammate@oasisai.work" } }, clock),
    );
    assert.equal(fwd.disposition, "new_ticket");
    assert.equal(fwd.draft_wanted, true, "the drafter still writes one");
    assert.ok((await pending()).some((d) => d.message_record_id === fwd.message_record_id));
    const a = await file(draftFor(fwd));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.status, "noted");
    assert.equal(a.body.approval_id, undefined);
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM approvals WHERE idempotency_key = ?", [`support-draft:${fwd.message_record_id}`])), 0, "nothing anyone could approve");
    assert.equal(await scalar(db, "SELECT draft_status FROM support_email_messages WHERE id = ?", [fwd.message_record_id]), "noted");
    const notes = (
      await db.execute({ sql: "SELECT body, is_internal FROM ticket_comments WHERE ticket_id = ? AND body LIKE 'Recipient not verified%'", args: [fwd.ticket!.id] })
    ).rows;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].is_internal, 1, "a private note, never shown to the client");
    assert.match(String(notes[0].body), /^Recipient not verified: confirm the address before sending\./);
    assert.match(String(notes[0].body), /client@forwarded\.test/);
    assert.ok(String(notes[0].body).includes(DRAFT), "the draft is on the note, to copy into a reply");
    assert.ok(!(await pending()).some((d) => d.message_record_id === fwd.message_record_id), "never offered again");
    const again = await file(draftFor(fwd, `${DRAFT}\n\nP.S. A second pass.`));
    assert.equal(again.status, 200);
    assert.equal(again.body.status, "already_noted");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ? AND body LIKE 'Recipient not verified%'", [fwd.ticket!.id])), 1);
  });

  // ── The executor ─────────────────────────────────────────────────────────
  await check("approved: the reply is posted as the approver's public comment and emailed threaded, from the support lane, as an own-ticket reply", async () => {
    const before = sent.length;
    const done = await approve(approvalId);
    assert.equal(done.status, "executed");
    const r = done.execution_result as { outcome: string; comment_id: string; message_id: string; from: string };
    assert.equal(r.outcome, "sent");
    assert.equal(r.from, MAILBOX);
    const c = (await db.execute({ sql: "SELECT * FROM ticket_comments WHERE id = ?", args: [r.comment_id] })).rows[0];
    assert.equal(c.author_type, "team");
    assert.equal(c.author_name, "Conaugh McKenna", "posted as the approver");
    assert.equal(c.is_internal, 0);
    assert.equal(c.body, DRAFT);
    assert.equal(c.channel, "email");
    assert.equal(c.email_status, "email: sent");
    assert.ok(await scalar(db, "SELECT first_response_at FROM support_tickets WHERE id = ?", [main1.ticket!.id]), "the first response is stamped");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM outcome_events WHERE subject_id = ? AND event_key = 'ticket.first_response'", [main1.ticket!.id])), 1);
    assert.equal(sent.length, before + 1);
    const m = sent[sent.length - 1] as Record<string, unknown>;
    assert.equal(m.to, JANE);
    assert.equal(m.purpose, "support");
    assert.deepEqual(m.cc, null, "the approver is not copied");
    const inbound = String(await scalar(db, "SELECT message_id FROM support_email_messages WHERE id = ?", [main1.message_record_id]));
    assert.equal(m.inReplyTo, inbound, "it answers the client's latest message");
    assert.ok((m.references as string[]).includes(inbound));
    assert.deepEqual(m.ownTicketReply, { ticketId: main1.ticket!.id, requester: JANE });
    assert.equal(m.subject, `Re: Contact form on my site returns an error [${main1.ticket!.number}]`);
    assert.ok(String(m.body).startsWith(DRAFT), "the approved words, not wrapped in a second greeting or sign-off");
    assert.equal(r.message_id, thread.deskMessageId(`support-reply:${r.comment_id}`));
    assert.equal(await scalar(db, "SELECT origin FROM support_email_messages WHERE direction = 'outbound' AND comment_id = ?", [r.comment_id]), "reply");
    assert.equal(Number(await scalar(db, "SELECT COUNT(*) FROM lead_interactions WHERE provider = 'support_desk_reply' AND provider_message_id = ?", [r.comment_id])), 1, "mirrored into the client's Conversations");
  });

  const fresh = async (address: string) => {
    const rec = await ingest(ingestBody({ message: { from: { address, name: "Client" } } }, clock));
    const filed = await file(draftFor(rec));
    assert.equal(filed.status, 200);
    return { rec, approvalId: String(filed.body.approval_id) };
  };
  const comments = (ticketId: string) => scalar(db, "SELECT COUNT(*) FROM ticket_comments WHERE ticket_id = ? AND author_type = 'team'", [ticketId]).then(Number);

  await check("a stale draft (the client wrote again since) is refused; nothing is posted or sent", async () => {
    const { rec, approvalId: id } = await fresh("stale@client.test");
    await store.addTicketComment(db, DESK_TENANT, rec.ticket!.id, { body: "Never mind, more info.", is_internal: false, author_type: "client", author: { userId: null, name: "Client" } }, tick(2));
    const before = sent.length;
    const done = await approve(id);
    assert.equal(done.status, "failed");
    assert.equal((done.execution_result as { reason: string }).reason, "stale_draft");
    assert.equal(sent.length, before);
    assert.equal(await comments(rec.ticket!.id), 0);
  });

  await check("a ticket closed since the draft, or a changed client address, is refused before anything is posted", async () => {
    const a = await fresh("closing@client.test");
    await store.updateTicket(db, DESK_TENANT, a.rec.ticket!.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, tick());
    const closed = await approve(a.approvalId);
    assert.equal((closed.execution_result as { reason: string }).reason, "ticket_closed");
    const b = await fresh("moving@client.test");
    await store.updateTicket(db, DESK_TENANT, b.rec.ticket!.id, { client_email: "elsewhere@client.test" }, { userId: "u-cc", name: "CC" }, tick());
    const moved = await approve(b.approvalId);
    assert.equal((moved.execution_result as { reason: string }).reason, "recipient_changed");
    assert.equal(await comments(a.rec.ticket!.id), 0);
    assert.equal(await comments(b.rec.ticket!.id), 0);
  });

  await check("dry run posts and sends nothing; no mailbox configured is refused before posting", async () => {
    const a = await fresh("dry@client.test");
    const before = sent.length;
    const dry = await approve(a.approvalId, { isDryRun: () => true });
    assert.equal((dry.execution_result as { outcome: string }).outcome, "dry_run");
    assert.equal(sent.length, before);
    assert.equal(await comments(a.rec.ticket!.id), 0);
    const b = await fresh("nomail@client.test");
    const none = await approve(b.approvalId, { supportMailboxFrom: async () => null });
    assert.equal((none.execution_result as { reason: string }).reason, "not_configured");
    assert.equal(sent.length, before);
    assert.equal(await comments(b.rec.ticket!.id), 0);
  });

  await check("a send the mail server refuses is recorded: the approval fails with the reason, the comment says not emailed", async () => {
    const a = await fresh("refused@client.test");
    const done = await approve(a.approvalId, {
      sendEmail: async () => ({ ok: false, provider: "oasis_shared_gmail", reason: "send_failed", error: "550 mailbox unavailable" }),
    });
    assert.equal(done.status, "failed");
    assert.equal((done.execution_result as { reason: string }).reason, "send_failed");
    assert.match(String(await scalar(db, "SELECT email_status FROM ticket_comments WHERE ticket_id = ? AND author_type = 'team'", [a.rec.ticket!.id])), /FAILED/);
  });

  await check("an approved reply to an address no verified email on the ticket came from is refused: nothing posted, nothing sent", async () => {
    // As if a forward's draft had been filed as an approval (the filing above
    // never does): its record names it, so only the recipient rule stands.
    const fwd = await ingest(
      ingestBody({ message: { from: { address: "other@forwarded.test", name: null }, auth: { spf: null, dkim: null, dmarc: null, aligned: false }, forwarded_by: "teammate@oasisai.work" } }, clock),
    );
    const made = await approvals.createApproval(
      db,
      {
        tenantId: DESK_TENANT,
        departmentKey: "client_success",
        requestedBy: { type: "agent", id: "customer-support" },
        actionKind: "reply_ticket",
        title: `Reply to ${fwd.ticket!.number}`,
        targetRef: `ticket:${fwd.ticket!.id}`,
        payload: {
          ticket_id: fwd.ticket!.id,
          ticket_number: fwd.ticket!.number,
          message_record_id: fwd.message_record_id,
          to: "other@forwarded.test",
          subject: `Re: Contact form on my site returns an error [${fwd.ticket!.number}]`,
          body: DRAFT,
          critic: CRITIC,
          model_ref: "claude-cli:opus",
        },
        idempotencyKey: `support-draft:${fwd.message_record_id}`,
      },
      clock,
    );
    assert.ok(made.ok, JSON.stringify(made));
    await db.execute({ sql: "UPDATE support_email_messages SET draft_status = 'filed', draft_approval_id = ? WHERE id = ?", args: [made.approval.id, fwd.message_record_id] });
    const before = sent.length;
    const done = await approve(made.approval.id);
    assert.equal(done.status, "failed");
    const r = done.execution_result as { reason: string; message: string };
    assert.equal(r.reason, "recipient_not_verified");
    assert.match(r.message, /other@forwarded\.test/);
    assert.equal(sent.length, before);
    assert.equal(await comments(fwd.ticket!.id), 0);
  });

  await check("an approval its email's record does not name as the filed draft (a failure report won) is refused: nothing posted, nothing sent", async () => {
    const { rec, approvalId: id } = await fresh("orphan@client.test");
    await db.execute({ sql: "UPDATE support_email_messages SET draft_status = 'failed', draft_approval_id = NULL WHERE id = ?", args: [rec.message_record_id] });
    const before = sent.length;
    const done = await approve(id);
    assert.equal(done.status, "failed");
    assert.equal((done.execution_result as { reason: string }).reason, "draft_not_current");
    assert.equal(sent.length, before);
    assert.equal(await comments(rec.ticket!.id), 0);
  });

  await check("only OASIS's desk can carry out a ticket reply", async () => {
    const r = executors.executorReadiness("reply_ticket", { id: CLIENT_A, slug: "client-a" }, executors.defaultExecutorDeps());
    assert.equal(r.executable, false);
    assert.equal(executors.executorReadiness("reply_ticket", { id: DESK_TENANT, slug: "oasis-ai-cc" }, executors.defaultExecutorDeps()).executable, true);
  });

  finish("support-inbox-drafts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
