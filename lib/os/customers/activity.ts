/**
 * lib/os/customers/activity.ts — a client record's Activity tab and its
 * "Last touch", read from what the business already records.
 *
 *   RECORDED   outcome_events (the Business Ledger, bravo__190) for this client:
 *              rows whose customer_id is the record (customer.created, ticket
 *              events on its tickets, customer.churned, ...), rows about the
 *              deal it came from (deal_id = source_lead_id: deal.won, ...),
 *              and payment rows that name its Stripe customer (contact_id =
 *              the cus_ id, the contract T5's payment.received and
 *              refund.issued follow).
 *   INFERRED   lead_interactions on the deal the client came from. Those were
 *              logged against the LEAD, before (or outside) the client record,
 *              so each is labelled "inferred from the deal", never passed off
 *              as a fact about the client record.
 *
 * Raw SQL on a libSQL client the caller passes, tenant bound into every
 * WHERE, like lib/os/customers/store.ts. Nothing here writes, and nothing
 * here imports the ledger emitter (tests/ledger-core.test.ts: a module that
 * emits may name only the keys it owns; this one names every key it reads).
 */
import type { Client, ResultSet } from "@libsql/client";

type Row = Record<string, unknown>;

function rows(rs: ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, i) => {
      const v = (r as unknown as unknown[])[i];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o;
  });
}

const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

function requireTenant(tenantId: string): string {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("customers.activity: a tenant id is required");
  return tenantId;
}

export type ActivityCustomer = {
  id: string;
  source_lead_id: string | null;
  stripe_customer_id: string | null;
  primary_email: string | null;
};

export type ActivityEntry = {
  id: string;
  at: string;
  /** "recorded": a ledger fact. "inferred": an interaction on the source deal. */
  basis: "recorded" | "inferred";
  label: string;
  detail: string | null;
  /** In-app link for the thing the event is about (a ticket), when there is one. */
  href: string | null;
};

/** What each ledger key reads as on a client's timeline. Unknown keys are humanised, never dropped. */
const LEDGER_LABELS: Readonly<Record<string, string>> = {
  "customer.created": "Became a client record",
  "customer.churned": "Engagement ended (moved to Past)",
  "customer.reactivated": "Came back from Past",
  "onboarding.milestone_reached": "Onboarding milestone reached",
  "ticket.opened": "Support ticket opened",
  "ticket.first_response": "First reply sent on a ticket",
  "ticket.sla_breached": "A ticket passed its response target",
  "ticket.resolved": "Support ticket resolved",
  "ticket.reopened": "Support ticket reopened",
  "csat.recorded": "Satisfaction score recorded",
  "project.created": "Project created",
  "project.stage_changed": "Project moved stage",
  "project.launched": "Project went live",
  "deliverable.shipped": "Deliverable shipped",
  "deal.won": "Deal won",
  "deal.lost": "Deal lost",
  "payment.received": "Payment received",
  "payment.failed": "Payment failed",
  "refund.issued": "Refund issued",
  "invoice.issued": "Invoice issued",
  "invoice.paid": "Invoice paid",
  "invoice.voided": "Invoice voided",
  "subscription.started": "Subscription started",
  "subscription.renewed": "Subscription renewed",
  "subscription.changed": "Subscription changed",
  "subscription.cancelled": "Subscription cancelled",
};

const ORIGIN_LABELS: Readonly<Record<string, string>> = {
  conversion: "converted from a won deal",
  manual: "added by hand",
  import: "imported from Stripe",
};

