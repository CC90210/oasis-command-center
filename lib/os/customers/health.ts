/**
 * lib/os/customers/health.ts — how a client is doing, computed on read.
 *
 * health() is PURE (tests/clients-health.test.ts pins every rule). The loaders
 * below it read the signals it needs with raw SQL on a libSQL client the
 * caller passes, tenant bound into every WHERE. Nothing is stored and no cron
 * runs: the badge is what the rows say right now.
 *
 * THE SIGNALS
 *   money     overdue invoices, subscription payments Stripe could not take
 *             (past_due / unpaid), a subscription set to cancel at the period
 *             end. OASIS's books only; another workspace's money is not in the
 *             app, which is "not tracked", not "fine".
 *   support   tickets that missed their first-response target in 30 days.
 *   delivery  active projects past their due date.
 *   contact   days since the last touch (the latest ACTIVITY, lib/os/customers/
 *             activity.ts lastTouchFor); with none recorded, days since the
 *             record was created.
 * A signal that could not be read is listed as unknown. Unknown is never
 * counted as fine: with nothing wrong in what WAS read and something unread,
 * the level is "unknown", not "healthy".
 */
import type { Client, ResultSet } from "@libsql/client";
import type { CustomerLifecycle } from "@/lib/os/customers/rules";
import { BUSINESS_ENTITY_ID } from "@/lib/founders-finances/chart";

export type HealthLevel = "healthy" | "watch" | "at_risk" | "unknown" | "past";

export const HEALTH_LABELS: Record<HealthLevel, string> = {
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
  unknown: "Not enough data",
  past: "Past",
};

/** Days without contact before a client is on watch, and at risk. */
export const TOUCH_WATCH_DAYS = 21;
export const TOUCH_RISK_DAYS = 45;
/** Missed first-response targets in 30 days: one is a watch, two or more a risk. */
export const SLA_RISK_BREACHES = 2;

export type MoneySignals = { overdueInvoices: number; failedPayments: number; cancelAtPeriodEnd: boolean };

export type HealthInputs = {
  lifecycle: CustomerLifecycle;
  createdAt: string;
  now: Date;
  /** The latest activity; null = none recorded; undefined = could not be read. */
  lastTouch: string | null | undefined;
  /** null = could not be read (or the viewer may not read the desk). */
  slaBreaches30d: number | null;
  projectsPastDue: number | null;
  /** Signals from the books; "not_tracked" = this workspace keeps no books in the app; null = could not be read. */
  money: MoneySignals | "not_tracked" | null;
};

