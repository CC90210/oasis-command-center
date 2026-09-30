/**
 * lib/os/customers/rules.ts — every rule the Clients module follows.
 *
 * "Clients" is the business's OWN customers (docs/os-revamp/PLAN.md decision 5,
 * D7: the UI label "Clients" maps to the DB entity `customer`). A row belongs to
 * exactly one workspace (tenant_id), and nothing here knows about OASIS.
 *
 * PURE: no database, no session, no env, no next/* import, so
 * tests/os-customers.test.ts pins all of it in a bare node process.
 *
 * The allowed values here are the only copy. Migration
 * database/turso/bravo__188_os_customers.sql deliberately has no CHECK
 * constraints on these columns (see its header), so a value that is not in
 * these lists must never reach an INSERT: every write goes through a validate*
 * function below first.
 */
import { normalizePhoneE164 } from "@/lib/conversation-threading";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** Where a client stands with the business (design doc §3.5). */
export const CUSTOMER_LIFECYCLES = ["prospect", "onboarding", "active", "paused", "churned"] as const;
export type CustomerLifecycle = (typeof CUSTOMER_LIFECYCLES)[number];
export const CUSTOMER_LIFECYCLE_LABELS: Record<CustomerLifecycle, string> = {
  prospect: "Prospect",
  onboarding: "Onboarding",
  active: "Active",
  paused: "Paused",
  churned: "Past",
};
/** A new record typed in by hand is a client the business already serves. */
export const DEFAULT_LIFECYCLE: CustomerLifecycle = "active";

/**
 * Lead stages that prove a sale, so the lead may become a client. The OASIS
 * pipeline's won + delivery stages (lib/website-sales-workflow.ts
 * PAID_OR_DELIVERY_STAGES, the same list components/os/landings/clients-model.ts
 * CLIENT_STAGES reads) and the generic template's `won`
 * (lib/manifest/templates.ts). A lead in any other stage has not bought.
 */
export const CONVERTIBLE_LEAD_STAGES = ["won", "onboarding", "in_build", "client_review", "launched"] as const;

/** The lifecycle a converted lead starts in: delivered work is active, the rest is still onboarding. */
export function lifecycleForLeadStage(stage: string | null | undefined): CustomerLifecycle {
  return stage === "launched" ? "active" : "onboarding";
}

export function isConvertibleLeadStage(stage: unknown): boolean {
  return typeof stage === "string" && (CONVERTIBLE_LEAD_STAGES as readonly string[]).includes(stage);
}

export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type Invalid = { ok: false; error: string; field?: string };
export type Valid<T> = { ok: true; value: T };
export type Validation<T> = Valid<T> | Invalid;

export const LIMITS = {
  displayName: 160,
  companyName: 160,
  email: 254,
  phone: 40,
  tag: 40,
  tags: 20,
  contactName: 160,
  contactRole: 80,
  customFieldsBytes: 8_000,
  id: 64,
  search: 120,
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function invalid(error: string, field?: string): Invalid {
  return field ? { ok: false, error, field } : { ok: false, error };
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** Lowercased, trimmed, shaped like an address — or null. */
export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t && t.length <= LIMITS.email && EMAIL_RE.test(t) ? t : null;
}

/**
 * E.164 when the number can be read as one (lib/conversation-threading.ts, the
 * canonical normaliser), otherwise the trimmed text as typed: an international
 * number the normaliser does not recognise is still the client's number, and
 * dropping it would lose data the owner typed.
 */
export function normalizePhone(v: string): string {
  return normalizePhoneE164(v) ?? v.trim();
}

function text(body: Record<string, unknown>, key: string, max: number, required: boolean): Validation<string | null> {
  const v = body[key];
  if (v === undefined || v === null) return required ? invalid(`${key}_required`, key) : { ok: true, value: null };
  if (typeof v !== "string") return invalid(`${key}_invalid`, key);
  const t = v.trim();
  if (!t) return required ? invalid(`${key}_required`, key) : { ok: true, value: null };
  if (t.length > max) return invalid(`${key}_too_long`, key);
  return { ok: true, value: t };
}

function email(body: Record<string, unknown>, key: string): Validation<string | null> {
  const v = body[key];
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return { ok: true, value: null };
  const n = normalizeEmail(v);
  return n ? { ok: true, value: n } : invalid(`${key}_invalid`, key);
}

function phone(body: Record<string, unknown>, key: string): Validation<string | null> {
  const r = text(body, key, LIMITS.phone, false);
  if (!r.ok || r.value === null) return r;
  if (!/\d/.test(r.value)) return invalid(`${key}_invalid`, key);
  return { ok: true, value: normalizePhone(r.value) };
}

function id(body: Record<string, unknown>, key: string): Validation<string | null> {
  const v = body[key];
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  if (typeof v !== "string" || !v.trim() || v.trim().length > LIMITS.id || !/^[A-Za-z0-9_-]+$/.test(v.trim())) {
    return invalid(`${key}_invalid`, key);
  }
  return { ok: true, value: v.trim() };
}

/** Distinct, trimmed, non-empty strings; order kept. */
export function normalizeTags(v: unknown): Validation<string[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  const list = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(list)) return invalid("tags_invalid", "tags");
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") return invalid("tags_invalid", "tags");
    const t = raw.trim();
    if (!t) continue;
    if (t.length > LIMITS.tag) return invalid("tags_too_long", "tags");
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  if (out.length > LIMITS.tags) return invalid("tags_too_many", "tags");
  return { ok: true, value: out };
}

