/**
 * lib/os/customers/stripe-sync.ts — turn the Stripe customers already in
 * OASIS's books into OASIS client records, when a founder asks.
 *
 * Runs ONLY from the founder-clicked "Import Stripe customers" button
 * (POST /api/clients/import-stripe), which also requires the founder to
 * confirm the privacy question first: Stripe subscribers can be private
 * individuals, and Quebec's Law 25 applies to recording them. It imports only
 * the Stripe customers the founder was shown and confirmed. Nothing calls it
 * on a schedule.
 *
 * WHAT IT READS. fin_subscriptions and fin_payments of OASIS's business book
 * (live mode), grouped by stripe_customer_id. Rows without a Stripe customer
 * are not a Stripe customer and are left alone.
 *
 * WHAT IT STORES: THE MINIMUM. A name and an email, as Stripe holds them, plus
 * the Stripe customer id that links the record to its money. No phone, no
 * address, no amounts (the Money tab reads those from the books). A customer
 * with neither a name nor an email is skipped: nothing is invented.
 *
 * STATUS. "active" while any subscription is active, trialing or past_due;
 * otherwise "churned" (Past). The founder chooses from that: each person is
 * listed with their subscription status and last payment, Active ticked and
 * Past not, and only the people ticked are imported (CC, 2026-10-02: "I want
 * to be able to just import one because some of them are inactive").
 *
 * IDEMPOTENT. A Stripe customer that already has a record is skipped. A record
 * with the same email and no Stripe customer is LINKED (its stripe_customer_id
 * set, nothing else changed). A record with the same email and a DIFFERENT
 * Stripe customer is reported as a conflict and left for the founder. Running
 * it twice creates nothing the second time.
 */
import type { Client, ResultSet } from "@libsql/client";
import { BUSINESS_ENTITY_ID } from "@/lib/founders-finances/chart";
import { MRR_STATUSES } from "@/lib/founders-finances/mrr";
import { LIMITS, normalizeEmail, type CustomerLifecycle } from "@/lib/os/customers/rules";
import { createCustomer, linkStripeCustomer } from "@/lib/os/customers/store";

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

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export type StripeCustomerGroup = {
  stripe_customer_id: string;
  name: string | null;
  email: string | null;
  lifecycle: CustomerLifecycle;
  /**
   * What the founder chooses by. The status of a live subscription (active,
   * trialing, past_due) when there is one, else the newest subscription's
   * (e.g. canceled); null when the books hold no subscription for them.
   */
  subscription_status: string | null;
  /** The newest live payment's time; null when the books hold none. */
  last_paid_at: string | null;
};

/**
 * One group per Stripe customer. The name and email are the most recent
 * non-empty values any of its rows carries (subscriptions first, then
 * payments), exactly as Stripe sent them. The subscription status and last
 * payment come from the same rows.
 */
export async function stripeCustomerGroups(db: Client): Promise<StripeCustomerGroup[]> {
  const [subs, pays] = await Promise.all([
    db.execute({
      sql: `SELECT stripe_customer_id, customer_name, customer_email, status, updated_at AS at
            FROM fin_subscriptions
            WHERE entity_id = ? AND livemode = 1 AND stripe_customer_id IS NOT NULL AND stripe_customer_id <> ''
            ORDER BY updated_at DESC`,
      args: [BUSINESS_ENTITY_ID],
    }),
    db.execute({
      sql: `SELECT stripe_customer_id, customer_name, customer_email, occurred_at AS at
            FROM fin_payments
            WHERE entity_id = ? AND livemode = 1 AND kind = 'payment' AND stripe_customer_id IS NOT NULL AND stripe_customer_id <> ''
            ORDER BY occurred_at DESC`,
      args: [BUSINESS_ENTITY_ID],
    }),
  ]);
  type Building = StripeCustomerGroup & { liveStatus: string | null; newestStatus: string | null };
  const groups = new Map<string, Building>();
  const touch = (r: Row) => {
    const id = String(r.stripe_customer_id);
    const g: Building = groups.get(id) ?? {
      stripe_customer_id: id,
      name: null,
      email: null,
      lifecycle: "churned",
      subscription_status: null,
      last_paid_at: null,
      liveStatus: null,
      newestStatus: null,
    };
    // Rows arrive newest first, so the first non-empty value wins.
    g.name = g.name ?? clean(r.customer_name);
    g.email = g.email ?? normalizeEmail(r.customer_email);
    groups.set(id, g);
    return g;
  };
  for (const r of rows(subs)) {
    const g = touch(r);
    const status = clean(r.status);
    g.newestStatus = g.newestStatus ?? status;
    if (status && MRR_STATUSES.has(status)) g.liveStatus = g.liveStatus ?? status;
  }
  for (const r of rows(pays)) {
    const g = touch(r);
    g.last_paid_at = g.last_paid_at ?? clean(r.at);
  }
  return [...groups.values()]
    .map(({ liveStatus, newestStatus, ...g }) => ({
      ...g,
      lifecycle: (liveStatus ? "active" : "churned") as CustomerLifecycle,
      subscription_status: liveStatus ?? newestStatus,
    }))
    .sort((a, b) => a.stripe_customer_id.localeCompare(b.stripe_customer_id));
}

export type ImportPlanItem =
  | { action: "create"; group: StripeCustomerGroup }
  | { action: "link"; group: StripeCustomerGroup; customerId: string }
  | { action: "skip"; group: StripeCustomerGroup; reason: "already_a_client" | "no_name_or_email"; customerId?: string }
  | { action: "conflict"; group: StripeCustomerGroup; customerId: string };

