/**
 * /founders/finances/settings — legal identity, GST/QST registration,
 * invoice numbering, the Stripe account pin + reconcile, FX refresh, rules.
 */
import { Card, PageHeader, Tag } from "@/components/Card";
import { EntitySwitcher } from "@/components/founders/finances/EntitySwitcher";
import { ActionForm } from "@/components/founders/finances/ActionForm";
import { ActionButton } from "@/components/founders/finances/ActionButton";
import { tableClass, tdClass } from "@/components/founders/finances/ui";
import { financePage, type SearchParams } from "@/lib/founders-finances/page-context";
import { loadSettings } from "@/lib/founders-finances/settings-io";
import { stripeConnectionStatus } from "@/lib/founders-finances/stripe-io";
import { listRules } from "@/lib/founders-finances/transactions-io";
import { entityCategories } from "@/lib/founders-finances/access-io";
import { queryOne } from "@/lib/founders-finances/db";

export const dynamic = "force-dynamic";

export default async function FinanceSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { viewer, entity, entities } = await financePage(searchParams);
  const business = entity.kind === "business";
  const [s, rules, categories, stripe, lastFx, lastEvent] = await Promise.all([
    loadSettings(entity.id),
    listRules(viewer, entity.slug),
    entityCategories(entity.id),
    business ? stripeConnectionStatus() : Promise.resolve(null),
    business ? queryOne<{ d: string | null }>(`SELECT MAX(rate_date) AS d FROM fin_fx_rates`) : Promise.resolve(null),
    business ? queryOne<{ at: string | null; n: number }>(`SELECT MAX(received_at) AS at, COUNT(*) AS n FROM fin_stripe_events`) : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader title="Settings" action={<EntitySwitcher entities={entities} current={entity.slug} basePath="/founders/finances/settings" />} />

      <Card title={business ? "Company & invoicing" : "Book details"} subtitle={business ? "Printed on every invoice." : undefined}>
        <ActionForm
          action="settings.update"
          hidden={{ entity: entity.slug }}
          submitLabel="Save"
          resetOnSuccess={false}
          columns={3}
          fields={[
            { name: "legal_name", label: "Legal name", defaultValue: s.legal_name, required: true },
            { name: "contact_email", label: "Contact email", type: "email", defaultValue: s.contact_email },
            { name: "address_line1", label: "Street", defaultValue: s.address_line1 },
            { name: "address_line2", label: "Suite / unit", defaultValue: s.address_line2 },
            { name: "city", label: "City", defaultValue: s.city },
            { name: "region", label: "Province", defaultValue: s.region },
            { name: "postal_code", label: "Postal code", defaultValue: s.postal_code },
            { name: "country", label: "Country", defaultValue: s.country },
            ...(business
              ? [
                  { name: "invoice_prefix", label: "Invoice prefix", defaultValue: s.invoice_prefix, hint: `Next: ${s.invoice_prefix}-${s.invoice_number_year ?? new Date().getFullYear()}-${String(s.invoice_number_year ? s.invoice_next_number : 1).padStart(4, "0")}` },
                  { name: "invoice_next_number", label: "Next number", type: "number" as const, defaultValue: String(s.invoice_next_number), hint: "Resets to 1 each new year." },
                  { name: "payment_terms_days", label: "Payment terms (days)", type: "number" as const, defaultValue: String(s.payment_terms_days) },
                  { name: "payment_instructions", label: "Payment instructions (printed on invoices)", type: "textarea" as const, defaultValue: s.payment_instructions, span: 3 as const, placeholder: "Interac e-Transfer to billing@… · Wire details on request" },
                  { name: "gst_qst_registered", label: "Registered for GST/QST", type: "checkbox" as const, defaultValue: s.gst_qst_registered === 1 },
                  { name: "gst_number", label: "GST/HST number", defaultValue: s.gst_number, placeholder: "123456789RT0001" },
                  { name: "qst_number", label: "QST number", defaultValue: s.qst_number, placeholder: "1234567890TQ0001" },
                  { name: "registration_effective_date", label: "Registered since", type: "date" as const, defaultValue: s.registration_effective_date || "" },
                ]
              : []),
          ]}
        />
      </Card>

      {business && stripe && (
        <Card title="Stripe" subtitle="OASIS's own Stripe account only. Finances refuses to create payment links or backfill until the account below is confirmed.">
          <div className="space-y-3 text-sm">
            {!stripe.keyPresent ? (
              <p className="text-status-warm">No Stripe secret key is configured for the founders&rsquo; workspace. Card payment links and reconcile are unavailable; the webhook can still record events.</p>
            ) : stripe.error ? (
              <p className="text-status-hot">Stripe did not answer: {stripe.error}</p>
            ) : (
              <p>
                The configured key belongs to <span className="font-mono">{stripe.accountId}</span>
                {stripe.accountName && <> ({stripe.accountName})</>}.{" "}
                {stripe.ready ? <Tag tone="engaged">confirmed</Tag> : stripe.pinned ? <Tag tone="hot">does not match pinned {stripe.pinned}</Tag> : <Tag tone="warm">not confirmed</Tag>}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {stripe.accountId && !stripe.ready && (
                <ActionButton
                  action="stripe.pin"
                  payload={{ entity: entity.slug, account_id: stripe.accountId }}
                  label={`This is OASIS's account — confirm ${stripe.accountId}`}
                  tone="primary"
                  confirm={`Confirm ${stripe.accountId}${stripe.accountName ? ` (${stripe.accountName})` : ""} is OASIS AI Solutions' own Stripe account — not Trytan's, PropFlow's or the store's?`}
                />
              )}
              {stripe.ready && <ActionButton action="stripe.reconcile" payload={{ days: 30 }} label="Reconcile last 30 days" />}
              {stripe.ready && <ActionButton action="stripe.reconcile" payload={{ days: 365 }} label="Backfill a year" confirm="Pull a year of payments, refunds and subscriptions from Stripe? Safe to repeat." />}
            </div>
            <p className="text-xs text-fg-dim">
              Webhook endpoint: <span className="font-mono">/api/webhooks/stripe-finance</span> · events received: {lastEvent?.n ?? 0}
              {lastEvent?.at && <> · last {lastEvent.at.slice(0, 16).replace("T", " ")} UTC</>}
            </p>
          </div>
        </Card>
      )}

      {business && (
        <Card title="Exchange rates" subtitle="Bank of Canada daily USD/CAD. Each payment converts at its own day's rate.">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-fg-muted">Latest stored rate: {lastFx?.d || "none yet"}</span>
            <ActionButton action="fx.refresh" payload={{}} label="Fetch last 30 days" />
          </div>
        </Card>
      )}

      <Card title="Categorisation rules" subtitle="First matching rule (lowest priority number) sets the category on import. Seeded: Stripe payouts are transfers, not revenue.">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <table className={tableClass}>
            <tbody>
              {rules.length === 0 && (
                <tr>
                  <td className={`${tdClass} text-fg-muted`}>No rules yet.</td>
                </tr>
              )}
              {rules.map((r) => (
                <tr key={r.id} className={r.active ? "" : "opacity-50"}>
                  <td className={tdClass}>
                    <div>
                      {r.match_type.replace("_", " ")} &ldquo;{r.pattern}&rdquo; <span className="text-fg-dim">({r.direction})</span>
                    </div>
                    <div className="text-[11px] text-fg-dim">
                      → {r.category_name} · priority {r.priority}
                    </div>
                  </td>
                  <td className={`${tdClass} text-right`}>
                    <ActionButton action="rule.toggle" payload={{ rule_id: r.id, active: !r.active }} label={r.active ? "Disable" : "Enable"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="space-y-4">
            <ActionForm
              action="rule.create"
              hidden={{ entity: entity.slug }}
              submitLabel="Add rule"
              columns={2}
              fields={[
                { name: "pattern", label: "Description contains", required: true, placeholder: "figma" },
                { name: "category_id", label: "Category", type: "select", required: true, options: categories.map((c) => ({ value: c.id, label: `${c.name} (${c.kind})` })) },
                { name: "direction", label: "Direction", type: "select", options: [{ value: "any", label: "In or out" }, { value: "out", label: "Money out" }, { value: "in", label: "Money in" }] },
                { name: "match_type", label: "Match", type: "select", options: [{ value: "contains", label: "contains" }, { value: "starts_with", label: "starts with" }, { value: "equals", label: "equals" }] },
                { name: "priority", label: "Priority", type: "number", defaultValue: "100" },
              ]}
            />
            <ActionButton action="rules.apply" payload={{ entity: entity.slug }} label="Apply rules to unreviewed transactions" />
          </div>
        </div>
      </Card>
    </div>
  );
}
