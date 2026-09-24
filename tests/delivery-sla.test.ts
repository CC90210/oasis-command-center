/**
 * delivery-sla.test.ts — ticket numbering under concurrency and the SLA cron.
 * Run: node --conditions=react-server --import tsx tests/delivery-sla.test.ts
 *
 * Against a local libSQL file carrying the real migration 183:
 *   - 25 concurrent creates get 25 distinct, contiguous numbers, and the SQL
 *     formatter agrees with formatTicketNumber;
 *   - the cron flags an unanswered overdue ticket, alerts the founders ONCE,
 *     and a second run alerts nobody;
 *   - an answered, closed or not-yet-due ticket is never flagged;
 *   - downgrading severity clears a stale breach, and a genuine new breach
 *     under the new target alerts again (once);
 *   - a failed alert is recorded on the ticket and fails the run;
 *   - a failed alert is retried on the NEXT pass, on the failed lane only,
 *     exactly once even with overlapping passes, and never for a ticket
 *     answered since;
 *   - a retry whose pass dies before recording its outcome keeps the FAILED
 *     text on the ticket (marked "retrying"), is left alone by an overlapping
 *     pass, and is sent exactly once by the pass after the lease runs out.
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { check, finish, setupDatabase } from "./_delivery-harness";

async function main() {
  const db = await setupDatabase();
  const store = await import("../lib/delivery/store");
  const rules = await import("../lib/delivery/rules");
  const { runSlaCheck } = await import("../lib/delivery/sla-cron");

  const base = {
    description: null, category: "bug" as const, source: "internal" as const, project_id: null,
    client_tenant_id: null, client_name: "C", client_email: "c@example.test", client_company: null,
    client_match: "none", project_hint: null, reporter_user_id: null, assigned_to: null,
  };
  const T0 = new Date("2026-09-24T08:00:00.000Z");

  console.log("delivery-sla:");

  await check("25 concurrent creates: 25 distinct, contiguous ticket numbers", async () => {
    const made = await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.createTicket(db, { ...base, title: `c${i}`, severity: "low" }, T0)),
    );
    const seqs = made.map((m) => m.ticket.ticket_seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 25 }, (_, i) => i + 1));
    for (const m of made) assert.equal(m.ticket.ticket_number, rules.formatTicketNumber(m.ticket.ticket_seq));
    assert.equal(new Set(made.map((m) => m.ticket.ticket_number)).size, 25);
  });
  await check("SQL printf and formatTicketNumber agree past T-9999", async () => {
    const r = await db.execute("SELECT 'T-' || printf('%04d', 12345) AS a, 'T-' || printf('%04d', 7) AS b");
    assert.equal(r.rows[0].a, rules.formatTicketNumber(12345));
    assert.equal(r.rows[0].b, rules.formatTicketNumber(7));
  });

  // Close the concurrency fixtures so they do not breach below.
  await db.execute("UPDATE support_tickets SET status = 'closed'");

  const crit = (await store.createTicket(db, { ...base, title: "critical, unanswered", severity: "critical" }, T0)).ticket;
  const answered = (await store.createTicket(db, { ...base, title: "critical, answered", severity: "critical" }, T0)).ticket;
  await store.addTicketComment(db, answered.id, { body: "On it", is_internal: false, author_type: "team", author: { userId: "u-cc", name: "CC" } }, new Date("2026-09-24T08:30:00.000Z"));
  const noted = (await store.createTicket(db, { ...base, title: "critical, internal note only", severity: "critical" }, T0)).ticket;
  await store.addTicketComment(db, noted.id, { body: "note", is_internal: true, author_type: "team", author: { userId: "u-cc", name: "CC" } }, new Date("2026-09-24T08:30:00.000Z"));
  const low = (await store.createTicket(db, { ...base, title: "low, not due", severity: "low" }, T0)).ticket;
  const closed = (await store.createTicket(db, { ...base, title: "critical, closed", severity: "critical" }, T0)).ticket;
  await store.updateTicket(db, closed.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, T0);

  const sent: string[] = [];
  let emailOk = true;
  const deps = {
    telegram: async (t: string) => {
      sent.push(`tg:${t.split("\n")[0]}`);
      return { ok: true };
    },
    email: async (m: { subject: string }) => {
      sent.push(`mail:${m.subject}`);
      return emailOk ? { ok: true } : { ok: false, reason: "smtp down" };
    },
    founderEmails: ["conaugh@oasisai.work", "adon@oasisai.work"],
    appOrigin: "https://app.test",
  };
  const at = (iso: string) => new Date(iso);
  const col = async (id: string, c: string) =>
    (await db.execute({ sql: `SELECT ${c} AS v FROM support_tickets WHERE id = ?`, args: [id] })).rows[0].v;

  await check("before the target: nothing flagged, nothing sent", async () => {
    const r = await runSlaCheck(db, deps, at("2026-09-24T08:59:00.000Z"));
    assert.equal(r.flagged, 0);
    assert.equal(sent.length, 0);
  });
  await check("past the target: the unanswered tickets are flagged and alerted once each", async () => {
    const r = await runSlaCheck(db, deps, at("2026-09-24T09:05:00.000Z"));
    assert.equal(r.flagged, 2, JSON.stringify(r));
    assert.equal(r.alerted, 2);
    assert.ok(await col(crit.id, "sla_breached_at"));
    assert.ok(await col(noted.id, "sla_breached_at"), "an internal note is not a response");
    assert.equal(await col(answered.id, "sla_breached_at"), null, "a public reply stopped the clock");
    assert.equal(await col(closed.id, "sla_breached_at"), null, "a closed ticket is not watched");
    assert.equal(await col(low.id, "sla_breached_at"), null, "a 72h ticket is not due");
    assert.equal(sent.filter((s) => s.startsWith("tg:")).length, 2);
    assert.equal(sent.filter((s) => s.startsWith("mail:")).length, 2);
    assert.match(sent[0] + sent[1], /SLA BREACHED|SLA breached/);
    assert.equal(await col(crit.id, "sla_breach_alert_status"), "telegram: sent; email: sent");
  });
  await check("the next run alerts nobody: one alert per breach", async () => {
    const before = sent.length;
    const r = await runSlaCheck(db, deps, at("2026-09-24T09:20:00.000Z"));
    assert.equal(r.flagged, 0);
    assert.equal(r.alerted, 0);
    assert.equal(sent.length, before);
  });
  await check("overlapping runs cannot double-alert a breach", async () => {
    const t = (await store.createTicket(db, { ...base, title: "race", severity: "critical" }, at("2026-09-24T09:00:00.000Z"))).ticket;
    const before = sent.length;
    const [a, b] = await Promise.all([
      runSlaCheck(db, deps, at("2026-09-24T10:30:00.000Z")),
      runSlaCheck(db, deps, at("2026-09-24T10:30:00.000Z")),
    ]);
    assert.equal(a.alerted + b.alerted, 1, JSON.stringify({ a, b }));
    assert.equal(sent.length - before, 2, "one telegram + one email");
    await store.updateTicket(db, t.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, at("2026-09-24T10:31:00.000Z"));
  });
  await check("downgrading severity clears a stale breach; a new breach alerts again, once", async () => {
    const r = await store.updateTicket(db, crit.id, { severity: "high" }, { userId: "u-cc", name: "CC" }, at("2026-09-24T09:30:00.000Z"));
    assert.ok(r.ok);
    assert.equal(await col(crit.id, "sla_target"), "2026-09-24T12:00:00.000Z");
    assert.equal(await col(crit.id, "sla_breached_at"), null);
    assert.equal(await col(crit.id, "sla_breach_alert_at"), null);
    const before = sent.length;
    const r1 = await runSlaCheck(db, deps, at("2026-09-24T11:00:00.000Z"));
    assert.equal(r1.alerted, 0, "not due under the new target");
    const r2 = await runSlaCheck(db, deps, at("2026-09-24T12:01:00.000Z"));
    assert.equal(r2.alerted, 1);
    const r3 = await runSlaCheck(db, deps, at("2026-09-24T12:30:00.000Z"));
    assert.equal(r3.alerted, 0);
    assert.equal(sent.length - before, 2);
  });
  await check("a failed alert is recorded on the ticket and fails the run", async () => {
    emailOk = false;
    const t = (await store.createTicket(db, { ...base, title: "mail down", severity: "critical" }, at("2026-09-24T12:00:00.000Z"))).ticket;
    const r = await runSlaCheck(db, deps, at("2026-09-24T13:30:00.000Z"));
    assert.equal(r.alert_failures.length, 1, JSON.stringify(r));
    assert.equal(r.alert_failures[0].ticket_id, t.id);
    assert.match(String(await col(t.id, "sla_breach_alert_status")), /email: FAILED \(smtp down\)/);
    emailOk = true;
  });

  // Retries of a failed breach alert. Close every earlier fixture first so the
  // counts below are this ticket's alone ("mail down" above is one to retry).
  await db.execute("UPDATE support_tickets SET status = 'closed' WHERE status <> 'closed'");
  const lanes = { telegram: true, email: false };
  const lanesSent: string[] = [];
  const flaky = {
    ...deps,
    telegram: async () => {
      lanesSent.push("telegram");
      return lanes.telegram ? { ok: true } : { ok: false, reason: "telegram down" };
    },
    email: async () => {
      lanesSent.push("email");
      return lanes.email ? { ok: true } : { ok: false, reason: "smtp down" };
    },
  };
  await check("a failed breach alert stays eligible, is re-sent next pass on the failed lane only, then never again", async () => {
    const t = (await store.createTicket(db, { ...base, title: "retry me", severity: "critical" }, at("2026-09-24T14:00:00.000Z"))).ticket;
    const p1 = await runSlaCheck(db, flaky, at("2026-09-24T15:05:00.000Z"));
    assert.equal(p1.alerted, 1, JSON.stringify(p1));
    assert.equal(p1.retried, 0, "a pass never retries its own failure");
    assert.deepEqual(lanesSent, ["telegram", "email"]);
    assert.equal(p1.alert_failures.length, 1);
    assert.equal(await col(t.id, "sla_breach_alert_status"), "telegram: sent; email: FAILED (smtp down)");
    assert.ok(await col(t.id, "sla_breach_alert_at"), "the claim is kept; the FAILED status is what makes it eligible");

    lanes.email = true;
    lanesSent.length = 0;
    const p2 = await runSlaCheck(db, flaky, at("2026-09-24T15:20:00.000Z"));
    assert.equal(p2.retried, 1, JSON.stringify(p2));
    assert.equal(p2.alerted, 0);
    assert.deepEqual(p2.alert_failures, []);
    assert.deepEqual(lanesSent, ["email"], "exactly one send: the email; the Telegram they already have is not repeated");
    assert.equal(await col(t.id, "sla_breach_alert_status"), "telegram: sent; email: sent");

    lanesSent.length = 0;
    const p3 = await runSlaCheck(db, flaky, at("2026-09-24T15:35:00.000Z"));
    assert.equal(p3.retried, 0);
    assert.equal(p3.alerted, 0);
    assert.deepEqual(lanesSent, [], "a delivered alert is never sent again");
    await store.updateTicket(db, t.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, at("2026-09-24T15:36:00.000Z"));
  });
  await check("both lanes failed: both are retried, and overlapping passes retry them once", async () => {
    lanes.telegram = false;
    lanes.email = false;
    lanesSent.length = 0;
    const t = (await store.createTicket(db, { ...base, title: "all down", severity: "critical" }, at("2026-09-24T16:00:00.000Z"))).ticket;
    const p1 = await runSlaCheck(db, flaky, at("2026-09-24T17:05:00.000Z"));
    assert.equal(p1.alert_failures.length, 1);
    assert.equal(await col(t.id, "sla_breach_alert_status"), "telegram: FAILED (telegram down); email: FAILED (smtp down)");

    lanes.telegram = true;
    lanes.email = true;
    lanesSent.length = 0;
    const [a, b] = await Promise.all([
      runSlaCheck(db, flaky, at("2026-09-24T17:20:00.000Z")),
      runSlaCheck(db, flaky, at("2026-09-24T17:20:00.000Z")),
    ]);
    assert.equal(a.retried + b.retried, 1, JSON.stringify({ a, b }));
    assert.deepEqual([...lanesSent].sort(), ["email", "telegram"], "one telegram + one email, not two of each");
    assert.equal(await col(t.id, "sla_breach_alert_status"), "telegram: sent; email: sent");
    await store.updateTicket(db, t.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, at("2026-09-24T17:21:00.000Z"));
  });
  await check("a failed breach alert on a ticket answered since is not retried", async () => {
    lanes.email = false;
    lanesSent.length = 0;
    const t = (await store.createTicket(db, { ...base, title: "answered after", severity: "critical" }, at("2026-09-24T18:00:00.000Z"))).ticket;
    await runSlaCheck(db, flaky, at("2026-09-24T19:05:00.000Z"));
    assert.match(String(await col(t.id, "sla_breach_alert_status")), /email: FAILED/);
    await store.addTicketComment(db, t.id, { body: "On it", is_internal: false, author_type: "team", author: { userId: "u-cc", name: "CC" } }, at("2026-09-24T19:10:00.000Z"));
    lanes.email = true;
    lanesSent.length = 0;
    const p2 = await runSlaCheck(db, flaky, at("2026-09-24T19:20:00.000Z"));
    assert.equal(p2.retried, 0);
    assert.deepEqual(lanesSent, []);
    assert.match(String(await col(t.id, "sla_breach_alert_status")), /email: FAILED/, "the failure stays readable on the ticket");
  });
  await check("a retry whose pass dies before recording keeps its FAILED text, and the next pass sends it once", async () => {
    lanes.telegram = true;
    lanes.email = false;
    lanesSent.length = 0;
    const t = (await store.createTicket(db, { ...base, title: "dies mid-retry", severity: "critical" }, at("2026-09-24T20:00:00.000Z"))).ticket;
    await runSlaCheck(db, flaky, at("2026-09-24T21:05:00.000Z"));
    assert.equal(await col(t.id, "sla_breach_alert_status"), "telegram: sent; email: FAILED (smtp down)");

    // Pass 2: the mailbox is still down AND the outcome write fails.
    const outcomeWriteFails = Object.assign(Object.create(db), {
      execute: async (stmt: { sql: string; args?: unknown[] }) => {
        if (stmt.sql.startsWith("UPDATE support_tickets SET sla_breach_alert_status = ?")) throw new Error("transient write failure");
        return db.execute(stmt as never);
      },
    }) as typeof db;
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    lanesSent.length = 0;
    let p2: Awaited<ReturnType<typeof runSlaCheck>>;
    try {
      p2 = await runSlaCheck(outcomeWriteFails, flaky, at("2026-09-24T21:20:00.000Z"));
    } finally {
      console.error = realError;
    }
    assert.equal(p2.retried, 1, JSON.stringify(p2));
    assert.deepEqual(lanesSent, ["email"]);
    assert.deepEqual(p2.alert_failures.map((f) => f.ticket_id), [t.id], "the pass fails loudly, not green");
    assert.match(String(p2.alert_failures[0].error), /transient write failure/);
    assert.ok(logged.some((l) => l.includes("[delivery.sla_cron]") && l.includes(t.id)), logged.join("\n"));
    assert.equal(
      await col(t.id, "sla_breach_alert_status"),
      "retrying; last attempt: telegram: sent; email: FAILED (smtp down)",
      "the failure is still readable, not blanked",
    );

    // An overlapping pass inside the lease leaves the retry in flight alone.
    lanes.email = true;
    lanesSent.length = 0;
    const overlap = await runSlaCheck(db, flaky, at("2026-09-24T21:25:00.000Z"));
    assert.equal(overlap.retried, 0, JSON.stringify(overlap));
    assert.deepEqual(lanesSent, []);

    // Pass 3, the next scheduled one: the lease has run out and the mailbox is back.
    let statusWhileSending: unknown;
    const watching = {
      ...flaky,
      email: async () => {
        statusWhileSending = await col(t.id, "sla_breach_alert_status");
        return flaky.email();
      },
    };
    const p3 = await runSlaCheck(db, watching, at("2026-09-24T21:35:00.000Z"));
    assert.equal(p3.retried, 1, JSON.stringify(p3));
    assert.deepEqual(p3.alert_failures, []);
    assert.deepEqual(lanesSent, ["email"], "exactly one send: the email that never went, not the Telegram again");
    assert.match(String(statusWhileSending), /^retrying; last attempt: .*email: FAILED \(smtp down\)$/, "readable while it sends");
    assert.equal(await col(t.id, "sla_breach_alert_status"), "telegram: sent; email: sent");

    // Pass 4: nothing left to send.
    lanesSent.length = 0;
    const p4 = await runSlaCheck(db, flaky, at("2026-09-24T21:50:00.000Z"));
    assert.equal(p4.retried, 0);
    assert.equal(p4.alerted, 0);
    assert.deepEqual(lanesSent, []);
    await store.updateTicket(db, t.id, { status: "closed" }, { userId: "u-cc", name: "CC" }, at("2026-09-24T21:51:00.000Z"));
  });
  await check("a client reply reopens a resolved ticket; a team reply does not reopen", async () => {
    const t = (await store.createTicket(db, { ...base, title: "reopen", severity: "low" }, T0)).ticket;
    await store.updateTicket(db, t.id, { status: "resolved" }, { userId: "u-cc", name: "CC" }, T0);
    await store.addTicketComment(db, t.id, { body: "thanks", is_internal: false, author_type: "team", author: { userId: "u-cc", name: "CC" } }, T0);
    assert.equal(await col(t.id, "status"), "resolved");
    const c = await store.addTicketComment(db, t.id, { body: "still broken", is_internal: false, author_type: "client", author: { userId: "u-x", name: "X" } }, T0);
    assert.ok(c.ok && c.reopened);
    assert.equal(await col(t.id, "status"), "open");
    assert.equal(await col(t.id, "resolved_at"), null);
  });

  finish("delivery-sla");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