/** What an import WOULD do, without writing anything. The button shows it before the founder confirms. */
export async function planStripeImport(db: Client, tenantId: string): Promise<ImportPlanItem[]> {
  if (typeof tenantId !== "string" || !tenantId.trim()) throw new Error("customers.stripe-sync: a tenant id is required");
  const groups = await stripeCustomerGroups(db);
  const existing = rows(
    await db.execute({
      sql: "SELECT id, primary_email, stripe_customer_id FROM customers WHERE tenant_id = ?",
      args: [tenantId],
    }),
  );
  const byStripe = new Map(existing.filter((r) => r.stripe_customer_id).map((r) => [String(r.stripe_customer_id), String(r.id)]));
  const byEmail = new Map(
    existing.filter((r) => r.primary_email).map((r) => [String(r.primary_email).toLowerCase(), { id: String(r.id), stripe: r.stripe_customer_id ? String(r.stripe_customer_id) : null }]),
  );
  // Two Stripe customers can share an email. Only the first may link to the
  // record with that email; the next is a conflict for the founder, never a
  // second link that would overwrite the first.
  const claimed = new Set<string>();
  return groups.map((group): ImportPlanItem => {
    const have = byStripe.get(group.stripe_customer_id);
    if (have) return { action: "skip", group, reason: "already_a_client", customerId: have };
    if (!group.name && !group.email) return { action: "skip", group, reason: "no_name_or_email" };
    const sameEmail = group.email ? byEmail.get(group.email) : undefined;
    if (sameEmail) {
      if (sameEmail.stripe || claimed.has(sameEmail.id)) return { action: "conflict", group, customerId: sameEmail.id };
      claimed.add(sameEmail.id);
      return { action: "link", group, customerId: sameEmail.id };
    }
    return { action: "create", group };
  });
}

export type ImportResult = {
  created: string[];
  linked: string[];
  skipped: number;
  conflicts: Array<{ stripe_customer_id: string; customerId: string | null }>;
  /** Stripe customers the founder was shown and left unticked: not imported, by their choice. */
  declined: string[];
  /** Stripe customers the founder was not shown (they reached the books after the list was opened): not imported. */
  unreviewed: string[];
  /** Stripe customers whose action changed since the founder reviewed it (a create is now a link, or back): not imported. */
  changed: string[];
};

/** What the founder saw and confirmed in the dialog: each Stripe customer and the action it was shown with. */
export type ConfirmedImport = ReadonlyMap<string, "create" | "link">;

/**
 * Carry out what the founder CONFIRMED, and nothing else. The plan is read
 * again (so nothing is written from a stale picture), and each create or link
 * runs only when the founder was shown that same Stripe customer with that
 * same action: the privacy confirmation covered the people ticked, not whoever
 * reached the books between the preview and the click. The rest is reported
 * for the founder: `declined` (shown and left unticked, their choice; the
 * dialog sends them), `unreviewed` (never shown) and `changed` (shown with a
 * different action), so "left out by you" is never confused with "arrived
 * after you looked".
 *
 * Each record goes through the customers store, so it is tenant-scoped,
 * unique-index guarded and ledgered (customer.created, origin "import") like
 * any other. A record that raced in between the plan and the write is reported
 * as a conflict, never overwritten.
 */
export async function runStripeImport(
  db: Client,
  tenantId: string,
  actor: string | null,
  now: Date,
  confirmed: ConfirmedImport,
  /** The Stripe customers the founder was shown and left unticked. */
  declined: ReadonlySet<string> = new Set(),
): Promise<ImportResult> {
  const plan = await planStripeImport(db, tenantId);
  const out: ImportResult = { created: [], linked: [], skipped: 0, conflicts: [], declined: [], unreviewed: [], changed: [] };
  for (const item of plan) {
    const g = item.group;
    if (item.action === "skip") {
      out.skipped += 1;
      continue;
    }
    if (item.action === "conflict") {
      out.conflicts.push({ stripe_customer_id: g.stripe_customer_id, customerId: item.customerId });
      continue;
    }
    const shown = confirmed.get(g.stripe_customer_id);
    if (!shown) {
      if (declined.has(g.stripe_customer_id)) out.declined.push(g.stripe_customer_id);
      else out.unreviewed.push(g.stripe_customer_id);
      continue;
    }
    if (shown !== item.action) {
      out.changed.push(g.stripe_customer_id);
      continue;
    }
    if (item.action === "link") {
      // Only onto a record that still has no Stripe customer: one linked since
      // the plan was read keeps its link, and this one is a conflict.
      const r = await linkStripeCustomer(db, tenantId, item.customerId, g.stripe_customer_id, now);
      if (r.ok) out.linked.push(item.customerId);
      else out.conflicts.push({ stripe_customer_id: g.stripe_customer_id, customerId: item.customerId });
      continue;
    }
    const created = await createCustomer(
      db,
      tenantId,
      {
        display_name: (g.name ?? g.email ?? g.stripe_customer_id).slice(0, LIMITS.displayName),
        company_name: null,
        primary_email: g.email,
        primary_phone: null,
        lifecycle: g.lifecycle,
        owner_user_id: null,
        stripe_customer_id: g.stripe_customer_id,
        tags: [],
        custom_fields: {},
      },
      actor,
      now,
      "import",
    );
    if (created.ok) out.created.push(created.customer.id);
    else out.conflicts.push({ stripe_customer_id: g.stripe_customer_id, customerId: created.existingId });
  }
  return out;
}
