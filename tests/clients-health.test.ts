/**
 * clients-health.test.ts — a client's health, computed on read.
 * Run: node --conditions=react-server --import tsx tests/clients-health.test.ts
 *
 * health() is pure, so every rule is pinned here with a fixed clock: the
 * levels (healthy, watch, at risk, not enough data, past), each signal's
 * threshold and boundary, and the rule that an UNREAD signal is never counted
 * as fine. Then the signal readers (desk and books) and the at-risk count are
 * driven against a real libSQL file with two workspaces, so one business's
 * breaches and invoices never move another's count.
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_A, CLIENT_B, check, finish, setupDatabase, splitSql } from "./_delivery-harness";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

async function main() {
  const h = await import("../lib/os/customers/health");
  const base = {
    lifecycle: "active" as const,
    createdAt: daysAgo(200),
    now: NOW,
    lastTouch: daysAgo(3) as string | null | undefined,
    slaBreaches30d: 0 as number | null,
    projectsPastDue: 0 as number | null,
    money: { overdueInvoices: 0, failedPayments: 0, cancelAtPeriodEnd: false } as Parameters<typeof h.health>[0]["money"],
  };

  console.log("clients-health:");

  await check("every signal known and fine: healthy, with no reasons", () => {
    const r = h.health(base);
    assert.equal(r.level, "healthy");
    assert.deepEqual(r.reasons, []);
    assert.deepEqual(r.unknown, []);
  });
  await check("a Past client is past, whatever its signals say", () => {
    const r = h.health({ ...base, lifecycle: "churned", slaBreaches30d: 9, money: null });
    assert.equal(r.level, "past");
  });
  await check("money: an overdue invoice, a failed payment or a pending cancellation is at risk, each named", () => {
    const overdue = h.health({ ...base, money: { overdueInvoices: 2, failedPayments: 0, cancelAtPeriodEnd: false } });
    assert.equal(overdue.level, "at_risk");
    assert.match(overdue.reasons.join(" "), /2 invoices are overdue/);
    const failed = h.health({ ...base, money: { overdueInvoices: 0, failedPayments: 1, cancelAtPeriodEnd: false } });
    assert.equal(failed.level, "at_risk");
    assert.match(failed.reasons.join(" "), /1 subscription payment failed/);
    const cancel = h.health({ ...base, money: { overdueInvoices: 0, failedPayments: 0, cancelAtPeriodEnd: true } });
    assert.equal(cancel.level, "at_risk");
    assert.match(cancel.reasons.join(" "), /set to cancel/);
  });
  await check("support: one missed response target is a watch, two are a risk", () => {
    assert.equal(h.health({ ...base, slaBreaches30d: 1 }).level, "watch");
    const two = h.health({ ...base, slaBreaches30d: 2 });
    assert.equal(two.level, "at_risk");
    assert.match(two.reasons.join(" "), /2 tickets missed their response target in 30 days/);
  });
  await check("delivery: a project past due is a watch", () => {
    const r = h.health({ ...base, projectsPastDue: 1 });
    assert.equal(r.level, "watch");
    assert.match(r.reasons.join(" "), /1 project is past due/);
  });
  await check("contact: 21 days is fine, 22 a watch, 46 a risk; with no contact, days since the record was created", () => {
    assert.equal(h.health({ ...base, lastTouch: daysAgo(21) }).level, "healthy");
    assert.equal(h.health({ ...base, lastTouch: daysAgo(22) }).level, "watch");
    const quiet = h.health({ ...base, lastTouch: daysAgo(46) });
    assert.equal(quiet.level, "at_risk");
    assert.match(quiet.reasons.join(" "), /No contact in 46 days/);
    const never = h.health({ ...base, lastTouch: null, createdAt: daysAgo(50) });
    assert.equal(never.level, "at_risk");
    assert.match(never.reasons.join(" "), /No contact recorded since the record was created in 50 days/);
    assert.equal(h.health({ ...base, lastTouch: null, createdAt: daysAgo(5) }).level, "healthy", "a new client is not overdue for contact");
  });
  await check("contact: a paused client is not expected to be in touch", () => {
    assert.equal(h.health({ ...base, lifecycle: "paused", lastTouch: daysAgo(120) }).level, "healthy");
  });
  await check("unknown is never fine: an unread signal with nothing wrong is 'not enough data', and it is listed", () => {
    const money = h.health({ ...base, money: null });
    assert.equal(money.level, "unknown");
    assert.deepEqual(money.unknown, ["payments and invoices"]);
    assert.equal(h.HEALTH_LABELS.unknown, "Not enough data");
    const touch = h.health({ ...base, lastTouch: undefined });
    assert.equal(touch.level, "unknown");
    assert.deepEqual(touch.unknown, ["last contact"]);
    const desk = h.health({ ...base, slaBreaches30d: null, projectsPastDue: null });
    assert.deepEqual(desk.unknown, ["support response times", "project due dates"]);
  });
  await check("a known risk still shows when another signal is unknown, and the unknown stays listed", () => {
    const r = h.health({ ...base, money: null, slaBreaches30d: 3 });
    assert.equal(r.level, "at_risk");
    assert.deepEqual(r.unknown, ["payments and invoices"]);
  });
  await check("a workspace whose books are not in the app is not tracked, not unknown", () => {
    assert.equal(h.health({ ...base, money: "not_tracked" }).level, "healthy");
  });
  await check("risk reasons come first, then the watch reasons", () => {
    const r = h.health({ ...base, projectsPastDue: 1, slaBreaches30d: 2 });
    assert.equal(r.level, "at_risk");
    assert.match(r.reasons[0], /tickets missed/);
    assert.match(r.reasons[1], /past due/);
  });

  // ── the signal readers, against real libSQL ────────────────────────────────
  const db = await setupDatabase();
  for (const f of ["bravo__188_os_customers.sql", "bravo__195_customers_links.sql"]) {
    for (const stmt of splitSql(readFileSync(join(__dirname, "..", "database", "turso", f), "utf8"))) await db.execute(stmt);
  }
  await db.executeMultiple(readFileSync(join(__dirname, "..", "database", "turso", "180_founders_finances.turso.sql"), "utf8"));
  await db.execute("INSERT INTO fin_entities (id, slug, name, kind) VALUES ('fin_ent_oasis', 'oasis', 'OASIS AI Solutions', 'business')");
  const cust = (id: string, tenant: string, name: string, extra: { stripe?: string; email?: string; created?: string } = {}) => ({
    sql: `INSERT INTO customers (id, tenant_id, display_name, primary_email, stripe_customer_id, lifecycle, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    args: [id, tenant, name, extra.email ?? null, extra.stripe ?? null, extra.created ?? daysAgo(100), daysAgo(1)],
  });
  const ticket = (id: string, tenant: string, customer: string, seq: number, breachedAgo: number | null) => ({
    sql: `INSERT INTO support_tickets (id, tenant_id, ticket_seq, ticket_number, title, status, severity, sla_target, sla_breached_at, customer_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 't', 'open', 'high', ?, ?, ?, ?, ?)`,
    args: [id, tenant, seq, `T-${seq}`, daysAgo(40), breachedAgo === null ? null : daysAgo(breachedAgo), customer, daysAgo(40), daysAgo(1)],
  });
  await db.batch(
    [
      cust("c-a1", CLIENT_A, "A One", { stripe: "cus_A1", email: "one@a.test" }),
      cust("c-a2", CLIENT_A, "A Two", { email: "two@a.test" }),
      cust("c-b1", CLIENT_B, "B One", { email: "one@b.test" }),
      ticket("t-a1-1", CLIENT_A, "c-a1", 1, 3),
      ticket("t-a1-2", CLIENT_A, "c-a1", 2, 10),
      ticket("t-a1-old", CLIENT_A, "c-a1", 3, 45), // outside the 30-day window
      ticket("t-b1-1", CLIENT_B, "c-b1", 1, 2),
      ticket("t-b1-2", CLIENT_B, "c-b1", 2, 2),
      {
        sql: `INSERT INTO delivery_projects (id, tenant_id, title, stage, due_date, customer_id, created_at, updated_at)
              VALUES ('p-a2', ?, 'Late build', 'building', ?, 'c-a2', ?, ?)`,
        args: [CLIENT_A, daysAgo(3).slice(0, 10), daysAgo(30), daysAgo(1)],
      },
      {
        sql: `INSERT INTO delivery_projects (id, tenant_id, title, stage, due_date, customer_id, created_at, updated_at)
              VALUES ('p-a2-live', ?, 'Shipped', 'live', ?, 'c-a2', ?, ?)`,
        args: [CLIENT_A, daysAgo(60).slice(0, 10), daysAgo(90), daysAgo(1)],
      },
    ],
    "write",
  );

  await check("desk signals: breaches in the last 30 days and active projects past due, per client, one workspace only", async () => {
    const a = await h.deskSignalsFor(db, CLIENT_A, ["c-a1", "c-a2", "c-b1"], NOW);
    assert.deepEqual(a.get("c-a1"), { slaBreaches30d: 2, projectsPastDue: 0 }, "the 45-day-old breach is outside the window");
    assert.deepEqual(a.get("c-a2"), { slaBreaches30d: 0, projectsPastDue: 1 }, "a live project is not past due");
    assert.deepEqual(a.get("c-b1"), { slaBreaches30d: 0, projectsPastDue: 0 }, "B's breaches are not read through A's desk");
  });

  await db.batch(
    [
      {
        sql: `INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_email, status, currency, monthly_cents, cancel_at_period_end)
              VALUES ('s1', 'fin_ent_oasis', 'cus_A1', '', 'past_due', 'CAD', 10000, 0)`,
        args: [],
      },
      {
        sql: `INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_email, status, currency, monthly_cents, cancel_at_period_end)
              VALUES ('s2', 'fin_ent_oasis', NULL, 'two@a.test', 'active', 'CAD', 5000, 1)`,
        args: [],
      },
      {
        sql: `INSERT INTO fin_contacts (id, entity_id, kind, name, email, stripe_customer_id) VALUES ('fc1', 'fin_ent_oasis', 'customer', 'A One', 'one@a.test', 'cus_A1')`,
        args: [],
      },
      {
        sql: `INSERT INTO fin_invoices (id, entity_id, contact_id, number, status, issue_date, due_date, currency, total_cents, created_by)
              VALUES ('i1', 'fin_ent_oasis', 'fc1', 'INV-1', 'sent', '2026-08-01', '2026-09-01', 'CAD', 50000, 'test')`,
        args: [],
      },
      {
        sql: `INSERT INTO fin_invoices (id, entity_id, contact_id, number, status, issue_date, due_date, currency, total_cents, created_by)
              VALUES ('i2', 'fin_ent_oasis', 'fc1', 'INV-2', 'sent', '2026-09-20', '2026-10-20', 'CAD', 50000, 'test')`,
        args: [],
      },
    ],
    "write",
  );

  await check("money signals: overdue invoices, failed payments and pending cancellations, by Stripe customer or email", async () => {
    const m = await h.moneySignalsFor(
      db,
      [
        { id: "c-a1", stripe_customer_id: "cus_A1", primary_email: "one@a.test" },
        { id: "c-a2", stripe_customer_id: null, primary_email: "two@a.test" },
        { id: "c-b1", stripe_customer_id: null, primary_email: "one@b.test" },
      ],
      "2026-09-30",
    );
    assert.deepEqual(m.get("c-a1"), { overdueInvoices: 1, failedPayments: 1, cancelAtPeriodEnd: false }, "INV-2 is not due yet");
    assert.deepEqual(m.get("c-a2"), { overdueInvoices: 0, failedPayments: 0, cancelAtPeriodEnd: true });
    assert.deepEqual(m.get("c-b1"), { overdueInvoices: 0, failedPayments: 0, cancelAtPeriodEnd: false });
  });
  await check("money signals: a client with neither a Stripe customer nor an email gets NO entry (unknown), never zeros", async () => {
    const m = await h.moneySignalsFor(db, [{ id: "c-unlinked", stripe_customer_id: null, primary_email: null }], "2026-09-30");
    assert.equal(m.has("c-unlinked"), false);
    // Through the at-risk count it is unknown, not fine.
    await db.execute(cust("c-u1", "u0000000-0000-4000-8000-00000000000u", "Unlinked One"));
    const touch = async (list: ReadonlyArray<{ id: string }>) => new Map(list.map((c) => [c.id, daysAgo(2)] as [string, string | null]));
    const r = await h.countAtRiskClients(db, "u0000000-0000-4000-8000-00000000000u", NOW, { money: "read", lastTouch: touch });
    assert.deepEqual(r, { total: 1, atRisk: 0, watch: 0, unknown: 1 });
  });
  await check("'today' is Toronto's day in every reader: at 22:00 Toronto (02:00 UTC next day) a thing due today is not yet late", async () => {
    // 2026-10-01T02:00Z is 2026-09-30 22:00 in Toronto (EDT).
    const late = new Date("2026-10-01T02:00:00.000Z");
    assert.equal(h.torontoDay(late), "2026-09-30");
    const T = "t0000000-0000-4000-8000-00000000000t";
    await db.batch(
      [
        cust("c-t1", T, "Due Today Co", { email: "due-today@t.test" }),
        cust("c-t2", T, "Due Yesterday Co", { email: "due-yesterday@t.test" }),
        {
          sql: `INSERT INTO delivery_projects (id, tenant_id, title, stage, due_date, customer_id, created_at, updated_at)
                VALUES ('p-t1', ?, 'Due today', 'building', '2026-09-30', 'c-t1', ?, ?)`,
          args: [T, daysAgo(30), daysAgo(1)],
        },
        {
          sql: `INSERT INTO delivery_projects (id, tenant_id, title, stage, due_date, customer_id, created_at, updated_at)
                VALUES ('p-t2', ?, 'Due yesterday', 'building', '2026-09-29', 'c-t2', ?, ?)`,
          args: [T, daysAgo(30), daysAgo(1)],
        },
        { sql: "INSERT INTO fin_contacts (id, entity_id, kind, name, email) VALUES ('fc-t1', 'fin_ent_oasis', 'customer', 'Due Today Co', 'due-today@t.test')", args: [] },
        {
          sql: `INSERT INTO fin_invoices (id, entity_id, contact_id, number, status, issue_date, due_date, currency, total_cents, created_by)
                VALUES ('i-t1', 'fin_ent_oasis', 'fc-t1', 'INV-T1', 'sent', '2026-09-01', '2026-09-30', 'CAD', 1000, 'test')`,
          args: [],
        },
      ],
      "write",
    );
    const desk = await h.deskSignalsFor(db, T, ["c-t1", "c-t2"], late);
    assert.equal(desk.get("c-t1")!.projectsPastDue, 0, "due today (Toronto) is not past due");
    assert.equal(desk.get("c-t2")!.projectsPastDue, 1);
    const touch = async (list: ReadonlyArray<{ id: string }>) => new Map(list.map((c) => [c.id, late.toISOString()] as [string, string | null]));
    // c-t1: nothing late (project and invoice both due today) = healthy; c-t2: a project past due = watch.
    assert.deepEqual(await h.countAtRiskClients(db, T, late, { money: "read", lastTouch: touch }), { total: 2, atRisk: 0, watch: 1, unknown: 0 });
  });

  await check("at-risk count for Client Success: this workspace's current clients only, unread signals counted as unknown", async () => {
    const touch = async (list: ReadonlyArray<{ id: string }>) => new Map(list.map((c) => [c.id, daysAgo(2)] as [string, string | null]));
    const withMoney = await h.countAtRiskClients(db, CLIENT_A, NOW, { money: "read", lastTouch: touch });
    assert.deepEqual(withMoney, { total: 2, atRisk: 2, watch: 0, unknown: 0 }, "c-a1: breaches + failed payment; c-a2: cancelling");
    const noMoney = await h.countAtRiskClients(db, CLIENT_A, NOW, { money: "unknown", lastTouch: touch });
    assert.deepEqual(noMoney, { total: 2, atRisk: 1, watch: 1, unknown: 0 }, "c-a1 still at risk on breaches; c-a2 a watch (late project)");
    const b = await h.countAtRiskClients(db, CLIENT_B, NOW, { money: "not_tracked", lastTouch: touch });
    assert.deepEqual(b, { total: 1, atRisk: 1, watch: 0, unknown: 0 }, "B's own two breaches, nothing of A's");
    await db.execute("UPDATE customers SET lifecycle = 'churned' WHERE id = 'c-b1'");
    assert.equal((await h.countAtRiskClients(db, CLIENT_B, NOW, { money: "not_tracked", lastTouch: touch })).total, 0, "a Past client is not counted");
  });

  finish("clients-health");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