function humanizeKey(key: string): string {
  const t = key.replace(/[._]/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "Event";
}

/** Integer cents as "CAD 1,234.56". Cents stay integers until this line. */
export function formatCents(cents: number, currency: string): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${currency.toUpperCase()} ${whole}.${frac}`;
}

function parsePayload(v: unknown): Record<string, unknown> {
  if (typeof v !== "string" || !v.trim()) return {};
  try {
    const p = JSON.parse(v);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    // The ledger writes canonical JSON; an unreadable row still shows its
    // label, and the log names it.
    console.error("[customers.activity] unparseable outcome_events.payload_json");
    return {};
  }
}

export function ledgerEntry(r: Row): ActivityEntry {
  const key = String(r.event_key ?? "");
  const payload = parsePayload(r.payload_json);
  const details: string[] = [];
  if (key === "customer.created" && typeof payload.origin === "string" && ORIGIN_LABELS[payload.origin]) {
    details.push(ORIGIN_LABELS[payload.origin]);
  }
  if (r.value_cents !== null && r.value_cents !== undefined && s(r.currency)) {
    details.push(formatCents(Number(r.value_cents), String(r.currency)));
  }
  if (key === "ticket.first_response" && typeof payload.response_minutes === "number") {
    details.push(`${payload.response_minutes} min after it opened`);
  }
  if (Number(r.from_deal) === 1 && key.startsWith("deal.")) details.push("on the deal this client came from");
  const subjectType = s(r.subject_type);
  const subjectId = s(r.subject_id);
  return {
    id: `ledger:${String(r.id)}`,
    at: String(r.occurred_at ?? ""),
    basis: "recorded",
    label: LEDGER_LABELS[key] ?? humanizeKey(key),
    detail: details.length ? details.join(" · ") : null,
    href: subjectType === "ticket" && subjectId ? `/tickets/${subjectId}` : null,
  };
}

function interactionEntry(r: Row): ActivityEntry {
  const channel = s(r.channel);
  const direction = s(r.direction);
  const kind = [channel ?? s(r.type), direction].filter(Boolean).join(" · ") || "Interaction";
  const preview = s(r.content_preview) ?? s(r.content);
  const subject = s(r.subject);
  return {
    id: `deal:${String(r.id)}`,
    at: String(r.at ?? ""),
    basis: "inferred",
    label: kind[0].toUpperCase() + kind.slice(1),
    detail: [subject, preview ? preview.slice(0, 280) : null].filter(Boolean).join(" · ") || null,
    href: null,
  };
}

export const ACTIVITY_LIMIT = 200;

/**
 * The client's timeline, newest first: ledger facts and the source deal's
 * interactions, merged. Each read is capped at ACTIVITY_LIMIT; `truncated`
 * says when either stopped there.
 */
export async function loadClientActivity(
  db: Client,
  tenantId: string,
  customer: ActivityCustomer,
): Promise<{ entries: ActivityEntry[]; truncated: boolean }> {
  requireTenant(tenantId);
  // Ticket events for tickets linked to the client AFTER they were opened
  // (the support intake's email match, a founder's link) carry no customer_id
  // in the ledger; they are found through the ticket's link today.
  const where = [
    "customer_id = ?",
    "(subject_type = 'ticket' AND subject_id IN (SELECT id FROM support_tickets WHERE tenant_id = ? AND customer_id = ?))",
  ];
  const args: Array<string | number> = [customer.id, tenantId, customer.id];
  if (customer.source_lead_id) {
    where.push("deal_id = ?");
    args.push(customer.source_lead_id);
  }
  if (customer.stripe_customer_id) {
    where.push("contact_id = ?");
    args.push(customer.stripe_customer_id);
  }
  const ledger = await db.execute({
    sql: `SELECT id, event_key, occurred_at, subject_type, subject_id, value_cents, currency, payload_json,
                 CASE WHEN customer_id IS NULL OR customer_id <> ? THEN 1 ELSE 0 END AS from_deal
          FROM outcome_events
          WHERE tenant_id = ? AND (${where.join(" OR ")})
          ORDER BY occurred_at DESC, id DESC
          LIMIT ${ACTIVITY_LIMIT + 1}`,
    args: [customer.id, tenantId, ...args],
  });
  const ledgerRows = rows(ledger);
  let dealRows: Row[] = [];
  if (customer.source_lead_id) {
    const rs = await db.execute({
      sql: `SELECT id, type, channel, direction, subject, content_preview, content,
                   COALESCE(sent_at, created_at) AS at
            FROM lead_interactions
            WHERE tenant_id = ? AND lead_id = ?
            ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
            LIMIT ${ACTIVITY_LIMIT + 1}`,
      args: [tenantId, customer.source_lead_id],
    });
    dealRows = rows(rs);
  }
  const truncated = ledgerRows.length > ACTIVITY_LIMIT || dealRows.length > ACTIVITY_LIMIT;
  const entries = [
    ...ledgerRows.slice(0, ACTIVITY_LIMIT).map(ledgerEntry),
    ...dealRows.slice(0, ACTIVITY_LIMIT).map(interactionEntry),
  ].filter((e) => e.at);
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  return { entries, truncated };
}

/** Ledger keys about the record, not about contact with the client. */
const NOT_A_TOUCH = ["customer.created", "customer.churned", "customer.reactivated", "onboarding.milestone_reached"];

function latest(...isos: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const iso of isos) {
    if (!iso || Number.isNaN(Date.parse(iso))) continue;
    if (best === null || Date.parse(iso) > Date.parse(best)) best = iso;
  }
  return best;
}

/**
 * "Last touch" for each client: the latest ACTIVITY, never the record's
 * updated_at (an edit to a tag is not contact with the client). The latest of:
 * the client's ledger facts, an interaction on its source deal, a message to or
 * from its primary address, and the latest ticket the desk already counted.
 * Null = nothing recorded at all, which the page says as such.
 */
export async function lastTouchFor(
  db: Client,
  tenantId: string,
  customers: ReadonlyArray<ActivityCustomer & { last_ticket_at?: string | null }>,
): Promise<Map<string, string | null>> {
  requireTenant(tenantId);
  const out = new Map<string, string | null>();
  if (customers.length === 0) return out;
  const byCustomer = new Map<string, string>();
  const byLead = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const chunk = <T,>(list: readonly T[]) => {
    const parts: T[][] = [];
    for (let i = 0; i < list.length; i += 200) parts.push(list.slice(i, i + 200));
    return parts;
  };
  const ids = customers.map((c) => c.id);
  const bump = (id: string, at: string | null) => {
    const best = latest(byCustomer.get(id), at);
    if (best) byCustomer.set(id, best);
  };
  for (const part of chunk(ids)) {
    const marks = part.map(() => "?").join(", ");
    const [ledger, tickets, replies] = await Promise.all([
      // Bookkeeping about the record itself (it was created, moved to Past)
      // is not contact with the client, so it is not a touch.
      db.execute({
        sql: `SELECT customer_id, MAX(occurred_at) AS at FROM outcome_events
              WHERE tenant_id = ? AND customer_id IN (${marks})
                AND event_key NOT IN (${NOT_A_TOUCH.map(() => "?").join(", ")})
              GROUP BY customer_id`,
        args: [tenantId, ...part, ...NOT_A_TOUCH],
      }),
      // Tickets opened before the ledger recorded them, and public replies on
      // them (an internal note is not contact with the client).
      db.execute({
        sql: `SELECT customer_id, MAX(created_at) AS at FROM support_tickets
              WHERE tenant_id = ? AND customer_id IN (${marks})
              GROUP BY customer_id`,
        args: [tenantId, ...part],
      }),
      db.execute({
        sql: `SELECT t.customer_id, MAX(c.created_at) AS at FROM ticket_comments c
              JOIN support_tickets t ON t.id = c.ticket_id AND t.tenant_id = c.tenant_id
              WHERE c.tenant_id = ? AND t.customer_id IN (${marks}) AND c.is_internal = 0 AND c.author_type IN ('team', 'client')
              GROUP BY t.customer_id`,
        args: [tenantId, ...part],
      }),
    ]);
    for (const rs of [ledger, tickets, replies]) {
      for (const r of rows(rs)) bump(String(r.customer_id), s(r.at));
    }
  }
  const leads = [...new Set(customers.map((c) => c.source_lead_id).filter((x): x is string => Boolean(x)))];
  for (const part of chunk(leads)) {
    const rs = await db.execute({
      sql: `SELECT lead_id, MAX(COALESCE(sent_at, created_at)) AS at FROM lead_interactions
            WHERE tenant_id = ? AND lead_id IN (${part.map(() => "?").join(", ")})
            GROUP BY lead_id`,
      args: [tenantId, ...part],
    });
    for (const r of rows(rs)) if (s(r.at)) byLead.set(String(r.lead_id), String(r.at));
  }
  const emails = [...new Set(customers.map((c) => (c.primary_email || "").toLowerCase()).filter(Boolean))];
  for (const part of chunk(emails)) {
    const marks = part.map(() => "?").join(", ");
    const rs = await db.execute({
      sql: `SELECT addr, MAX(at) AS at FROM (
              SELECT lower(to_email) AS addr, COALESCE(sent_at, created_at) AS at FROM lead_interactions
                WHERE tenant_id = ? AND channel IN ('email', 'sms') AND lower(to_email) IN (${marks})
              UNION ALL
              SELECT lower(from_email) AS addr, COALESCE(sent_at, created_at) AS at FROM lead_interactions
                WHERE tenant_id = ? AND channel IN ('email', 'sms') AND lower(from_email) IN (${marks})
            ) GROUP BY addr`,
      args: [tenantId, ...part, tenantId, ...part],
    });
    for (const r of rows(rs)) if (s(r.at)) byEmail.set(String(r.addr), String(r.at));
  }
  for (const c of customers) {
    out.set(
      c.id,
      latest(
        byCustomer.get(c.id),
        c.source_lead_id ? byLead.get(c.source_lead_id) : null,
        c.primary_email ? byEmail.get(c.primary_email.toLowerCase()) : null,
        c.last_ticket_at ?? null,
      ),
    );
  }
  return out;
}