function customFields(v: unknown): Validation<Record<string, unknown>> {
  if (v === undefined || v === null) return { ok: true, value: {} };
  const r = asRecord(v);
  if (!r) return invalid("custom_fields_invalid", "custom_fields");
  if (JSON.stringify(r).length > LIMITS.customFieldsBytes) return invalid("custom_fields_too_long", "custom_fields");
  return { ok: true, value: r };
}

function lifecycle(body: Record<string, unknown>, fallback: CustomerLifecycle | null): Validation<CustomerLifecycle | null> {
  const v = body.lifecycle;
  if (v === undefined || v === null || v === "") return { ok: true, value: fallback };
  return isOneOf(CUSTOMER_LIFECYCLES, v) ? { ok: true, value: v } : invalid("lifecycle_invalid", "lifecycle");
}

export type CustomerInput = {
  display_name: string;
  company_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  lifecycle: CustomerLifecycle;
  /** Validated against the workspace's active members by the caller. */
  owner_user_id: unknown;
  stripe_customer_id: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
};

/**
 * A client typed in by the team. The name may be left blank when a company or
 * an email is given; the record then carries the first of those as its name.
 * `tenant_id`, `source_lead_id` and `created_by` are never read from the body.
 */
export function validateCustomerCreate(raw: unknown): Validation<CustomerInput> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const name = text(b, "display_name", LIMITS.displayName, false);
  if (!name.ok) return name;
  const company = text(b, "company_name", LIMITS.companyName, false);
  if (!company.ok) return company;
  const mail = email(b, "primary_email");
  if (!mail.ok) return mail;
  const tel = phone(b, "primary_phone");
  if (!tel.ok) return tel;
  const life = lifecycle(b, DEFAULT_LIFECYCLE);
  if (!life.ok) return life;
  const stripe = id(b, "stripe_customer_id");
  if (!stripe.ok) return stripe;
  const tags = normalizeTags(b.tags);
  if (!tags.ok) return tags;
  const custom = customFields(b.custom_fields);
  if (!custom.ok) return custom;
  const display = name.value ?? company.value ?? mail.value;
  if (!display) return invalid("display_name_required", "display_name");
  return {
    ok: true,
    value: {
      display_name: display,
      company_name: company.value,
      primary_email: mail.value,
      primary_phone: tel.value,
      lifecycle: life.value as CustomerLifecycle,
      owner_user_id: b.owner_user_id,
      stripe_customer_id: stripe.value,
      tags: tags.value,
      custom_fields: custom.value,
    },
  };
}

export type CustomerPatch = Partial<{
  display_name: string;
  company_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  lifecycle: CustomerLifecycle;
  owner_user_id: unknown;
  stripe_customer_id: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  archived: boolean;
}>;

