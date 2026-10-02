/**
 * support-inbox-rules.test.ts — the rules the support inbox stands on, one by
 * one: the ticket vocabulary (email source, access category, facet mapping),
 * finding a ticket number in a subject, Message-ID normalisation, the thread
 * subject, the support inbox registry, the acknowledgement and draft
 * decisions, the threading headers on a composed message, the ledger key and
 * the reply_ticket payload; and, through the real shared sender with its
 * transport stubbed, THE OPT-OUT RULE: a reply to a client's own ticket goes
 * out after a marketing opt-out, and nothing else does.
 *
 * Also the store's idempotency the support inbox relies on: createTicket on a
 * supplied id, addTicketComment on a supplied id (one comment, one reopening),
 * and a comment channel written only when given.
 *
 * Run: node --conditions=react-server --import tsx tests/support-inbox-rules.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { OASIS, check, finish, setupDatabase } from "./_delivery-harness";

function stubModule(path: string, exports: Record<string, unknown>) {
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

// The transport records instead of sending; the opt-out list says what the test says.
const sent: Array<Record<string, unknown>> = [];
stubModule(require.resolve("nodemailer"), {
  createTransport: () => ({
    sendMail: async (mail: Record<string, unknown>) => {
      sent.push(mail);
      return { messageId: String(mail.messageId ?? `<t-${sent.length}@oasisai.work>`) };
    },
  }),
});
let suppressedList = new Set<string>();
let lookupFails = false;
stubModule(require.resolve("../lib/lead-interactions-queries"), {
  checkEmailSuppressed: async (_tenant: string, email: string) =>
    lookupFails ? { suppressed: false, checkFailed: true } : { suppressed: suppressedList.has(String(email).toLowerCase()), checkFailed: false },
});
stubModule(require.resolve("../lib/tenant-integration-store"), { getTenantIntegrationBundle: async () => ({}) });

const SUPPORT = "support@oasisai.work";
const CLIENT = "jane@harbourplumbing.test";

async function main() {
  const rules = await import("../lib/delivery/rules");
  const messages = await import("../lib/delivery/messages");
  const mailbox = await import("../lib/email/support-mailbox");
  const intake = await import("../lib/delivery/email-intake");
  const shared = await import("../lib/integrations/oasis-shared-gmail-send");
  const catalog = await import("../lib/ledger/catalog");
  const approvalRules = await import("../lib/os/approvals/rules");

  console.log("support-inbox-rules:");

  await check("the ticket vocabulary: email is a source, access a category with its label", async () => {
    assert.ok((rules.TICKET_SOURCES as readonly string[]).includes("email"));
    assert.ok((rules.TICKET_CATEGORIES as readonly string[]).includes("access"));
    assert.equal(rules.TICKET_CATEGORY_LABELS.access, "Access");
  });

  await check("facet and urgency map to a category and a severity; an unknown label degrades to other / medium", async () => {
    const table: Array<[string, string, string, string]> = [
      ["bug", "critical", "bug", "critical"],
      ["how_to", "high", "question", "high"],
      ["billing", "normal", "billing", "medium"],
      ["access", "low", "access", "low"],
      ["feature_request", "normal", "change_request", "medium"],
      ["other", "normal", "other", "medium"],
      ["urgent", "asap", "other", "medium"],
    ];
    for (const [facet, urgency, category, severity] of table) {
      assert.deepEqual(rules.supportFacetToTicket(facet, urgency), { category, severity }, `${facet}/${urgency}`);
    }
  });

  await check("a ticket number in a subject: [T-0042], (T-0042), a bare T-0042; never inside another word, never two different ones", async () => {
    const table: Array<[string, number | null]> = [
      ["[T-0042] Login broken", 42],
      ["Re: Login broken (T-0042)", 42],
      ["Re: T-0042 still broken", 42],
      ["re: t-0042", 42],
      ["T-0042 and again T-0042", 42],
      ["XT-0042 is a part number", null],
      ["T-0042a", null],
      ["pre-T-0042", null],
      ["T-42", null],
      ["T-0042 and T-0043", null],
      ["No ticket here", null],
      ["[T-123456789]", 123456789],
    ];
    for (const [subject, seq] of table) assert.equal(rules.findTicketRefInSubject(subject), seq, subject);
  });

  await check("Message-IDs are normalised the way the reader normalises them", async () => {
    assert.equal(rules.normalizeMessageId("<abc@host>"), "<abc@host>");
    assert.equal(rules.normalizeMessageId("  <a b@host >  "), "<ab@host>");
    assert.equal(rules.normalizeMessageId("abc@host"), "<abc@host>");
    assert.equal(rules.normalizeMessageId("x <first@h> <second@h>"), "<first@h>");
    assert.equal(rules.normalizeMessageId("<CaSe@Host>"), "<CaSe@Host>", "case kept");
    assert.equal(rules.normalizeMessageId(""), null);
    assert.equal(rules.normalizeMessageId(`<${"a".repeat(999)}>`), null);
  });

  await check("the thread subject: one Re:, the client's words, the tag once; the same-subject key ignores prefixes and tags", async () => {
    assert.equal(messages.emailThreadSubject("Re: RE: Fwd: Login broken [T-0042]", "T-0042"), "Re: Login broken [T-0042]");
    assert.equal(messages.emailThreadSubject("", "T-0001"), "Re: Your request [T-0001]");
    assert.ok(messages.emailThreadSubject("x".repeat(500), "T-0001").length <= 200);
    assert.equal(rules.normalizeSubjectForThread("RE: [T-0042]  Login   BROKEN"), "login broken");
    assert.equal(rules.normalizeSubjectForThread("AW: SV: TR: Hello"), "hello");
  });

  await check("the support inbox registry: support@ files into OASIS's desk; nothing else is a support inbox", async () => {
    assert.equal(mailbox.supportInboxDeskTenant("support@oasisai.work"), OASIS);
    assert.equal(mailbox.supportInboxDeskTenant(" Support@OASISai.work "), OASIS);
    for (const other of ["conaugh@oasisai.work", "support@example.com", "support+x@oasisai.work", "", null]) {
      assert.equal(mailbox.supportInboxDeskTenant(other), null, String(other));
    }
    assert.equal(mailbox.supportInboxForDesk(OASIS), SUPPORT);
    assert.equal(intake.deskForMailbox("help@oasisai.work"), null);
  });

  await check("a plus-address belongs to its mailbox; look-alikes do not", async () => {
    assert.equal(mailbox.isAddressOfMailbox("support@oasisai.work", SUPPORT), true);
    assert.equal(mailbox.isAddressOfMailbox("support+client-a@oasisai.work", SUPPORT), true);
    for (const no of ["support+@oasisai.work", "supportx@oasisai.work", "support+a@oasisai.work.evil", "support+a@evil@oasisai.work", "xsupport@oasisai.work"]) {
      assert.equal(mailbox.isAddressOfMailbox(no, SUPPORT), false, no);
    }
  });

  await check("the acknowledgement decision: the reader's permission AND a new ticket, a verified human, no opt-out, under the limit", async () => {
    const base = { ackWanted: true, disposition: "new_ticket" as const, sender: "verified" as const, autoSubmitted: false, optOut: false, recentAcks: { tenMinutes: 0, day: 0 } };
    assert.equal(intake.ackDecision(base), "scheduled");
    assert.equal(intake.ackDecision({ ...base, disposition: "follow_up" }), "scheduled");
    assert.equal(intake.ackDecision({ ...base, ackWanted: false }), "skipped:not_wanted");
    assert.equal(intake.ackDecision({ ...base, optOut: true }), "skipped:opt_out");
    assert.equal(intake.ackDecision({ ...base, optOut: true, ackWanted: true }), "skipped:opt_out", "never for an opt-out, even if asked");
    assert.equal(intake.ackDecision({ ...base, disposition: "appended" }), "skipped:not_a_new_ticket");
    assert.equal(intake.ackDecision({ ...base, sender: "unverified" }), "skipped:sender_not_verified");
    assert.equal(intake.ackDecision({ ...base, sender: "forwarded" }), "skipped:sender_not_verified");
    assert.equal(intake.ackDecision({ ...base, autoSubmitted: true }), "skipped:automated");
    assert.equal(intake.ackDecision({ ...base, recentAcks: { tenMinutes: 3, day: 3 } }), "skipped:sender_limit");
    assert.equal(intake.ackDecision({ ...base, recentAcks: { tenMinutes: 0, day: 10 } }), "skipped:sender_limit");
    assert.equal(intake.ackDecision({ ...base, recentAcks: { tenMinutes: 2, day: 9 } }), "scheduled");
  });

  await check("a draft is wanted for a person's request on a ticket, read by the model, of a drafted facet, never an opt-out", async () => {
    const c = { isSupportRequest: true, facet: "bug" as const, fallback: false, optOut: false };
    const base = { disposition: "new_ticket" as const, sender: "verified" as const, classification: c, autoSubmitted: false };
    assert.equal(intake.draftWanted(base), true);
    assert.equal(intake.draftWanted({ ...base, sender: "forwarded" }), true, "a teammate's forward is drafted for");
    assert.equal(intake.draftWanted({ ...base, sender: "unverified" }), false);
    assert.equal(intake.draftWanted({ ...base, classification: { ...c, optOut: true } }), false);
    assert.equal(intake.draftWanted({ ...base, classification: { ...c, fallback: true } }), false);
    assert.equal(intake.draftWanted({ ...base, classification: { ...c, facet: "other" } }), false);
    assert.equal(intake.draftWanted({ ...base, disposition: "not_a_ticket" }), false);
    assert.equal(intake.draftWanted({ ...base, autoSubmitted: true }), false);
  });

  await check("a composed support email carries In-Reply-To, References (root + newest) and, for the acknowledgement, Auto-Submitted", async () => {
    const refs = Array.from({ length: 15 }, (_, i) => `<r${i}@client.test>`);
    const m = shared.composeOasisMessage({
      to: CLIENT,
      subject: "Re: Help [T-0001]",
      body: "Hello",
      fromAddress: SUPPORT,
      idempotencyKey: "support-ack:t1",
      purpose: "support",
      inReplyTo: "<r14@client.test>",
      references: [...refs, "<bad id@x>", "<a\r\nBcc: victim@x>"],
      autoSubmitted: "auto-replied",
    });
    assert.equal(m.inReplyTo, "<r14@client.test>");
    assert.deepEqual(m.references, [refs[0], ...refs.slice(-10)], "the root and the ten newest, malformed ids dropped");
    assert.equal(m.headers["Auto-Submitted"], "auto-replied");
    assert.equal(m.replyTo, SUPPORT);
    assert.ok(m.headers["List-Unsubscribe"]?.includes("/api/unsubscribe"));
    const plain = shared.composeOasisMessage({ to: CLIENT, subject: "Hi", body: "x", fromAddress: SUPPORT, purpose: "support" });
    assert.equal(plain.headers["Auto-Submitted"], undefined);
    assert.equal(plain.inReplyTo, undefined);
    assert.equal(plain.references, undefined);
  });

  process.env.SUPPORT_GMAIL_USER = SUPPORT;
  process.env.SUPPORT_GMAIL_APP_PASSWORD = "abcd efgh ijkl mnop";
  const reply = (over: Record<string, unknown> = {}) =>
    shared.sendOasisSharedGmail({
      tenantId: OASIS,
      to: CLIENT,
      subject: "Re: Help [T-0001]",
      body: "We are on it.",
      idempotencyKey: "support-reply:c1",
      purpose: "support",
      ownTicketReply: { ticketId: "t1", requester: CLIENT },
      ...over,
    });

  await check("THE OPT-OUT RULE: a reply to the client's own ticket goes out after a marketing opt-out", async () => {
    suppressedList = new Set([CLIENT]);
    const before = sent.length;
    const r = await reply();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(sent.length, before + 1);
    assert.equal(sent[sent.length - 1].to, CLIENT);
  });

  await check("...and nothing else does: no ticket named, another recipient, sales mail, or the acknowledgement", async () => {
    suppressedList = new Set([CLIENT, "other@client.test"]);
    const before = sent.length;
    const refusals = [
      await reply({ ownTicketReply: null }),
      await reply({ ownTicketReply: { ticketId: "", requester: CLIENT } }),
      await reply({ to: "other@client.test" }),
      await reply({ purpose: "sales" }),
      await reply({ ownTicketReply: null, autoSubmitted: "auto-replied", idempotencyKey: "support-ack:t1" }),
    ];
    for (const r of refusals) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "suppressed");
    }
    assert.equal(sent.length, before);
    assert.equal(shared.isOwnTicketReply({ purpose: "support", to: "JANE@harbourplumbing.test ", ownTicketReply: { ticketId: "t1", requester: CLIENT } }), true);
    assert.equal(shared.isOwnTicketReply({ purpose: "support", to: CLIENT, ownTicketReply: { ticketId: "t1", requester: "" } }), false);
    suppressedList = new Set();
  });

  await check("an own-ticket reply still carries the support lane's identity, footer and threading", async () => {
    const r = await reply({ inReplyTo: "<m1@client.test>", references: ["<m1@client.test>"] });
    assert.equal(r.ok, true);
    const m = sent[sent.length - 1];
    assert.equal(m.from, `"OASIS AI Support" <${SUPPORT}>`);
    assert.equal(m.replyTo, SUPPORT);
    assert.equal(m.inReplyTo, "<m1@client.test>");
    assert.match(String(m.text), /unsubscribe here: https?:\/\//);
  });

  await check("an opt-out list that cannot be read still stops every other email (fail closed); an own-ticket reply does not read it", async () => {
    lookupFails = true;
    try {
      const other = await reply({ ownTicketReply: null });
      assert.equal(other.ok, false);
      if (!other.ok) assert.equal(other.reason, "suppression_error");
      const own = await reply();
      assert.equal(own.ok, true, "the list does not apply to a reply to the client's own ticket");
    } finally {
      lookupFails = false;
    }
  });

  await check("the ledger key: ticket.message_received, owned by the intake, ids and codes only", async () => {
    const e = catalog.catalogEntry("ticket.message_received")!;
    assert.ok(e);
    assert.equal(e.owningModule, "lib/delivery/email-intake.ts");
    assert.equal(e.department, "client_success");
    assert.deepEqual(e.subjectTypes, ["ticket"]);
    assert.equal(e.idempotency, "tktmsg:{message_id_hash}");
    assert.deepEqual(Object.keys(e.payload).sort(), ["disposition", "facet", "sender", "urgency"]);
    assert.deepEqual(catalog.validatePayload(e.payload, { facet: "bug", urgency: "high", disposition: "new_ticket", sender: "verified" }).ok, true);
    assert.equal(catalog.validatePayload(e.payload, { facet: "bug", urgency: "high", disposition: "new_ticket", sender: "jane@x.test" }).ok, false);
  });

  await check("the reply_ticket approval: a kind with its label and outbound risk, and a validated payload", async () => {
    assert.ok((approvalRules.APPROVAL_ACTION_KINDS as readonly string[]).includes("reply_ticket"));
    assert.equal(approvalRules.ACTION_KIND_LABELS.reply_ticket, "Ticket reply");
    assert.equal(approvalRules.DEFAULT_RISK.reply_ticket, "outbound");
    const ok = { ticket_id: "t-1", ticket_number: "T-0001", message_record_id: "r-1", to: "Jane@X.test", subject: "Re: Help [T-0001]", body: "Hello there, we are on it.", critic: { verdict: "ship", score: 8.46, issues: [], notes: "" }, model_ref: "claude-cli:opus" };
    const v = approvalRules.validateReplyTicketPayload(ok);
    assert.ok(v.ok);
    if (v.ok) {
      assert.equal(v.value.to, "jane@x.test");
      assert.equal(v.value.critic?.score, 8.5);
    }
    for (const [field, value] of [["ticket_number", "42"], ["subject", "Hi\r\nBcc: x@y"], ["to", "not-an-email"], ["critic", { verdict: "maybe" }], ["body", ""]] as const) {
      assert.equal(approvalRules.validateReplyTicketPayload({ ...ok, [field]: value }).ok, false, field);
    }
    assert.equal(approvalRules.validateReplyTicketPayload({ ...ok, critic: null }).ok, true, "no critic is allowed");
  });

  // ── The store ────────────────────────────────────────────────────────────
  const db = await setupDatabase();
  const store = await import("../lib/delivery/store");
  const base = {
    title: "Email ticket", description: "x", category: "bug" as const, severity: "high" as const, source: "email" as const,
    project_id: null, client_tenant_id: null, client_name: "Jane", client_email: CLIENT, client_company: null,
    client_match: "none", project_hint: null, reporter_user_id: null, assigned_to: null,
  };
  const now = new Date("2026-10-01T10:00:00.000Z");

  await check("createTicket on a supplied id is idempotent: the same ticket, created:false, one ticket.opened", async () => {
    const a = await store.createTicket(db, OASIS, { ...base, id: "11111111-1111-4111-8111-111111111111" }, now);
    const b = await store.createTicket(db, OASIS, { ...base, id: "11111111-1111-4111-8111-111111111111", title: "Other" }, now);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.ticket.ticket_number, a.ticket.ticket_number);
    assert.equal(b.ticket.title, "Email ticket", "the first write stands");
    assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM support_tickets")).rows[0].n), 1);
    assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM outcome_events WHERE event_key = 'ticket.opened'")).rows[0].n), 1);
  });

  await check("addTicketComment on a supplied id is idempotent: one comment, one reopening, one ticket.reopened", async () => {
    const t = (await store.createTicket(db, OASIS, { ...base, id: "22222222-2222-4222-8222-222222222222" }, now)).ticket;
    await store.updateTicket(db, OASIS, t.id, { status: "resolved" }, { userId: "u", name: "CC" }, now);
    const input = { id: "33333333-3333-4333-8333-333333333333", body: "It broke again", is_internal: false, author_type: "client" as const, author: { userId: null, name: "Jane" } };
    const first = await store.addTicketComment(db, OASIS, t.id, input, new Date(now.getTime() + 60_000));
    const second = await store.addTicketComment(db, OASIS, t.id, input, new Date(now.getTime() + 120_000));
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok) {
      assert.equal(first.reopened, true);
      assert.equal(second.reopened, false);
      assert.equal(second.existing, true);
    }
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ? AND author_type = 'client'", args: [t.id] })).rows[0].n), 1);
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM outcome_events WHERE subject_id = ? AND event_key = 'ticket.reopened'", args: [t.id] })).rows[0].n), 1);
  });

  await check("a guarded comment whose guard no longer holds writes nothing: no comment, no reopening, no first response, answered superseded", async () => {
    const t = (await store.createTicket(db, OASIS, { ...base, id: "55555555-5555-4555-8555-555555555555" }, now)).ticket;
    await store.updateTicket(db, OASIS, t.id, { status: "resolved" }, { userId: "u", name: "CC" }, now);
    const later = new Date(now.getTime() + 60_000);
    const client = { id: "66666666-6666-4666-8666-666666666666", body: "Late", is_internal: false, author_type: "client" as const, author: { userId: null, name: "Jane" } };
    const refused = await store.addTicketComment(db, OASIS, t.id, { ...client, guard: { sql: "1 = ?", args: [0] } }, later);
    assert.deepEqual(refused, { ok: false, status: 409, error: "superseded" });
    const team = await store.addTicketComment(
      db,
      OASIS,
      t.id,
      { id: "77777777-7777-4777-8777-777777777777", body: "Hello", is_internal: false, author_type: "team", author: { userId: "u", name: "CC" }, guard: { sql: "1 = ?", args: [0] } },
      later,
    );
    assert.deepEqual(team, { ok: false, status: 409, error: "superseded" });
    const row = (await db.execute({ sql: "SELECT status, first_response_at FROM support_tickets WHERE id = ?", args: [t.id] })).rows[0];
    assert.equal(row.status, "resolved", "not reopened");
    assert.equal(row.first_response_at, null, "no first response");
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ? AND author_type IN ('client', 'team')", args: [t.id] })).rows[0].n), 0);
    assert.equal(
      Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM outcome_events WHERE subject_id = ? AND event_key IN ('ticket.reopened', 'ticket.first_response')", args: [t.id] })).rows[0].n),
      0,
    );
    // The same comment with a guard that holds is written, and reopens the ticket.
    const held = await store.addTicketComment(db, OASIS, t.id, { ...client, guard: { sql: "1 = ?", args: [1] } }, later);
    assert.ok(held.ok && held.reopened, JSON.stringify(held));
    assert.equal((await db.execute({ sql: "SELECT status FROM support_tickets WHERE id = ?", args: [t.id] })).rows[0].status, "open");
  });

  await check("a client comment on an open ticket neither reports nor records a reopening", async () => {
    const t = (await store.createTicket(db, OASIS, { ...base, id: "88888888-8888-4888-8888-888888888888" }, now)).ticket;
    const r = await store.addTicketComment(db, OASIS, t.id, { body: "One more detail", is_internal: false, author_type: "client", author: { userId: null, name: "Jane" } }, now);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.reopened, false);
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM outcome_events WHERE subject_id = ? AND event_key = 'ticket.reopened'", args: [t.id] })).rows[0].n), 0);
  });

  await check("a ticket closed between the read and the write refuses a client's comment (ticket_closed) and keeps nothing", async () => {
    const t = (await store.createTicket(db, OASIS, { ...base, id: "99999999-9999-4999-8999-999999999999" }, now)).ticket;
    // The ticket is open when read; a person closes it just before the write.
    let closed = false;
    const closing = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: Parameters<typeof db.batch>[0], mode?: Parameters<typeof db.batch>[1]) => {
            if (!closed && stmts.some((x) => /INSERT INTO ticket_comments/.test(typeof x === "string" ? x : x.sql))) {
              closed = true;
              await target.execute({ sql: "UPDATE support_tickets SET status = 'closed' WHERE id = ?", args: [t.id] });
            }
            return target.batch(stmts, mode);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as typeof db;
    const r = await store.addTicketComment(closing, OASIS, t.id, { body: "Late", is_internal: false, author_type: "client", author: { userId: null, name: "Jane" } }, now);
    assert.deepEqual(r, { ok: false, status: 409, error: "ticket_closed" });
    assert.equal(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ? AND author_type = 'client'", args: [t.id] })).rows[0].n), 0);
    assert.equal((await db.execute({ sql: "SELECT status FROM support_tickets WHERE id = ?", args: [t.id] })).rows[0].status, "closed");
  });

  await check("the comment channel is written only when given: a database without migration bravo__200 takes every other comment", async () => {
    const t = (await store.createTicket(db, OASIS, { ...base, id: "44444444-4444-4444-8444-444444444444" }, now)).ticket;
    const plain = await store.addTicketComment(db, OASIS, t.id, { body: "note", is_internal: true, author_type: "team", author: { userId: "u", name: "CC" } }, now);
    assert.equal(plain.ok, true, "no channel column here, and none needed");
    await assert.rejects(
      store.addTicketComment(db, OASIS, t.id, { body: "x", is_internal: false, author_type: "client", author: { userId: null, name: "J" }, channel: "email" }, now),
      /channel/,
    );
  });

  finish("support-inbox-rules");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
