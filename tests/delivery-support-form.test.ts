/**
 * delivery-support-form.test.ts — the Client Support Ticket form.
 * Run: node --conditions=react-server --import tsx tests/delivery-support-form.test.ts
 *
 * Pins, against a local libSQL file carrying the REAL migration 183:
 *   - the form the migration seeds IS lib/delivery/support-form.ts (no drift),
 *     is a valid one-step form, and the seed is idempotent;
 *   - a submission becomes a support ticket and NEVER a lead (no tenant_records
 *     row, no lead_interactions, no drip), matched to the client's project by
 *     email, with the attachment stored under the ticket;
 *   - ticket creation is idempotent on the form submission id, including when
 *     the cron's reconcile sweep re-drives a submission whose request died;
 *   - founders are alerted and the client acknowledged EXACTLY once;
 *   - the per-IP and per-address limits hold in the DATABASE, so a fresh
 *     in-memory bucket (another isolate) or a parallel burst cannot get past
 *     them, a count that fails refuses, and a refused request writes, uploads
 *     and sends nothing;
 *   - an attachment whose bytes are none of the allowed types is never
 *     uploaded and the client's confirmation email says the file was not kept;
 *     a real JPEG sent as .png is kept, stored as a JPEG;
 *   - the real /api/forms/submit route takes the support branch before any of
 *     its lead/drip code, and no other form is routed into it (static guard).
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_A, MIGRATION_PATH, OASIS, check, finish, setupDatabase, splitSql } from "./_delivery-harness";

type Json = Record<string, unknown>;

async function main() {
  const db = await setupDatabase();
  const { NextRequest } = await import("next/server");
  const seed = await import("../lib/delivery/support-form");
  const { parseFormSteps } = await import("../lib/forms/types");
  const intake = await import("../lib/delivery/support-intake");
  const store = await import("../lib/delivery/store");
  const notify = await import("../lib/delivery/notify");

  const count = async (sql: string, args: unknown[] = []) =>
    Number((await db.execute({ sql, args: args as never })).rows[0].n);

  console.log("delivery-support-form:");

  // ── the seed ────────────────────────────────────────────────────────────
  await check("migration 183 seeds exactly the form lib/delivery/support-form.ts declares", async () => {
    const row = (await db.execute({ sql: "SELECT * FROM forms WHERE tenant_id = ? AND slug = 'support'", args: [OASIS] })).rows[0];
    const expected = JSON.parse(JSON.stringify(seed.buildSupportFormRow()));
    assert.equal(row.name, expected.name);
    assert.equal(row.description, expected.description);
    assert.deepEqual(JSON.parse(String(row.steps)), expected.steps);
    assert.deepEqual(JSON.parse(String(row.branding)), expected.branding);
    assert.equal(row.on_complete_stage, null, "no lead, so no stage");
    assert.equal(Number(row.enabled), 1);
  });
  await check("the seeded form is a valid ONE-step form with the spec's fields", async () => {
    const row = (await db.execute({ sql: "SELECT steps FROM forms WHERE slug = 'support'", args: [] })).rows[0];
    const steps = parseFormSteps(JSON.parse(String(row.steps)));
    assert.equal(steps.length, 1);
    const names = steps[0].fields.map((f) => f.name);
    assert.deepEqual(names, ["name", "email", "company", "project", "category", "priority", "description", "attachment"]);
    assert.deepEqual(steps[0].fields.find((f) => f.name === "category")?.options?.map((o) => o.value), ["bug", "change_request", "question", "billing", "other"]);
    assert.deepEqual(steps[0].fields.find((f) => f.name === "priority")?.options?.map((o) => o.value), ["low", "medium", "high", "critical"]);
    assert.equal(seed.SUPPORT_FORM_PATH, "/f/oasis-ai-cc/support");
  });
  await check("re-running the migration's statements does not duplicate the form", async () => {
    for (const stmt of splitSql(readFileSync(MIGRATION_PATH, "utf8"))) await db.execute(stmt);
    assert.equal(await count("SELECT count(*) AS n FROM forms WHERE slug = 'support'"), 1);
  });

  // ── fixtures: a client project to match against ─────────────────────────
  const now = new Date("2026-09-24T12:00:00.000Z");
  const founder = { userId: "u-cc", name: "CC" };
  const projectA = await store.createProject(db, {
    title: "Client A website", description: null, client_tenant_id: CLIENT_A, client_name: "Alice",
    client_email: "owner@client-a.test", lead_id: null, stage: "live", priority: "medium", assigned_to: null, due_date: null,
  }, founder, now);

  const sent: Array<{ kind: string; to?: string; subject?: string; body: string }> = [];
  const fakeNotify = {
    telegram: async (text: string) => {
      sent.push({ kind: "telegram", body: text });
      return { ok: true };
    },
    email: async (m: { to: string; cc?: string[]; subject: string; body: string }) => {
      sent.push({ kind: "email", to: m.to, subject: m.subject, body: m.body });
      return { ok: true };
    },
    founderEmails: ["conaugh@oasisai.work", "adon@oasisai.work"],
    appOrigin: "https://app.test",
  };
  const uploads: Array<{ path: string; bytes: number; type: string }> = [];
  const pending: Array<() => Promise<void>> = [];
  const deps = {
    db,
    now: () => now,
    notify: fakeNotify,
    schedule: (task: () => Promise<void>) => void pending.push(task),
    upload: async (path: string, bytes: Buffer, type: string) => {
      uploads.push({ path, bytes: bytes.length, type });
      return { ok: true as const };
    },
  };
  let ipCounter = 0;
  const submit = (payload: Json, extra: Json = {}) => {
    ipCounter += 1;
    return intake.handleSupportFormSubmission(
      new NextRequest("http://localhost/api/forms/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${ipCounter}` },
      }),
      { step_index: 0, payload, anonymous_init: { tenant_slug: "oasis-ai-cc", form_slug: "support" }, ...extra },
      deps,
    );
  };
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

  // ── a submission becomes a ticket, never a lead ─────────────────────────
  const leadsBefore = await count("SELECT count(*) AS n FROM tenant_records");
  const res = await submit({
    name: "Alice Client", email: "Owner@Client-A.test", company: "Client A Plumbing", project: "",
    category: "bug", priority: "high", description: "The booking widget shows a blank page.\nSince Monday.",
    attachment: { inline_base64: png, filename: "screen shot.png", mime_type: "image/png", size_bytes: 16 },
  });
  const body = (await res.json()) as Json;
  const ticketRow = (await db.execute({ sql: "SELECT * FROM support_tickets WHERE ticket_number = ?", args: [String(body.ticket_number)] })).rows[0];

  await check("a valid submission answers like any form (next_step null) and names the ticket", async () => {
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.equal(body.next_step, null);
    assert.equal(body.minted_token, null, "no lead token is ever minted");
    assert.match(String(body.ticket_number), /^T-\d{4}$/);
  });
  await check("the ticket is a FORM ticket matched to the client's project by email", async () => {
    assert.ok(ticketRow);
    assert.equal(ticketRow.source, "form");
    assert.equal(ticketRow.tenant_id, OASIS);
    assert.equal(ticketRow.project_id, projectA);
    assert.equal(ticketRow.client_tenant_id, CLIENT_A);
    assert.equal(ticketRow.client_match, "email_project");
    assert.equal(ticketRow.client_email, "owner@client-a.test");
    assert.equal(ticketRow.severity, "high");
    assert.equal(ticketRow.title, "Bug: The booking widget shows a blank page.");
    assert.equal(ticketRow.sla_target, "2026-09-24T16:00:00.000Z", "high = 4h first response");
  });
  await check("an email-inferred link stays founder-only until a founder confirms it", async () => {
    // The public form's email is unverified: anyone who knows a client's address
    // could otherwise put text into that client's portal.
    const client = { kind: "client" as const, userId: "u-client-a", clientTenantId: CLIENT_A, canAct: true };
    const founder = { kind: "founder" as const, userId: "u-cc", canAct: true };
    const id = String(ticketRow.id);
    assert.equal(await store.getTicket(db, client, id), null, "client must not see an unconfirmed inferred ticket");
    assert.ok(await store.getTicket(db, founder, id), "founders always see it");
    const confirmed = await store.updateTicket(db, id, { confirm_client_link: true }, { userId: "u-cc", name: "CC" }, new Date("2026-09-24T12:05:00.000Z"));
    assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
    assert.ok(await store.getTicket(db, client, id), "after confirmation the client sees their ticket");
    const again = await store.updateTicket(db, id, { confirm_client_link: true }, { userId: "u-cc", name: "CC" }, new Date("2026-09-24T12:06:00.000Z"));
    assert.equal(again.ok, false, "confirming a link that is no longer inferred is refused");
  });
  await check("NO lead: tenant_records and lead_interactions are untouched", async () => {
    assert.equal(await count("SELECT count(*) AS n FROM tenant_records"), leadsBefore);
    assert.equal(await count("SELECT count(*) AS n FROM lead_interactions"), 0);
  });
  await check("the submission is recorded with a ticket reference, never a lead id", async () => {
    const sub = (await db.execute({ sql: "SELECT * FROM form_submissions WHERE id = ?", args: [String(body.submission_id)] })).rows[0];
    assert.equal(sub.lead_id, `ticket:${ticketRow.id}`);
    assert.equal(ticketRow.form_submission_id, sub.id);
    assert.equal(String(sub.payload).includes("inline_base64"), false, "raw file bytes must not be persisted");
  });
  await check("the attachment is stored privately under the ticket, not a lead", async () => {
    assert.equal(uploads.length, 1);
    assert.match(uploads[0].path, new RegExp(`^${OASIS}/${String(ticketRow.id)}/\\d+_screen_shot\\.png$`));
    const att = JSON.parse(String(ticketRow.attachments));
    assert.equal(att[0].storage_path, uploads[0].path);
    assert.equal(att[0].mime_type, "image/png");
  });
  await check("notifications run only after the response, and exactly once", async () => {
    assert.equal(sent.length, 0, "nothing is sent before the scheduled task runs");
    assert.equal(pending.length, 1);
    await pending.shift()!();
    const tg = sent.filter((s) => s.kind === "telegram");
    const mails = sent.filter((s) => s.kind === "email");
    assert.equal(tg.length, 1);
    assert.equal(mails.length, 2, "one to the founders, one to the client");
    const toClient = mails.find((m) => m.to === "owner@client-a.test")!;
    assert.match(String(toClient.subject), new RegExp(String(body.ticket_number)));
    assert.equal(toClient.body.includes("booking widget"), false, "the ack never echoes the description");
    const toFounders = mails.find((m) => m.to === "conaugh@oasisai.work")!;
    assert.match(toFounders.body, /booking widget/);
    assert.match(toFounders.body, /https:\/\/app\.test\/tickets\//);
    // A second run — a duplicate after(), the cron's retry — sends nothing.
    await notify.runIntakeNotifications(db, String(ticketRow.id), fakeNotify, now);
    assert.equal(sent.length, 3);
    const after = (await db.execute({ sql: "SELECT founder_alert_status, client_ack_status FROM support_tickets WHERE id = ?", args: [String(ticketRow.id)] })).rows[0];
    assert.equal(after.founder_alert_status, "telegram: sent; email: sent");
    assert.equal(after.client_ack_status, "email: sent");
  });

  // ── validation ──────────────────────────────────────────────────────────
  await check("missing description / bad email: 400 naming the field, nothing written", async () => {
    const before = await count("SELECT count(*) AS n FROM support_tickets");
    const a = await submit({ name: "X", email: "x@y.co", category: "bug", priority: "low" });
    const aj = (await a.json()) as Json;
    assert.equal(a.status, 400);
    assert.equal(aj.error, "missing_required_field");
    assert.equal(aj.field, "description");
    const b = await submit({ name: "X", email: "not-an-email", category: "bug", priority: "low", description: "d" });
    const bj = (await b.json()) as Json;
    assert.equal(b.status, 400);
    assert.equal(bj.field, "email");
    assert.match(String(bj.message), /valid email/);
    assert.equal(await count("SELECT count(*) AS n FROM support_tickets"), before);
  });
  await check("only step 0 is accepted", async () => {
    const r = await submit({ name: "X", email: "x@y.co", description: "d" }, { step_index: 1 });
    assert.equal(r.status, 400);
  });
  await check("a disallowed attachment type keeps the ticket and records the refusal", async () => {
    const r = await submit({
      name: "Eve", email: "eve@elsewhere.test", category: "question", priority: "low", description: "Question about invoices",
      attachment: { inline_base64: png, filename: "run.exe", mime_type: "application/x-msdownload", size_bytes: 16 },
    });
    const j = (await r.json()) as Json;
    assert.equal(r.status, 200, JSON.stringify(j));
    const row = (await db.execute({ sql: "SELECT attachments, client_match, project_id FROM support_tickets WHERE ticket_number = ?", args: [String(j.ticket_number)] })).rows[0];
    const att = JSON.parse(String(row.attachments));
    assert.equal(att[0].storage_path, null);
    assert.match(att[0].error, /not allowed/);
    assert.equal(row.client_match, "none", "an unknown email links to nothing");
    assert.equal(row.project_id, null);
    pending.length = 0;
  });

  // ── client matching beyond projects ─────────────────────────────────────
  await check("a client-workspace user with no project email is linked to their workspace", async () => {
    const r = await submit({ name: "Bob", email: "owner@client-b.test", category: "question", priority: "low", description: "Where is my invoice?" });
    const j = (await r.json()) as Json;
    assert.equal(r.status, 200, JSON.stringify(j));
    const row = (await db.execute({ sql: "SELECT client_tenant_id, client_match, project_id FROM support_tickets WHERE ticket_number = ?", args: [String(j.ticket_number)] })).rows[0];
    assert.equal(row.client_tenant_id, "bbbbbbbb-0000-4000-8000-00000000000b");
    assert.equal(row.client_match, "email_tenant");
    assert.equal(row.project_id, null);
  });
  await check("a founder testing the form is never filed into a client's portal", async () => {
    // CC also holds a profile in client A's workspace (founders operate client workspaces).
    await db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, joined_at)
            VALUES ('p-cc-in-a', ?, 'conaugh@oasisai.work', ?, 'admin', 0, '2026-09-01T00:00:00Z')`,
      args: ["0d000000-0000-4000-8000-000000000001", CLIENT_A],
    });
    const r = await submit({ name: "CC", email: "conaugh@oasisai.work", category: "other", priority: "low", description: "test ticket" });
    const j = (await r.json()) as Json;
    const row = (await db.execute({ sql: "SELECT client_tenant_id, client_match FROM support_tickets WHERE ticket_number = ?", args: [String(j.ticket_number)] })).rows[0];
    assert.equal(row.client_tenant_id, null);
    assert.equal(row.client_match, "none");
  });
  pending.length = 0;

  // ── idempotency on the form submission id ───────────────────────────────
  await check("createTicket twice for one submission returns the same ticket", async () => {
    const input = {
      title: "Dup", description: "d", category: "bug" as const, severity: "low" as const, source: "form" as const,
      project_id: null, client_tenant_id: null, client_name: "D", client_email: "d@d.co", client_company: null,
      client_match: "none", project_hint: null, reporter_user_id: null, assigned_to: null, form_submission_id: "sub-dup-1",
    };
    const [a, b] = await Promise.all([store.createTicket(db, input, now), store.createTicket(db, input, now)]);
    const c = await store.createTicket(db, input, now);
    assert.equal(a.ticket.id, b.ticket.id);
    assert.equal(a.ticket.id, c.ticket.id);
    assert.equal([a.created, b.created, c.created].filter(Boolean).length, 1);
    assert.equal(await count("SELECT count(*) AS n FROM support_tickets WHERE form_submission_id = 'sub-dup-1'"), 1);
  });
  await check("the reconcile sweep turns an orphaned submission into its ticket, once", async () => {
    const formId = String((await db.execute({ sql: "SELECT id FROM forms WHERE slug = 'support'", args: [] })).rows[0].id);
    const orphanTicketId = "11111111-2222-4333-8444-555555555555";
    await db.execute({
      sql: `INSERT INTO form_submissions (id, form_id, tenant_id, lead_id, step_index, payload, submitted_at)
            VALUES ('sub-orphan', ?, ?, ?, 0, ?, '2026-09-24T11:50:00.000Z')`,
      args: [formId, OASIS, `ticket:${orphanTicketId}`, JSON.stringify({
        name: "Late Larry", email: "owner@client-a.test", category: "change_request", priority: "medium", description: "Please change the hero image",
      })],
    });
    sent.length = 0;
    const r1 = await intake.reconcileSupportIntake(db, fakeNotify, now);
    assert.equal(r1.ticketsCreated.length, 1, JSON.stringify(r1));
    const t = (await db.execute({ sql: "SELECT * FROM support_tickets WHERE form_submission_id = 'sub-orphan'", args: [] })).rows[0];
    assert.equal(t.id, orphanTicketId, "the ticket gets the id its submission recorded");
    assert.equal(t.created_at, "2026-09-24T11:50:00.000Z", "the SLA clock starts at submission, not at recovery");
    assert.equal(t.project_id, projectA);
    assert.ok(sent.some((s) => s.kind === "email" && s.to === "owner@client-a.test"), "the late ticket still acknowledges the client");
    const before = sent.length;
    const r2 = await intake.reconcileSupportIntake(db, fakeNotify, now);
    assert.equal(r2.ticketsCreated.length, 0);
    assert.equal(sent.length, before, "a second sweep sends nothing");
    assert.equal(await count("SELECT count(*) AS n FROM support_tickets WHERE form_submission_id = 'sub-orphan'"), 1);
  });

  // ── the durable rate limit ──────────────────────────────────────────────
  // rateLimit() is an in-memory bucket per isolate. Every request below is made
  // as if it landed on a FRESH isolate: Date.now() (the bucket's clock) jumps an
  // hour so every bucket has refilled, while the intake's own clock (deps.now)
  // stays inside the window. Only the database can refuse these.
  const realDateNow = Date.now;
  let hops = 0;
  const hopIsolate = () => {
    hops += 1;
    const offset = hops * 3_600_000;
    Date.now = () => realDateNow() + offset;
  };
  let clock = new Date("2026-09-24T13:00:00.000Z");
  const scheduled: Array<() => Promise<void>> = [];
  const stored: string[] = [];
  const storedTypes: string[] = [];
  const limitDeps = {
    db,
    now: () => clock,
    notify: fakeNotify,
    schedule: (task: () => Promise<void>) => void scheduled.push(task),
    upload: async (path: string, _bytes: Buffer, type: string) => {
      stored.push(path);
      storedTypes.push(type);
      return { ok: true as const };
    },
  };
  const requestFrom = (ip: string, payload: Json) => ({
    req: new NextRequest("http://localhost/api/forms/submit", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
    }),
    body: { step_index: 0, payload, anonymous_init: { tenant_slug: "oasis-ai-cc", form_slug: "support" } },
  });
  const submitFrom = async (ip: string, payload: Json, db2 = db) => {
    hopIsolate();
    try {
      const { req, body } = requestFrom(ip, payload);
      return await intake.handleSupportFormSubmission(req, body, { ...limitDeps, db: db2 });
    } finally {
      Date.now = realDateNow;
    }
  };
  const ticketPayload = (email: string, i: number): Json => ({
    name: "Rate Tester", email, category: "question", priority: "low", description: `attempt ${i}`,
    attachment: { inline_base64: png, filename: "s.png", mime_type: "image/png", size_bytes: 16 },
  });
  const footprint = async () => ({
    submissions: await count("SELECT count(*) AS n FROM form_submissions"),
    tickets: await count("SELECT count(*) AS n FROM support_tickets"),
    uploads: stored.length,
    scheduled: scheduled.length,
    sent: sent.length,
  });
  const at = (base: string, plusMs: number) => new Date(Date.parse(base) + plusMs);

  await check("the 6th submission from one IP inside a minute is refused, even on a fresh isolate", async () => {
    for (let i = 0; i < 5; i++) {
      clock = at("2026-09-24T13:00:00.000Z", i * 5_000);
      const r = await submitFrom("203.0.113.7", ticketPayload(`ip-flood-${i}@example.test`, i));
      assert.equal(r.status, 200, JSON.stringify(await r.json()));
    }
    const before = await footprint();
    clock = at("2026-09-24T13:00:00.000Z", 50_000);
    const r6 = await submitFrom("203.0.113.7", ticketPayload("ip-flood-5@example.test", 5));
    const j6 = (await r6.json()) as Json;
    assert.equal(r6.status, 429, JSON.stringify(j6));
    assert.equal(j6.error, "rate_limited");
    assert.equal(j6.retry_in_sec, 60);
    assert.match(String(j6.message), /wait a minute/, "the form shows this sentence, not its fixed 'a few seconds' copy");
    assert.deepEqual(await footprint(), before, "a refused request writes, uploads, schedules and sends nothing");
    // The window slides: once the first of the five is a minute old, one more is let in.
    clock = at("2026-09-24T13:00:00.000Z", 61_000);
    const r7 = await submitFrom("203.0.113.7", ticketPayload("ip-flood-6@example.test", 6));
    assert.equal(r7.status, 200, JSON.stringify(await r7.json()));
  });
  await check("the submission records the normalised address and the upload's real outcome", async () => {
    const row = (await db.execute({
      sql: "SELECT payload FROM form_submissions WHERE ip_address = '203.0.113.7' ORDER BY submitted_at LIMIT 1",
      args: [],
    })).rows[0];
    const p = JSON.parse(String(row.payload)) as { email: string; attachment: Array<{ storage_path: string | null; error?: string }> };
    assert.equal(p.email, "ip-flood-0@example.test");
    assert.equal(p.attachment[0].storage_path, stored[0], "not left saying 'upload did not finish'");
    assert.equal(p.attachment[0].error, undefined);
  });
  await check("the 4th submission to one address inside 10 minutes is refused, from any IP, however it is typed", async () => {
    const typed = ["victim@example.test", "  Victim@Example.TEST ", "victim@example.test"];
    for (let i = 0; i < 3; i++) {
      clock = at("2026-09-24T14:00:00.000Z", i * 60_000);
      const r = await submitFrom(`198.51.100.${i + 1}`, ticketPayload(typed[i], i));
      assert.equal(r.status, 200, JSON.stringify(await r.json()));
    }
    const before = await footprint();
    clock = at("2026-09-24T14:00:00.000Z", 9 * 60_000);
    const r4 = await submitFrom("198.51.100.99", ticketPayload("VICTIM@example.test", 3));
    const j4 = (await r4.json()) as Json;
    assert.equal(r4.status, 429, JSON.stringify(j4));
    assert.equal(j4.error, "rate_limited");
    assert.equal(j4.retry_in_sec, 600);
    assert.match(String(j4.message), /this email address in the last 10 minutes/);
    assert.deepEqual(await footprint(), before, "a refused request writes, uploads, schedules and sends nothing");
  });
  await check("the INSERT counts again: a request whose count went stale is still refused", async () => {
    // Stands in for a parallel request that passed the count before the fifth
    // row landed: the count says zero, the INSERT sees the truth.
    for (let i = 0; i < 5; i++) {
      clock = at("2026-09-24T15:00:00.000Z", i * 1_000);
      const r = await submitFrom("203.0.113.8", ticketPayload(`stale-${i}@example.test`, i));
      assert.equal(r.status, 200, JSON.stringify(await r.json()));
    }
    const staleCount = Object.assign(Object.create(db), {
      execute: async (stmt: { sql: string; args?: unknown[] }) =>
        stmt.sql.startsWith("SELECT (SELECT count(*) FROM form_submissions")
          ? { rows: [{ ip: 0, email: 0 }], rowsAffected: 0 }
          : db.execute(stmt as never),
    }) as typeof db;
    const before = await footprint();
    clock = at("2026-09-24T15:00:00.000Z", 10_000);
    const r = await submitFrom("203.0.113.8", ticketPayload("stale-5@example.test", 5), staleCount);
    assert.equal(r.status, 429, JSON.stringify(await r.json()));
    assert.deepEqual(await footprint(), before);
  });
  await check("parallel requests from one IP on fresh isolates: exactly five get in", async () => {
    clock = new Date("2026-09-24T16:00:00.000Z");
    const racers: Array<Promise<Response>> = [];
    try {
      for (let i = 0; i < 8; i++) {
        hopIsolate(); // the IP bucket is read synchronously, as the call starts
        const { req, body } = requestFrom("203.0.113.9", ticketPayload(`race-${i}@example.test`, i));
        racers.push(intake.handleSupportFormSubmission(req, body, limitDeps));
      }
      const statuses = (await Promise.all(racers)).map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
    } finally {
      Date.now = realDateNow;
    }
    assert.equal(await count("SELECT count(*) AS n FROM form_submissions WHERE ip_address = '203.0.113.9'"), 5);
  });
  await check("a count that cannot run refuses (429, plain English), logs a tag, writes nothing", async () => {
    const broken = Object.assign(Object.create(db), {
      execute: async (stmt: { sql: string; args?: unknown[] }) => {
        if (stmt.sql.startsWith("SELECT (SELECT count(*) FROM form_submissions")) throw new Error("simulated libSQL outage");
        return db.execute(stmt as never);
      },
    }) as typeof db;
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    const before = await footprint();
    clock = new Date("2026-09-24T17:00:00.000Z");
    let r: Response;
    try {
      r = await submitFrom("203.0.113.10", ticketPayload("outage@example.test", 0), broken);
    } finally {
      console.error = realError;
    }
    const j = (await r.json()) as Json;
    assert.equal(r.status, 429, JSON.stringify(j));
    assert.equal(j.error, "rate_limited");
    assert.match(String(j.message), /try again/);
    assert.ok(logged.some((l) => l.includes("[support-intake.rate_limit]") && l.includes("simulated libSQL outage")), logged.join("\n"));
    assert.deepEqual(await footprint(), before);
  });

  // ── attachment bytes ────────────────────────────────────────────────────
  const ackTo = (to: string) => sent.filter((s) => s.kind === "email" && s.to === to);
  await check("an attachment whose bytes are no allowed type is refused before upload; the ticket stands and the client is told", async () => {
    clock = new Date("2026-09-24T18:00:00.000Z");
    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    const uploadsBefore = stored.length;
    scheduled.length = 0;
    const r = await submitFrom("192.0.2.50", {
      ...ticketPayload("mime@example.test", 0),
      attachment: { inline_base64: html, filename: "shot.png", mime_type: "image/png", size_bytes: 38 },
    });
    const j = (await r.json()) as Json & { uploads: { warnings: unknown[] } };
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(stored.length, uploadsBefore, "nothing was uploaded");
    assert.match(JSON.stringify(j.uploads.warnings), /content_mismatch: image\/png/);
    const row = (await db.execute({ sql: "SELECT attachments FROM support_tickets WHERE ticket_number = ?", args: [String(j.ticket_number)] })).rows[0];
    const att = JSON.parse(String(row.attachments));
    assert.equal(att[0].storage_path, null);
    assert.equal(att[0].error, "file is not a PDF, PNG, JPEG or WebP");
    // The form's thank-you screen cannot show a refused file; the confirmation email does.
    assert.equal(scheduled.length, 1);
    await scheduled.shift()!();
    const acks = ackTo("mime@example.test");
    assert.equal(acks.length, 1);
    assert.match(acks[0].body, /We could not keep the file you attached\. We accept PDF, PNG, JPEG or WebP files up to 10 MB/);
    // That sentence (like the form's help text) spells the limits out; it must move with them.
    assert.equal(seed.SUPPORT_ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
    assert.deepEqual(seed.SUPPORT_ATTACHMENT_MIME, ["application/pdf", "image/png", "image/jpeg", "image/webp"]);
    assert.equal(acks[0].body.includes("shot.png"), false, "the sender-typed file name is never echoed");
  });
  await check("a real JPEG sent as image/png is kept and stored as what its bytes are", async () => {
    clock = new Date("2026-09-24T18:30:00.000Z");
    const jpeg = Buffer.from("ffd8ffe000104a464946", "hex").toString("base64");
    const uploadsBefore = stored.length;
    scheduled.length = 0;
    const r = await submitFrom("192.0.2.51", {
      ...ticketPayload("jpeg@example.test", 0),
      attachment: { inline_base64: jpeg, filename: "screenshot.png", mime_type: "image/png", size_bytes: 10 },
    });
    const j = (await r.json()) as Json & { uploads: { attempted: number; succeeded: number; warnings: unknown[] } };
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.deepEqual(j.uploads, { attempted: 1, succeeded: 1, warnings: [] });
    assert.equal(stored.length, uploadsBefore + 1);
    assert.equal(storedTypes[storedTypes.length - 1], "image/jpeg", "stored, and so served, as a JPEG");
    const row = (await db.execute({ sql: "SELECT attachments FROM support_tickets WHERE ticket_number = ?", args: [String(j.ticket_number)] })).rows[0];
    const att = JSON.parse(String(row.attachments));
    assert.equal(att[0].mime_type, "image/jpeg");
    assert.equal(att[0].storage_path, stored[stored.length - 1]);
    assert.equal(att[0].error, undefined);
    await scheduled.shift()!();
    const acks = ackTo("jpeg@example.test");
    assert.equal(acks.length, 1);
    assert.equal(acks[0].body.includes("could not keep the file"), false, "a kept file needs no warning");
  });
  await check("every allowed type has a signature: its own bytes pass, every other type's fail", () => {
    const samples: Record<string, Buffer> = {
      "application/pdf": Buffer.from("%PDF-1.7\n%\xe2\xe3\n", "latin1"),
      "image/png": Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
      "image/jpeg": Buffer.from("ffd8ffe000104a464946", "hex"),
      "image/webp": Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]),
    };
    assert.deepEqual(Object.keys(samples).sort(), [...seed.SUPPORT_ATTACHMENT_MIME].sort(), "a sample per allowed type");
    for (const [type, bytes] of Object.entries(samples)) {
      for (const declared of seed.SUPPORT_ATTACHMENT_MIME) {
        assert.equal(seed.attachmentBytesMatchType(bytes, declared), declared === type, `${type} bytes declared as ${declared}`);
      }
    }
    assert.equal(seed.attachmentBytesMatchType(Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"), "image/webp"), false, "RIFF is not enough");
    assert.equal(seed.attachmentBytesMatchType(Buffer.alloc(0), "image/png"), false);
    assert.equal(seed.attachmentBytesMatchType(Buffer.from("89504e470d0a1a0a", "hex"), "image/gif"), false, "an unlisted type is never waved through");
    for (const [type, bytes] of Object.entries(samples)) assert.equal(seed.sniffAttachmentType(bytes), type);
    assert.equal(seed.sniffAttachmentType(Buffer.from("GIF89a", "latin1")), null, "a real but unlisted type is none of them");
    assert.equal(seed.sniffAttachmentType(Buffer.from("<html>", "latin1")), null);
  });

  // ── misconfiguration fails loudly ───────────────────────────────────────
  await check("a disabled form is not_found; a multi-step edit is refused loudly", async () => {
    await db.execute({ sql: "UPDATE forms SET enabled = 0 WHERE slug = 'support'", args: [] });
    const off = await submit({ name: "X", email: "x@y.co", description: "d" });
    assert.equal(off.status, 404);
    const two = JSON.stringify([...seed.SUPPORT_FORM_STEPS, { ...seed.SUPPORT_FORM_STEPS[0], key: "more" }]);
    await db.execute({ sql: "UPDATE forms SET enabled = 1, steps = ? WHERE slug = 'support'", args: [two] });
    const multi = await submit({ name: "X", email: "x@y.co", description: "d" });
    assert.equal(multi.status, 500);
    assert.equal(((await multi.json()) as Json).error, "form_definition_corrupt");
    await db.execute({ sql: "UPDATE forms SET steps = ? WHERE slug = 'support'", args: [JSON.stringify(seed.SUPPORT_FORM_STEPS)] });
  });

  // ── the gate ────────────────────────────────────────────────────────────
  await check("only an anonymous oasis-ai-cc/support body takes the support branch", () => {
    const yes = { anonymous_init: { tenant_slug: "OASIS-AI-CC", form_slug: " Support " } };
    assert.equal(intake.isSupportFormSubmission(yes), true);
    assert.equal(intake.isSupportFormSubmission({ ...yes, token: "t" }), false, "a token body never does");
    assert.equal(intake.isSupportFormSubmission({ anonymous_init: { tenant_slug: "oasis-ai-cc", form_slug: "start" } }), false);
    assert.equal(intake.isSupportFormSubmission({ anonymous_init: { tenant_slug: "submissions", form_slug: "support" } }), false);
    assert.equal(intake.isSupportFormSubmission({ anonymous_init: { tenant_slug: "sun", form_slug: "support" } }), false);
    assert.equal(intake.isSupportFormSubmission(null), false);
    assert.equal(intake.isSupportFormSubmission({ token: "x" }), false);
  });

  const routeSource = readFileSync(join(__dirname, "..", "app", "api", "forms", "submit", "route.ts"), "utf8");
  await check("static guard: the support branch returns before ANY lead, upload, stage or drip code", () => {
    const start = routeSource.indexOf("async function handleSubmit(");
    assert.ok(start > 0);
    const handler = routeSource.slice(start);
    const branch = handler.search(/if \(isSupportFormSubmission\(body\)\) \{\s*return handleSupportFormSubmission\(req, body\);\s*\}/);
    assert.ok(branch > 0, "the branch must be `if (isSupportFormSubmission(body)) { return handleSupportFormSubmission(req, body); }`");
    for (const marker of [
      "verifyFormLink(",
      "initAnonymousLead(",
      "rateLimit(",
      '.from("form_submissions")',
      "uploadLeadDocument(",
      "registerLeadDocument(",
      "dispatchLeadStageEvent(",
      "updateRecord(",
      "createRecord(",
      "maybeQueueResumeEmail(",
      "notifyOasisFunnelSubmission(",
      "notifyAiAuditStarted(",
      "sendSunbizLeadEvent(",
      "sendFormCompletionEmail(",
    ]) {
      const at = handler.indexOf(marker);
      if (at >= 0) assert.ok(branch < at, `the support branch must come before ${marker}`);
    }
    // It is the very first statement: nothing but whitespace and comments precede it.
    const beforeBranch = handler.slice(handler.indexOf("{") + 1, branch).replace(/\/\/[^\n]*/g, "").trim();
    assert.equal(beforeBranch, "", "no statement may run before the support branch");
  });
  await check("static guard: the route change is the one import and the one branch", () => {
    assert.equal((routeSource.match(/isSupportFormSubmission/g) || []).length, 2);
    assert.equal((routeSource.match(/handleSupportFormSubmission/g) || []).length, 2);
    assert.equal((routeSource.match(/@\/lib\/delivery\//g) || []).length, 1);
  });

  // ── the real route, end to end ──────────────────────────────────────────
  await check("POST /api/forms/submit with the support form creates a ticket and no lead", async () => {
    const route = await import("../app/api/forms/submit/route");
    const leads = await count("SELECT count(*) AS n FROM tenant_records");
    const tickets = await count("SELECT count(*) AS n FROM support_tickets");
    const r = await route.POST(
      new NextRequest("http://localhost/api/forms/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9" },
        body: JSON.stringify({
          step_index: 0,
          anonymous_init: { tenant_slug: "oasis-ai-cc", form_slug: "support" },
          payload: { name: "Route Rita", email: "rita@example.test", category: "other", priority: "low", description: "Through the real route" },
        }),
      }),
    );
    const j = (await r.json()) as Json;
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.match(String(j.ticket_number), /^T-\d{4}$/);
    assert.equal(await count("SELECT count(*) AS n FROM support_tickets"), tickets + 1);
    assert.equal(await count("SELECT count(*) AS n FROM tenant_records"), leads, "the real route created a lead");
  });

  finish("delivery-support-form");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
