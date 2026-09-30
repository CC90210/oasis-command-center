/**
 * lib/os/customers/stripe-sync.ts — turn the Stripe customers already in
 * OASIS's books into OASIS client records, when a founder asks.
 *
 * Runs ONLY from the founder-clicked "Import Stripe customers" button
 * (POST /api/clients/import-stripe), which also requires the founder to
 * confirm the privacy question first: Stripe subscribers can be private
 * individuals, and Quebec's Law 25 applies to recording them. Nothing calls it
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
 * otherwise "churned" (Past).
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
import { createCustomer, updateCustomer } from "@/lib/os/customers/store";

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
};

/**
 * One group per Stripe customer. The name and email are the most recent
 * non-empty values any of its rows carries (subscriptions first, then
 * payments), exactly as Stripe sent them.
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
  const groups = new Map<string, StripeCustomerGroup & { active: boolean }>();
  const touch = (r: Row) => {
    const id = String(r.stripe_customer_id);
    const g = groups.get(id) ?? { stripe_customer_id: id, name: null, email: null, lifecycle: "churned" as CustomerLifecycle, active: false };
    // Rows arrive newest first, so the first non-empty value wins.
    g.name = g.name ?? clean(r.customer_name);
    g.email = g.email ?? normalizeEmail(r.customer_email);
    groups.set(id, g);
    return g;
  };
  for (const r of rows(subs)) {
    const g = touch(r);
    if (MRR_STATUSES.has(String(r.status ?? ""))) g.active = true;
  }
  for (const r of rows(pays)) touch(r);
  return [...groups.values()]
    .map(({ active, ...g }) => ({ ...g, lifecycle: (active ? "active" : "churned") as CustomerLifecycle }))
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
  return groups.map((group): ImportPlanItem => {
    const have = byStripe.get(group.stripe_customer_id);
    if (have) return { action: "skip", group, reason: "already_a_client", customerId: have };
    if (!group.name && !group.email) return { action: "skip", group, reason: "no_name_or_email" };
    const sameEmail = group.email ? byEmail.get(group.email) : undefined;
    if (sameEmail) {
      return sameEmail.stripe
        ? { action: "conflict", group, customerId: sameEmail.id }
        : { action: "link", group, customerId: sameEmail.id };
    }
    return { action: "create", group };
  });
}

export type ImportResult = {
  created: string[];
  linked: string[];
  skipped: number;
  conflicts: Array<{ stripe_customer_id: string; customerId: string | null }>;
};

/**
 * Carry the plan out. Each record goes through the customers store, so it is
 * tenant-scoped, unique-index guarded and ledgered (customer.created, origin
 * "import") like any other. A record that raced in between the plan and the
 * write is reported as a conflict, never overwritten.
 */
export async function runStripeImport(db: Client, tenantId: string, actor: string | null, now: Date): Promise<ImportResult> {
  const plan = await planStripeImport(db, tenantId);
  const out: ImportResult = { created: [], linked: [], skipped: 0, conflicts: [] };
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
    if (item.action === "link") {
      const r = await updateCustomer(db, tenantId, item.customerId, { stripe_customer_id: g.stripe_customer_id }, now, actor);
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