export type Health = { level: HealthLevel; reasons: string[]; unknown: string[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function daysBetween(fromIso: string, now: Date): number | null {
  const t = Date.parse(fromIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export function health(i: HealthInputs): Health {
  if (i.lifecycle === "churned") return { level: "past", reasons: ["The engagement ended."], unknown: [] };
  const risk: string[] = [];
  const watch: string[] = [];
  const unknown: string[] = [];

  if (i.money === null) unknown.push("payments and invoices");
  else if (i.money !== "not_tracked") {
    if (i.money.overdueInvoices > 0) risk.push(`${plural(i.money.overdueInvoices, "invoice is", "invoices are")} overdue.`);
    if (i.money.failedPayments > 0) risk.push(`${plural(i.money.failedPayments, "subscription payment", "subscription payments")} failed.`);
    if (i.money.cancelAtPeriodEnd) risk.push("The subscription is set to cancel at the end of the period.");
  }

  if (i.slaBreaches30d === null) unknown.push("support response times");
  else if (i.slaBreaches30d >= SLA_RISK_BREACHES) risk.push(`${i.slaBreaches30d} tickets missed their response target in 30 days.`);
  else if (i.slaBreaches30d === 1) watch.push("1 ticket missed its response target in 30 days.");

  if (i.projectsPastDue === null) unknown.push("project due dates");
  else if (i.projectsPastDue > 0) watch.push(`${plural(i.projectsPastDue, "project is", "projects are")} past due.`);

  if (i.lifecycle !== "paused") {
    if (i.lastTouch === undefined) unknown.push("last contact");
    else {
      const since = daysBetween(i.lastTouch ?? i.createdAt, i.now);
      const what = i.lastTouch ? "No contact" : "No contact recorded since the record was created";
      if (since === null) unknown.push("last contact");
      else if (since > TOUCH_RISK_DAYS) risk.push(`${what} in ${since} days.`);
      else if (since > TOUCH_WATCH_DAYS) watch.push(`${what} in ${since} days.`);
    }
  }

  if (risk.length) return { level: "at_risk", reasons: [...risk, ...watch], unknown };
  if (watch.length) return { level: "watch", reasons: watch, unknown };
  if (unknown.length) return { level: "unknown", reasons: [], unknown };
  return { level: "healthy", reasons: [], unknown };
}

// ---------------------------------------------------------------------------
// Reading the signals
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function rows(rs: ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, idx) => {
      const v = (r as unknown as unknown[])[idx];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o;
  });
}

/**
 * YYYY-MM-DD in Toronto: the day "overdue" and "past due" are counted against
 * (the books' own calendar). Every reader here and every page uses this one
 * day, so the list, the record and the Client Success count agree between
 * 20:00 and midnight Toronto time, when the UTC date is already tomorrow.
 */
export function torontoDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function chunks<T>(list: readonly T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Tickets that breached, and active projects past due, per client, on the workspace's own desk. */
export async function deskSignalsFor(
  db: Client,
  tenantId: string,
  customerIds: readonly string[],
  now: Date,
): Promise<Map<string, { slaBreaches30d: number; projectsPastDue: number }>> {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("customers.health: a tenant id is required");
  const out = new Map<string, { slaBreaches30d: number; projectsPastDue: number }>();
  for (const id of customerIds) out.set(id, { slaBreaches30d: 0, projectsPastDue: 0 });
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const today = torontoDay(now);
  for (const part of chunks(customerIds)) {
    const marks = part.map(() => "?").join(", ");
    const [breaches, projects] = await Promise.all([
      db.execute({
        sql: `SELECT customer_id, COUNT(*) AS n FROM support_tickets
              WHERE tenant_id = ? AND customer_id IN (${marks}) AND sla_breached_at IS NOT NULL AND sla_breached_at >= ?
              GROUP BY customer_id`,
        args: [tenantId, ...part, since],
      }),
      db.execute({
        sql: `SELECT customer_id, COUNT(*) AS n FROM delivery_projects
              WHERE tenant_id = ? AND customer_id IN (${marks}) AND archived_at IS NULL
                AND stage IN ('discovery', 'building', 'review') AND due_date IS NOT NULL AND due_date <> ''
                AND substr(due_date, 1, 10) < ?
              GROUP BY customer_id`,
        args: [tenantId, ...part, today],
      }),
    ]);
    for (const r of rows(breaches)) out.get(String(r.customer_id))!.slaBreaches30d = Number(r.n);
    for (const r of rows(projects)) out.get(String(r.customer_id))!.projectsPastDue = Number(r.n);
  }
  return out;
}

/**
 * Money signals per client from OASIS's books, matched the way the Money tab
 * matches (lib/os/customers/money.ts): Stripe customer id, else the primary
 * email. The books are small; each table is read once for all clients.
 *
 * A client with neither a Stripe customer nor an email cannot be found in the
 * books at all (its Money tab says "not linked to the books"), so it gets NO
 * entry: its money is unknown, never "nothing overdue".
 */
export async function moneySignalsFor(
  db: Client,
  customers: ReadonlyArray<{ id: string; stripe_customer_id: string | null; primary_email: string | null }>,
  today: string,
): Promise<Map<string, MoneySignals>> {
  const [subs, invoices] = await Promise.all([
    db.execute({
      sql: `SELECT stripe_customer_id, lower(customer_email) AS email, status, cancel_at_period_end
            FROM fin_subscriptions WHERE entity_id = ? AND livemode = 1`,
      args: [BUSINESS_ENTITY_ID],
    }),
    db.execute({
      sql: `SELECT i.status, i.due_date, c.stripe_customer_id, lower(c.email) AS email
            FROM fin_invoices i JOIN fin_contacts c ON c.id = i.contact_id
            WHERE i.entity_id = ? AND i.status IN ('sent', 'overdue')`,
      args: [BUSINESS_ENTITY_ID],
    }),
  ]);
  const subRows = rows(subs);
  const invRows = rows(invoices);
  const out = new Map<string, MoneySignals>();
  for (const c of customers) {
    const stripe = c.stripe_customer_id || null;
    const email = (c.primary_email || "").toLowerCase() || null;
    if (!stripe && !email) continue;
    const mine = (r: Row) => (stripe && r.stripe_customer_id === stripe) || (email && r.email === email);
    let failedPayments = 0;
    let cancelAtPeriodEnd = false;
    for (const r of subRows) {
      if (!mine(r)) continue;
      const status = String(r.status ?? "");
      if (status === "past_due" || status === "unpaid") failedPayments += 1;
      if (["active", "trialing", "past_due"].includes(status) && Number(r.cancel_at_period_end) === 1) cancelAtPeriodEnd = true;
    }
    let overdueInvoices = 0;
    for (const r of invRows) {
      if (!mine(r)) continue;
      const due = String(r.due_date ?? "");
      if (r.status === "overdue" || (due !== "" && due < today)) overdueInvoices += 1;
    }
    out.set(c.id, { overdueInvoices, failedPayments, cancelAtPeriodEnd });
  }
  return out;
}

/**
 * At-risk clients in a workspace, for Client Success. Current clients only
 * (not archived, not Past). `money` says whether the caller may read OASIS's
 * books for this workspace ("read"), the workspace keeps none ("not_tracked"),
 * or the caller may not read them ("unknown", counted as unknown, not fine).
 * `lastTouch` is lib/os/customers/activity.ts lastTouchFor, passed in so this
 * module stays free of the activity reader.
 */
export async function countAtRiskClients(
  db: Client,
  tenantId: string,
  now: Date,
  opts: {
    money: "read" | "not_tracked" | "unknown";
    lastTouch: (
      customers: ReadonlyArray<{
        id: string;
        source_lead_id: string | null;
        stripe_customer_id: string | null;
        primary_email: string | null;
        primary_phone: string | null;
      }>,
    ) => Promise<Map<string, string | null>>;
  },
): Promise<{ total: number; atRisk: number; watch: number; unknown: number }> {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("customers.health: a tenant id is required");
  const list = rows(
    await db.execute({
      sql: `SELECT id, lifecycle, created_at, source_lead_id, stripe_customer_id, primary_email, primary_phone FROM customers
            WHERE tenant_id = ? AND archived_at IS NULL AND lifecycle <> 'churned' LIMIT 1000`,
      args: [tenantId],
    }),
  ).map((r) => ({
    id: String(r.id),
    lifecycle: String(r.lifecycle ?? "active") as CustomerLifecycle,
    created_at: String(r.created_at ?? ""),
    source_lead_id: r.source_lead_id ? String(r.source_lead_id) : null,
    stripe_customer_id: r.stripe_customer_id ? String(r.stripe_customer_id) : null,
    primary_email: r.primary_email ? String(r.primary_email) : null,
    primary_phone: r.primary_phone ? String(r.primary_phone) : null,
  }));
  const today = torontoDay(now);
  const [desk, touch, money] = await Promise.all([
    deskSignalsFor(db, tenantId, list.map((c) => c.id), now),
    opts.lastTouch(list),
    opts.money === "read" ? moneySignalsFor(db, list, today) : Promise.resolve(null),
  ]);
  let atRisk = 0;
  let watch = 0;
  let unknown = 0;
  for (const c of list) {
    const d = desk.get(c.id)!;
    const h = health({
      lifecycle: c.lifecycle,
      createdAt: c.created_at,
      now,
      lastTouch: touch.has(c.id) ? touch.get(c.id)! : undefined,
      slaBreaches30d: d.slaBreaches30d,
      projectsPastDue: d.projectsPastDue,
      money: opts.money === "not_tracked" ? "not_tracked" : money ? money.get(c.id) ?? null : null,
    });
    if (h.level === "at_risk") atRisk += 1;
    else if (h.level === "watch") watch += 1;
    else if (h.level === "unknown") unknown += 1;
  }
  return { total: list.length, atRisk, watch, unknown };
}