/** Only the keys present are validated and returned; at least one is required. */
export function validateCustomerPatch(raw: unknown): Validation<CustomerPatch> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const out: CustomerPatch = {};
  const steps: Array<[keyof CustomerPatch & string, () => Validation<unknown>]> = [
    ["display_name", () => text(b, "display_name", LIMITS.displayName, true)],
    ["company_name", () => text(b, "company_name", LIMITS.companyName, false)],
    ["primary_email", () => email(b, "primary_email")],
    ["primary_phone", () => phone(b, "primary_phone")],
    ["lifecycle", () => (b.lifecycle === null || b.lifecycle === "" ? invalid("lifecycle_invalid", "lifecycle") : lifecycle(b, null))],
    ["stripe_customer_id", () => id(b, "stripe_customer_id")],
    ["tags", () => normalizeTags(b.tags)],
    ["custom_fields", () => customFields(b.custom_fields)],
    ["archived", () => (typeof b.archived === "boolean" ? { ok: true, value: b.archived } : invalid("archived_invalid", "archived"))],
  ];
  for (const [key, run] of steps) {
    if (!has(key)) continue;
    const r = run();
    if (!r.ok) return r;
    (out as Record<string, unknown>)[key] = r.value;
  }
  if (has("owner_user_id")) out.owner_user_id = b.owner_user_id;
  if (Object.keys(out).length === 0) return invalid("no_changes");
  return { ok: true, value: out };
}

export type ContactInput = { name: string | null; email: string | null; phone: string | null; role: string | null };

export function validateContactCreate(raw: unknown): Validation<ContactInput> {
  const b = asRecord(raw);
  if (!b) return invalid("body_invalid");
  const name = text(b, "name", LIMITS.contactName, false);
  if (!name.ok) return name;
  const mail = email(b, "email");
  if (!mail.ok) return mail;
  const tel = phone(b, "phone");
  if (!tel.ok) return tel;
  const role = text(b, "role", LIMITS.contactRole, false);
  if (!role.ok) return role;
  if (!name.value && !mail.value && !tel.value) return invalid("contact_empty", "name");
  return { ok: true, value: { name: name.value, email: mail.value, phone: tel.value, role: role.value } };
}

/**
 * Owner assignment: null / "" clears it; anything else must be an ACTIVE
 * member of the workspace (the caller passes the workspace's active roster,
 * lib/team.ts getTenantMembers). Same contract as lib/delivery/rules
 * validateAssignee, so a menu can never offer a person the API refuses.
 */
export function validateOwner(
  raw: unknown,
  roster: ReadonlyArray<{ auth_user_id: string | null; deactivated_at?: string | null }>,
): { ok: true; value: string | null } | { ok: false; error: "owner_invalid" | "owner_not_on_team" } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "owner_invalid" };
  const idv = raw.trim().toLowerCase();
  if (!idv) return { ok: true, value: null };
  const member = roster.find((m) => (m.auth_user_id || "").trim().toLowerCase() === idv);
  if (!member || member.deactivated_at) return { ok: false, error: "owner_not_on_team" };
  return { ok: true, value: idv };
}

// ---------------------------------------------------------------------------
// Converting a won lead
// ---------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * The client record a won lead becomes: company first (a business is the
 * client), then the person, then the address. Only what the lead actually
 * holds is copied; nothing is filled in.
 */
export function customerFromLead(data: Record<string, unknown>): {
  display_name: string;
  company_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  lifecycle: CustomerLifecycle;
} {
  const company = str(data.company) ?? str(data.business_name);
  const person = str(data.name) ?? str(data.contact_name) ?? str(data.owner_name);
  const mail = normalizeEmail(data.email);
  const rawPhone = str(data.phone);
  return {
    display_name: (company ?? person ?? mail ?? "Unnamed client").slice(0, LIMITS.displayName),
    company_name: company ? company.slice(0, LIMITS.companyName) : null,
    primary_email: mail,
    primary_phone: rawPhone && /\d/.test(rawPhone) ? normalizePhone(rawPhone).slice(0, LIMITS.phone) : null,
    lifecycle: lifecycleForLeadStage(str(data.stage)),
  };
}

/** The contact person on a won lead, when the lead names one separate from the company. */
export function contactFromLead(data: Record<string, unknown>): ContactInput | null {
  const company = str(data.company) ?? str(data.business_name);
  const person = str(data.name) ?? str(data.contact_name) ?? str(data.owner_name);
  if (!company || !person || person === company) return null;
  return {
    name: person.slice(0, LIMITS.contactName),
    email: normalizeEmail(data.email),
    phone: null,
    role: null,
  };
}
