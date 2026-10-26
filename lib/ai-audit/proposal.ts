/**
 * lib/ai-audit/proposal.ts — section 8 of the audit: the priced proposal.
 *
 * WHERE A PRICE MAY COME FROM. Exactly two places:
 *   - a catalogue item CC confirmed (kind "catalogue"): the server copies its
 *     name, unit and price from the confirmed row, whatever the browser sent;
 *   - a price CC typed for a custom line (kind "owner_set"): the server stamps
 *     who set it and when from the session.
 * Anything else is "needs_owner_price": a line with no amount, which blocks
 * submission until CC prices it. A model never writes a price (the brief:
 * "prepare a draft for my approval rather than inventing fees").
 *
 * TOTALS are computed here, never typed: subtotal of the required one-time
 * lines, tax from the workspace's tax rule, the total, and what is due now
 * (all of it, or the deposit). Monthly lines and optional add-ons are shown
 * beside the total, not in it. Version 1 collects the one-time fee or the
 * deposit; monthly billing starts after launch.
 *
 * PURE: the builder shows the same totals and blockers as the server enforces.
 */
import {
  CATALOGUE_CATEGORIES,
  CATALOGUE_UNITS,
  CURRENCIES,
  isOneOf,
  type CatalogueCategory,
  type CatalogueUnit,
  type Currency,
} from "@/lib/ai-audit/rules";
import { PRICE_MAX_CENTS } from "@/lib/ai-audit/catalogue";
import { EMAIL_RE } from "@/lib/ai-audit/delivery-payload";

export const PROPOSAL_SCHEMA = "ai_audit_proposal/v1" as const;
export const AUDIT_LINK_PLACEHOLDER = "{{audit_link}}";

type LineBase = {
  line_id: string;
  name: string;
  description: string;
  category: CatalogueCategory;
  unit: CatalogueUnit;
  unit_label?: string;
  quantity: number;
  /** Shown as an optional add-on, outside the total. */
  optional: boolean;
  deliverables: string[];
  onboarding_requirements: string[];
};

export type CatalogueLine = LineBase & {
  kind: "catalogue";
  sku: string;
  item_id: string;
  item_version: number;
  unit_price_cents: number;
  currency: Currency;
};

export type OwnerSetLine = LineBase & {
  kind: "owner_set";
  unit_price_cents: number;
  set_by: string;
  set_at: string;
};

export type NeedsPriceLine = LineBase & {
  kind: "needs_owner_price";
  suggested_sku?: string;
};

export type ProposalLine = CatalogueLine | OwnerSetLine | NeedsPriceLine;

export type TaxRule =
  | { mode: "not_registered" }
  | { mode: "registered"; rate_bps: number; label: string; number?: string };

export type PaymentTerms =
  | { kind: "full" }
  | { kind: "deposit"; deposit_bps: number; balance_due: string };

export type DeliveryEmail = { to: string; subject: string; body: string };

export type ProposalContent = {
  schema: typeof PROPOSAL_SCHEMA;
  currency: Currency;
  lines: ProposalLine[];
  phases: Array<{ name: string; description: string; line_ids: string[] }>;
  payment_terms: PaymentTerms;
  /** Copied from the workspace's tax rule when the draft is saved; null until CC sets one. */
  tax: TaxRule | null;
  exclusions: string[];
  terms: string[];
  /** ISO date (YYYY-MM-DD). */
  valid_until: string;
  delivery_email: DeliveryEmail;
};

export type ProposalTotals = {
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  due_now_cents: number;
  monthly_cents: number;
  optional_cents: number;
};

const LINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function emptyProposal(input: { currency: Currency; tax: TaxRule | null; to: string; businessName: string; contactName: string; validUntil: string }): ProposalContent {
  const greeting = input.contactName ? `Hi ${input.contactName.split(/\s+/)[0]},` : "Hi,";
  return {
    schema: PROPOSAL_SCHEMA,
    currency: input.currency,
    lines: [],
    phases: [],
    payment_terms: { kind: "full" },
    tax: input.tax,
    exclusions: [],
    terms: [],
    valid_until: input.validUntil,
    delivery_email: {
      to: input.to,
      subject: `Your free AI audit for ${input.businessName}`,
      body: `${greeting}\n\nThank you for walking me through ${input.businessName}. Your free AI audit is ready. It covers what we found, why it matters, and what we would build, with a proposal at the end.\n\n${AUDIT_LINK_PLACEHOLDER}\n\nThe link is private to you. Take your time with it, and reply here with any questions.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

function lineAmount(l: ProposalLine): number {
  return l.kind === "needs_owner_price" ? 0 : l.unit_price_cents * l.quantity;
}

export function proposalTotals(p: ProposalContent): ProposalTotals {
  let subtotal = 0;
  let monthly = 0;
  let optional = 0;
  for (const l of p.lines) {
    const amount = lineAmount(l);
    if (l.optional) optional += amount;
    else if (l.unit === "per_month") monthly += amount;
    else subtotal += amount;
  }
  const tax = p.tax && p.tax.mode === "registered" ? Math.round((subtotal * p.tax.rate_bps) / 10_000) : 0;
  const total = subtotal + tax;
  const dueNow = p.payment_terms.kind === "deposit" ? Math.round((total * p.payment_terms.deposit_bps) / 10_000) : total;
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: total, due_now_cents: dueNow, monthly_cents: monthly, optional_cents: optional };
}

// ---------------------------------------------------------------------------
// Validation (shape). Prices on catalogue lines are re-derived by the server.
// ---------------------------------------------------------------------------

type V<T> = { ok: true; value: T } | { ok: false; field: string; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function txt(v: unknown, field: string, max: number, required = true): V<string> {
  if (v === undefined || v === null || v === "") return required ? { ok: false, field, error: "required" } : { ok: true, value: "" };
  if (typeof v !== "string") return { ok: false, field, error: "must be text" };
  const s = v.replace(/\r\n/g, "\n").trim();
  if (required && !s) return { ok: false, field, error: "required" };
  if (s.length > max) return { ok: false, field, error: `longer than ${max} characters` };
  return { ok: true, value: s };
}

function txtList(v: unknown, field: string, maxItems: number, maxLen: number): V<string[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : null;
  if (!raw) return { ok: false, field, error: "must be a list" };
  const out = raw.map((x) => String(x ?? "").trim()).filter(Boolean);
  if (out.length > maxItems) return { ok: false, field, error: `more than ${maxItems} entries` };
  if (out.some((x) => x.length > maxLen)) return { ok: false, field, error: `an entry is longer than ${maxLen} characters` };
  return { ok: true, value: out };
}

function cents(v: unknown, field: string): V<number> {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0 || n > PRICE_MAX_CENTS) return { ok: false, field, error: "must be a whole number of cents above zero" };
  return { ok: true, value: n };
}

export function validateTaxRule(raw: unknown): V<TaxRule> {
  if (!isObj(raw)) return { ok: false, field: "tax", error: "required" };
  if (raw.mode === "not_registered") return { ok: true, value: { mode: "not_registered" } };
  if (raw.mode !== "registered") return { ok: false, field: "tax.mode", error: "registered or not_registered" };
  const bps = Number(raw.rate_bps);
  if (!Number.isInteger(bps) || bps < 1 || bps > 2_500) return { ok: false, field: "tax.rate_bps", error: "a rate between 0.01% and 25%" };
  const label = txt(raw.label, "tax.label", 20);
  if (!label.ok) return label;
  const number = txt(raw.number, "tax.number", 40, false);
  if (!number.ok) return number;
  return { ok: true, value: { mode: "registered", rate_bps: bps, label: label.value, ...(number.value ? { number: number.value } : {}) } };
}

/**
 * The proposal as the browser sent it, checked for shape. Catalogue lines keep
 * only their item reference and quantity here; normalizeProposalLines (store)
 * fills in the confirmed price. Owner-set lines keep their price; the server
 * stamps set_by / set_at.
 */
export function validateProposalContent(raw: unknown): V<ProposalContent> {
  if (!isObj(raw)) return { ok: false, field: "", error: "not a proposal" };
  if (raw.schema !== PROPOSAL_SCHEMA) return { ok: false, field: "schema", error: `must be ${PROPOSAL_SCHEMA}` };
  if (!isOneOf(CURRENCIES, raw.currency)) return { ok: false, field: "currency", error: "CAD or USD" };
  const currency = raw.currency;
  if (!Array.isArray(raw.lines) || raw.lines.length > 30) return { ok: false, field: "lines", error: "a list of at most 30 lines" };
  const lines: ProposalLine[] = [];
  const seen = new Set<string>();
  for (const [i, x] of raw.lines.entries()) {
    const f = `lines[${i}]`;
    if (!isObj(x)) return { ok: false, field: f, error: "not a line" };
    const lineId = typeof x.line_id === "string" ? x.line_id.trim() : "";
    if (!LINE_ID_RE.test(lineId) || seen.has(lineId)) return { ok: false, field: `${f}.line_id`, error: "missing or repeated" };
    seen.add(lineId);
    const name = txt(x.name, `${f}.name`, 120);
    if (!name.ok) return name;
    const description = txt(x.description, `${f}.description`, 1_000, false);
    if (!description.ok) return description;
    if (!isOneOf(CATALOGUE_CATEGORIES, x.category)) return { ok: false, field: `${f}.category`, error: "unknown category" };
    if (!isOneOf(CATALOGUE_UNITS, x.unit)) return { ok: false, field: `${f}.unit`, error: "unknown unit" };
    const unitLabel = txt(x.unit_label, `${f}.unit_label`, 40, false);
    if (!unitLabel.ok) return unitLabel;
    const quantity = Number(x.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000) return { ok: false, field: `${f}.quantity`, error: "a whole number from 1 to 1000" };
    const deliverables = txtList(x.deliverables, `${f}.deliverables`, 20, 300);
    if (!deliverables.ok) return deliverables;
    const requirements = txtList(x.onboarding_requirements, `${f}.onboarding_requirements`, 20, 300);
    if (!requirements.ok) return requirements;
    const base: LineBase = {
      line_id: lineId,
      name: name.value,
      description: description.value,
      category: x.category,
      unit: x.unit,
      ...(unitLabel.value ? { unit_label: unitLabel.value } : {}),
      quantity,
      optional: x.optional === true,
      deliverables: deliverables.value,
      onboarding_requirements: requirements.value,
    };
    if (x.kind === "catalogue") {
      const itemId = typeof x.item_id === "string" ? x.item_id.trim() : "";
      if (!itemId || itemId.length > 64) return { ok: false, field: `${f}.item_id`, error: "required" };
      const sku = typeof x.sku === "string" ? x.sku.trim() : "";
      const version = Number(x.item_version);
      const price = Number.isSafeInteger(Number(x.unit_price_cents)) ? Number(x.unit_price_cents) : 0;
      // The line's own currency is kept (the server set it from the catalogue item); rewriting it to
      // the proposal's on every read hid a mismatch and broke the hash Gate 2 binds (review of PR #732).
      const lineCurrency = x.currency === "CAD" || x.currency === "USD" ? x.currency : currency;
      lines.push({ ...base, kind: "catalogue", sku, item_id: itemId, item_version: Number.isInteger(version) ? version : 0, unit_price_cents: price, currency: lineCurrency });
    } else if (x.kind === "owner_set") {
      const price = cents(x.unit_price_cents, `${f}.unit_price_cents`);
      if (!price.ok) return price;
      const setBy = typeof x.set_by === "string" ? x.set_by : "";
      const setAt = typeof x.set_at === "string" ? x.set_at : "";
      lines.push({ ...base, kind: "owner_set", unit_price_cents: price.value, set_by: setBy, set_at: setAt });
    } else if (x.kind === "needs_owner_price") {
      const suggested = typeof x.suggested_sku === "string" && x.suggested_sku.trim() ? x.suggested_sku.trim().slice(0, 48) : undefined;
      lines.push({ ...base, kind: "needs_owner_price", ...(suggested ? { suggested_sku: suggested } : {}) });
    } else {
      return { ok: false, field: `${f}.kind`, error: "catalogue, owner_set or needs_owner_price" };
    }
  }
  if (!Array.isArray(raw.phases ?? []) || (raw.phases as unknown[] | undefined ?? []).length > 10) return { ok: false, field: "phases", error: "at most 10 phases" };
  const phases: ProposalContent["phases"] = [];
  for (const [i, x] of ((raw.phases as unknown[] | undefined) ?? []).entries()) {
    if (!isObj(x)) return { ok: false, field: `phases[${i}]`, error: "not a phase" };
    const name = txt(x.name, `phases[${i}].name`, 120);
    if (!name.ok) return name;
    const description = txt(x.description, `phases[${i}].description`, 1_000, false);
    if (!description.ok) return description;
    const ids = Array.isArray(x.line_ids) ? x.line_ids.filter((y): y is string => typeof y === "string" && seen.has(y)) : [];
    phases.push({ name: name.value, description: description.value, line_ids: [...new Set(ids)] });
  }
  let terms: PaymentTerms = { kind: "full" };
  if (isObj(raw.payment_terms) && raw.payment_terms.kind === "deposit") {
    const bps = Number(raw.payment_terms.deposit_bps);
    if (!Number.isInteger(bps) || bps < 1_000 || bps > 9_000) return { ok: false, field: "payment_terms.deposit_bps", error: "a deposit between 10% and 90%" };
    const due = txt(raw.payment_terms.balance_due, "payment_terms.balance_due", 200);
    if (!due.ok) return due;
    terms = { kind: "deposit", deposit_bps: bps, balance_due: due.value };
  } else if (!isObj(raw.payment_terms) || raw.payment_terms.kind !== "full") {
    return { ok: false, field: "payment_terms", error: "full or deposit" };
  }
  let tax: TaxRule | null = null;
  if (raw.tax !== null && raw.tax !== undefined) {
    const t = validateTaxRule(raw.tax);
    if (!t.ok) return t;
    tax = t.value;
  }
  const exclusions = txtList(raw.exclusions, "exclusions", 20, 500);
  if (!exclusions.ok) return exclusions;
  const extraTerms = txtList(raw.terms, "terms", 20, 500);
  if (!extraTerms.ok) return extraTerms;
  const validUntil = typeof raw.valid_until === "string" ? raw.valid_until.trim() : "";
  if (!DATE_RE.test(validUntil)) return { ok: false, field: "valid_until", error: "a date" };
  if (!isObj(raw.delivery_email)) return { ok: false, field: "delivery_email", error: "required" };
  const to = typeof raw.delivery_email.to === "string" ? raw.delivery_email.to.trim().toLowerCase() : "";
  const subject = txt(raw.delivery_email.subject, "delivery_email.subject", 200, false);
  if (!subject.ok) return subject;
  if (/[\r\n]/.test(subject.value)) return { ok: false, field: "delivery_email.subject", error: "one line" };
  const body = txt(raw.delivery_email.body, "delivery_email.body", 10_000, false);
  if (!body.ok) return body;
  return {
    ok: true,
    value: {
      schema: PROPOSAL_SCHEMA,
      currency,
      lines,
      phases,
      payment_terms: terms,
      tax,
      exclusions: exclusions.value,
      terms: extraTerms.value,
      valid_until: validUntil,
      delivery_email: { to, subject: subject.value, body: body.value },
    },
  };
}

/**
 * Everything that stops this proposal from going to CC's final approval.
 * `today` is a YYYY-MM-DD date. Catalogue lines are checked against the live
 * catalogue by the server (store.ts) as well.
 */
export function proposalBlockers(p: ProposalContent, today: string): string[] {
  const out: string[] = [];
  const priced = p.lines.filter((l) => l.kind !== "needs_owner_price");
  const unpriced = p.lines.filter((l) => l.kind === "needs_owner_price");
  for (const l of unpriced) out.push(`"${l.name}" needs your price (or a confirmed catalogue item).`);
  if (!p.lines.some((l) => !l.optional && l.unit !== "per_month" && l.kind !== "needs_owner_price")) {
    out.push("There is no one-time item to pay for. Add the implementation work.");
  }
  for (const l of priced) {
    if (l.kind === "catalogue" && l.currency !== p.currency) out.push(`"${l.name}" is priced in ${l.currency}, not ${p.currency}.`);
    if (l.kind === "catalogue" && (!l.unit_price_cents || l.item_version < 1)) out.push(`"${l.name}" is not a confirmed catalogue item.`);
    if (l.kind === "owner_set" && (!l.set_by || !l.set_at)) out.push(`"${l.name}" has a price nobody stamped. Set it again.`);
  }
  if (!p.tax) out.push("Set the tax rule in AI audit settings first (registered or not, and the rate).");
  const totals = proposalTotals(p);
  if (totals.due_now_cents <= 0) out.push("Nothing would be due now.");
  if (p.valid_until < today) out.push("The proposal's valid-until date has passed.");
  if (!EMAIL_RE.test(p.delivery_email.to)) out.push("The delivery email has no valid recipient.");
  if (!p.delivery_email.subject) out.push("The delivery email has no subject.");
  const placeholders = p.delivery_email.body.split(AUDIT_LINK_PLACEHOLDER).length - 1;
  if (placeholders !== 1) out.push(`The delivery email must contain ${AUDIT_LINK_PLACEHOLDER} exactly once (where the private link goes).`);
  return out;
}
