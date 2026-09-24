/**
 * Per-entity settings: legal identity, GST/QST registration, invoice
 * numbering, payment instructions and the pinned Stripe account.
 */
import "server-only";

import { validateRegistration } from "./tax";
import { sanitizePrefix } from "./invoice";
import { isIsoDate } from "./fx";
import { auditStatement, queryOne, writeBatch } from "./db";
import { requireEntity, FinanceInputError } from "./access-io";
import { viewerLabel, type FinanceViewer } from "./access";
import { stripeConnectionStatus } from "./stripe-io";
import { validateEmail } from "./validation";

export type SettingsRow = {
  entity_id: string;
  legal_name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  contact_email: string;
  gst_qst_registered: number;
  gst_number: string;
  qst_number: string;
  registration_effective_date: string | null;
  invoice_prefix: string;
  invoice_next_number: number;
  invoice_number_year: number | null;
  payment_terms_days: number;
  payment_instructions: string;
  stripe_account_id: string | null;
  updated_at: string;
  updated_by: string | null;
};

export async function loadSettings(entityId: string): Promise<SettingsRow> {
  const row = await queryOne<SettingsRow>(`SELECT * FROM fin_settings WHERE entity_id = ?`, [entityId]);
  if (!row) throw new Error(`settings missing for ${entityId}; seed has not run`);
  return row;
}

export function addressLines(s: SettingsRow): string[] {
  const cityLine = [s.city, s.region].filter(Boolean).join(", ") + (s.postal_code ? `  ${s.postal_code}` : "");
  return [s.address_line1, s.address_line2, cityLine.trim(), s.country].filter((l) => l && l.trim());
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function updateSettings(viewer: FinanceViewer, entityRef: string, raw: Record<string, unknown>): Promise<SettingsRow> {
  const entity = await requireEntity(viewer, entityRef);
  const cur = await loadSettings(entity.id);
  const registered = raw.gst_qst_registered === true || raw.gst_qst_registered === "true" || raw.gst_qst_registered === "on";
  const reg = validateRegistration({
    registered,
    gstNumber: text(raw.gst_number ?? cur.gst_number, 40),
    qstNumber: text(raw.qst_number ?? cur.qst_number, 40),
  });
  if (!reg.ok) throw new FinanceInputError(reg.error);
  if (registered && entity.kind !== "business") throw new FinanceInputError("only the business can be GST/QST registered");
  const effective = text(raw.registration_effective_date, 10) || null;
  if (effective && !isIsoDate(effective)) throw new FinanceInputError("registration date must be YYYY-MM-DD");
  const email = raw.contact_email === undefined ? cur.contact_email : text(raw.contact_email, 254);
  if (email && !validateEmail(email)) throw new FinanceInputError("contact email is not valid");
  const terms = raw.payment_terms_days === undefined ? cur.payment_terms_days : Number(raw.payment_terms_days);
  if (!Number.isInteger(terms) || terms < 0 || terms > 365) throw new FinanceInputError("payment terms must be 0-365 days");
  const nextNumber = raw.invoice_next_number === undefined || raw.invoice_next_number === "" ? cur.invoice_next_number : Number(raw.invoice_next_number);
  if (!Number.isInteger(nextNumber) || nextNumber < 1) throw new FinanceInputError("next invoice number must be a positive integer");
  const legalName = raw.legal_name === undefined ? cur.legal_name : text(raw.legal_name, 200);
  if (!legalName) throw new FinanceInputError("legal name is required");
  const pick = (k: keyof SettingsRow, max: number) => (raw[k] === undefined ? (cur[k] as string) : text(raw[k], max));
  await writeBatch([
    {
      sql: `UPDATE fin_settings SET legal_name = ?, address_line1 = ?, address_line2 = ?, city = ?, region = ?, postal_code = ?,
                   country = ?, contact_email = ?, gst_qst_registered = ?, gst_number = ?, qst_number = ?,
                   registration_effective_date = ?, invoice_prefix = ?, invoice_next_number = ?, payment_terms_days = ?,
                   payment_instructions = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?
             WHERE entity_id = ?`,
      args: [
        legalName,
        pick("address_line1", 200),
        pick("address_line2", 200),
        pick("city", 100),
        pick("region", 50),
        pick("postal_code", 20),
        pick("country", 60) || "Canada",
        email,
        registered ? 1 : 0,
        reg.gstNumber,
        reg.qstNumber,
        effective,
        raw.invoice_prefix === undefined ? cur.invoice_prefix : sanitizePrefix(text(raw.invoice_prefix, 20)),
        nextNumber,
        terms,
        raw.payment_instructions === undefined ? cur.payment_instructions : text(raw.payment_instructions, 1000),
        viewerLabel(viewer),
        entity.id,
      ],
    },
    auditStatement({
      entityId: entity.id,
      actor: viewerLabel(viewer),
      action: "settings.updated",
      objectType: "settings",
      objectId: entity.id,
      detail: { registered, registration_changed: registered !== (cur.gst_qst_registered === 1) },
    }),
  ]);
  return loadSettings(entity.id);
}

/**
 * Pin the Stripe account the configured key belongs to. The founder confirms
 * the account id Stripe itself reported — this call re-reads it rather than
 * trusting a value from the browser.
 */
export async function pinStripeAccount(viewer: FinanceViewer, entityRef: string, confirmAccountId: string): Promise<string> {
  const entity = await requireEntity(viewer, entityRef);
  if (entity.kind !== "business") throw new FinanceInputError("only the business book uses Stripe");
  const status = await stripeConnectionStatus();
  if (!status.accountId) throw new FinanceInputError(status.error || "no Stripe account is reachable with the configured key");
  if (status.accountId !== confirmAccountId) {
    throw new FinanceInputError("the Stripe key now belongs to a different account than the one you confirmed; reload and check again");
  }
  await writeBatch([
    { sql: `UPDATE fin_settings SET stripe_account_id = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_id = ?`, args: [status.accountId, viewerLabel(viewer), entity.id] },
    auditStatement({ entityId: entity.id, actor: viewerLabel(viewer), action: "stripe.account_pinned", objectType: "settings", objectId: entity.id, detail: { account: status.accountId } }),
  ]);
  return status.accountId;
}
