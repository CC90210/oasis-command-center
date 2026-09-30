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
 *              refund.issued follow). Events the ledger files under finance
 *              are read only for a viewer who may open Money (opts.books).
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
import { normalizePhoneE164 } from "@/lib/conversation-threading";
import { BUSINESS_ENTITY_ID } from "@/lib/founders-finances/chart";
import { normalizeEmail } from "@/lib/os/customers/rules";

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
  opts: {
    /**
     * OASIS's own workspace, whose books are in the app: the Stripe payment,
     * refund and subscription events the books' ingest records are found
     * through the client's fin_payments / fin_subscriptions rows (their ledger
     * subject), by Stripe customer or primary email. Never for another
     * workspace, whose money is not in these tables.
     */
    books?: boolean;
  } = {},
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
  const email = (customer.primary_email || "").trim().toLowerCase();
  if (opts.books && (customer.stripe_customer_id || email)) {
    const who = "((? <> '' AND stripe_customer_id = ?) OR (? <> '' AND lower(customer_email) = ?))";
    const stripe = customer.stripe_customer_id ?? "";
    const whoArgs = [stripe, stripe, email, email];
    // A refund reads its customer through the payment it refunds, as the
    // Money tab and the Finances metrics do.
    const payer = `SELECT p.id FROM fin_payments p LEFT JOIN fin_payments pp ON pp.id = p.parent_payment_id
                   WHERE p.entity_id = ? AND ((? <> '' AND COALESCE(p.stripe_customer_id, pp.stripe_customer_id) = ?)
                     OR (? <> '' AND lower(COALESCE(NULLIF(p.customer_email, ''), pp.customer_email)) = ?))`;
    where.push(
      `(subject_type IN ('payment', 'refund') AND subject_id IN (${payer}))`,
      `(subject_type = 'payment' AND subject_id IN (SELECT stripe_charge_id FROM fin_payments WHERE entity_id = ? AND stripe_charge_id IS NOT NULL AND ${who}))`,
      `(subject_type = 'subscription' AND subject_id IN (SELECT id FROM fin_subscriptions WHERE entity_id = ? AND ${who}))`,
    );
    args.push(BUSINESS_ENTITY_ID, ...whoArgs, BUSINESS_ENTITY_ID, ...whoArgs, BUSINESS_ENTITY_ID, ...whoArgs);
  }
  // Money is for the founders who may open Money. Without the books, no event
  // the ledger files under finance (payments, refunds, invoices, subscriptions,
  // with their amounts) is read, whichever column matched it: a payment that
  // names the client's Stripe customer or its customer id is still money.
  const moneyGate = opts.books ? "" : " AND department_key <> 'finance'";
  const ledger = await db.execute({
    sql: `SELECT id, event_key, occurred_at, subject_type, subject_id, value_cents, currency, payload_json,
                 CASE WHEN customer_id IS NULL OR customer_id <> ? THEN 1 ELSE 0 END AS from_deal
          FROM outcome_events
          WHERE tenant_id = ? AND (${where.join(" OR ")})${moneyGate}
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
 * A send the mail server could not confirm (lib/os/customers/conversations.ts
 * records it with this type). It may never have left, so it is not contact.
 */
const UNCONFIRMED_SEND = "email_delivery_unknown";

/** The JSON field `metadata.<key>` of a row, or NULL when the column is not JSON. */
const metaField = (key: string, column = "metadata") =>
  `(CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${key}') END)`;

export type TouchCustomer = ActivityCustomer & { primary_phone?: string | null; last_ticket_at?: string | null };

/**
 * "Last touch" for each client: the latest ACTIVITY, never the record's
 * updated_at (an edit to a tag is not contact with the client). It reads every
 * place the Conversations tab reads, matched the same way
 * (lib/os/customers/conversations.ts loadClientConversation), so the badge
 * never says "no contact" over a thread full of messages. The latest of:
 *   - the client's ledger facts (bookkeeping about the record excluded);
 *   - its tickets, and the public replies on them;
 *   - interactions on the deal it came from (internal notes excluded);
 *   - email and SMS to or from ANY of its addresses: the primary email and
 *     phone and every contact's email and phone;
 *   - messages stamped with its id (metadata.customer_id, what the composer
 *     writes);
 *   - Slack messages mirrored for it (conversation_events);
 *   - agents' drafts to it that were approved and sent.
 * A send the mail server could not confirm is not counted: it may never have
 * left. Null = nothing recorded at all, which the page says as such.
 */
export async function lastTouchFor(
  db: Client,
  tenantId: string,
  customers: ReadonlyArray<TouchCustomer>,
): Promise<Map<string, string | null>> {
  requireTenant(tenantId);
  const out = new Map<string, string | null>();
  if (customers.length === 0) return out;
  const byCustomer = new Map<string, string>();
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
  // Each address (and deal) mapped to the clients it belongs to. Two clients can share
  // an address; a message to it is in both threads, so it touches both.
  const owners = (map: Map<string, Set<string>>, key: string | null, id: string) => {
    if (!key) return;
    const set = map.get(key) ?? new Set<string>();
    set.add(id);
    map.set(key, set);
  };
  const byEmail = new Map<string, Set<string>>();
  const byPhone = new Map<string, Set<string>>();
  const byLead = new Map<string, Set<string>>();
  for (const c of customers) {
    owners(byEmail, normalizeEmail(c.primary_email), c.id);
    owners(byPhone, normalizePhoneE164(c.primary_phone ?? null), c.id);
    owners(byLead, c.source_lead_id, c.id);
  }
  for (const part of chunk(ids)) {
    const rs = await db.execute({
      sql: `SELECT customer_id, email, phone FROM customer_contacts
            WHERE tenant_id = ? AND customer_id IN (${part.map(() => "?").join(", ")})`,
      args: [tenantId, ...part],
    });
    for (const r of rows(rs)) {
      owners(byEmail, normalizeEmail(r.email), String(r.customer_id));
      owners(byPhone, normalizePhoneE164(s(r.phone)), String(r.customer_id));
    }
  }
  const bumpAll = (map: Map<string, Set<string>>, key: string, at: string | null) => {
    for (const id of map.get(key) ?? []) bump(id, at);
  };

  for (const part of chunk(ids)) {
    const marks = part.map(() => "?").join(", ");
    const [ledger, tickets, replies, stamped, slack, approved] = await Promise.all([
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
      // What the record's composer sent (stamped with the client's id).
      db.execute({
        sql: `SELECT ${metaField("customer_id")} AS customer_id, MAX(COALESCE(sent_at, created_at)) AS at FROM lead_interactions
              WHERE tenant_id = ? AND channel IN ('email', 'sms') AND COALESCE(type, '') <> ?
                AND ${metaField("customer_id")} IN (${marks})
              GROUP BY 1`,
        args: [tenantId, UNCONFIRMED_SEND, ...part],
      }),
      // Slack, mirrored for this client (the rows the Conversations tab shows).
      db.execute({
        sql: `SELECT ${metaField("customer_id")} AS customer_id, MAX(created_at) AS at FROM conversation_events
              WHERE tenant_id = ? AND ${metaField("channel")} = 'slack'
                AND (CASE WHEN json_valid(metadata) THEN json_type(metadata, '$.text') END) = 'text'
                AND ${metaField("customer_id")} IN (${marks})
              GROUP BY 1`,
        args: [tenantId, ...part],
      }),
      // Agents' drafts to the client, approved and sent.
      db.execute({
        sql: `SELECT target_ref, MAX(executed_at) AS at FROM approvals
              WHERE tenant_id = ? AND action_kind = 'send_email' AND status = 'executed' AND executed_at IS NOT NULL
                AND ${metaField("outcome", "execution_result")} = 'sent'
                AND target_ref IN (${marks})
              GROUP BY target_ref`,
        args: [tenantId, ...part.map((id) => `customer:${id}`)],
      }),
    ]);
    for (const rs of [ledger, tickets, replies, stamped, slack]) {
      for (const r of rows(rs)) bump(String(r.customer_id), s(r.at));
    }
    for (const r of rows(approved)) bump(String(r.target_ref).slice("customer:".length), s(r.at));
  }
  const leads = [...byLead.keys()];
  for (const part of chunk(leads)) {
    const rs = await db.execute({
      // An internal note on the deal is not contact with the client (the
      // Conversations tab does not show it either).
      sql: `SELECT lead_id, MAX(COALESCE(sent_at, created_at)) AS at FROM lead_interactions
            WHERE tenant_id = ? AND lead_id IN (${part.map(() => "?").join(", ")}) AND COALESCE(type, '') <> ?
              AND COALESCE(channel, '') <> 'note' AND COALESCE(type, '') <> 'note'
            GROUP BY lead_id`,
      args: [tenantId, ...part, UNCONFIRMED_SEND],
    });
    for (const r of rows(rs)) bumpAll(byLead, String(r.lead_id), s(r.at));
  }
  for (const part of chunk([...byEmail.keys()])) {
    const marks = part.map(() => "?").join(", ");
    const rs = await db.execute({
      sql: `SELECT addr, MAX(at) AS at FROM (
              SELECT lower(to_email) AS addr, COALESCE(sent_at, created_at) AS at FROM lead_interactions
                WHERE tenant_id = ? AND channel IN ('email', 'sms') AND COALESCE(type, '') <> ? AND lower(to_email) IN (${marks})
              UNION ALL
              SELECT lower(from_email) AS addr, COALESCE(sent_at, created_at) AS at FROM lead_interactions
                WHERE tenant_id = ? AND channel IN ('email', 'sms') AND COALESCE(type, '') <> ? AND lower(from_email) IN (${marks})
            ) GROUP BY addr`,
      args: [tenantId, UNCONFIRMED_SEND, ...part, tenantId, UNCONFIRMED_SEND, ...part],
    });
    for (const r of rows(rs)) bumpAll(byEmail, String(r.addr), s(r.at));
  }
  // Texts carry a phone, not an email (lead_interactions.to_phone / from_phone, E.164).
  for (const part of chunk([...byPhone.keys()])) {
    const marks = part.map(() => "?").join(", ");
    const rs = await db.execute({
      sql: `SELECT addr, MAX(at) AS at FROM (
              SELECT to_phone AS addr, COALESCE(sent_at, created_at) AS at FROM lead_interactions
                WHERE tenant_id = ? AND channel IN ('email', 'sms') AND COALESCE(type, '') <> ? AND to_phone IN (${marks})
              UNION ALL
              SELECT from_phone AS addr, COALESCE(sent_at, created_at) AS at FROM lead_interactions
                WHERE tenant_id = ? AND channel IN ('email', 'sms') AND COALESCE(type, '') <> ? AND from_phone IN (${marks})
            ) GROUP BY addr`,
      args: [tenantId, UNCONFIRMED_SEND, ...part, tenantId, UNCONFIRMED_SEND, ...part],
    });
    for (const r of rows(rs)) bumpAll(byPhone, String(r.addr), s(r.at));
  }
  for (const c of customers) out.set(c.id, latest(byCustomer.get(c.id), c.last_ticket_at ?? null));
  return out;
}
