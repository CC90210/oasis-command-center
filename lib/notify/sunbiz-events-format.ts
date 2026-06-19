import { escapeTelegramHtml } from "@/lib/notify/telegram-format";

/**
 * Pure formatters for SunBiz application-event Telegram alerts (Batch 4).
 * Kept separate from sunbiz-events.ts (which is server-only) so they're
 * unit-testable — same split as telegram.ts / telegram-format.ts.
 */

export type SunbizEventKind = "first_application" | "second_application" | "bank_statements";

/** Mask a tax id / SSN to the last 4 digits. */
export function maskTaxId(v: unknown): string {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length < 4) return "—";
  return `••••${digits.slice(-4)}`;
}

const esc = (v: unknown): string => {
  const s = String(v ?? "").trim();
  return s ? escapeTelegramHtml(s) : "—";
};

/** Build the Telegram HTML for an event. `d` is a flat field bag (lead contact +
 *  event-specific extras). Missing fields render "—", never a broken line.
 *  All untrusted values are HTML-escaped; tax id is masked. */
export function buildSunbizEventMessage(kind: SunbizEventKind, d: Record<string, unknown>): string {
  const merchant = esc(d.contact_name || d.owner_full_name || d.name);
  const business = esc(d.business_name || d.business_legal_name || d.company || d.dba);
  const phone = esc(d.phone || d.owner_cell);
  const email = esc(d.email);
  if (kind === "first_application") {
    return [
      "🟢 <b>FIRST APPLICATION SUBMITTED</b>",
      `Merchant: ${merchant}`,
      `Business: ${business}`,
      `Phone: ${phone}`,
      `Email: ${email}`,
    ].join("\n");
  }
  if (kind === "second_application") {
    return [
      "🟡 <b>SECOND APPLICATION SUBMITTED</b>",
      `Merchant: ${merchant}`,
      `Company/DBA: ${business}`,
      `Phone: ${phone}`,
      `Email: ${email}`,
      `Entity type: ${esc(d.entity_type)}`,
      `Tax ID: ${maskTaxId(d.tax_id ?? d.ein ?? d.business_ein ?? d.owner_ssn)}`,
      `Monthly revenue: ${esc(d.monthly_revenue)}`,
      `Requested advance: ${esc(d.requested_advance ?? d.requested_amount)}`,
    ].join("\n");
  }
  return [
    "🔵 <b>BANK STATEMENTS UPLOADED</b>",
    `Merchant: ${merchant}`,
    `Business: ${business}`,
    `Email: ${email}`,
    `Files: ${esc(d.file_count)}`,
    `Stage: ${esc(d.stage)}`,
  ].join("\n");
}
