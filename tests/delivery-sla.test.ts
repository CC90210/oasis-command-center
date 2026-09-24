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
 *   - a failed alert is recorded on the ticket and fails the run.
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
