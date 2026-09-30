/**
 * lib/ledger/catalog.ts — every event the Business Ledger accepts, as code.
 *
 * One entry per event_key: its version, the department it counts toward, the
 * ONE module allowed to emit it natively, the Python producers allowed to send
 * it through /api/ledger/ingest, the subjects it may be about, the join keys it
 * must carry, and the schema of its payload. lib/ledger/emit.ts refuses
 * anything this file does not describe; nothing is inferred.
 *
 * PAYLOADS ARE IDS AND CODES ONLY. A field is an id, a code, an integer, a
 * boolean or a zoned time. There is no free-text field type, unknown fields
 * are refused, and an id cannot hold an email address, a phone number, a
 * postal code, a name pair or a sentence (PERSONAL_SHAPES). Names, addresses
 * and message bodies stay in the entity tables, so a Law 25 erasure never has
 * to rewrite the ledger.
 *
 * The repo has no zod; the validator below is hand-rolled in the shape of
 * lib/os/approvals/rules.ts (a Valid<T> result, never a throw).
 *
 * Adding an event: lib/ledger/README.md.
 */
import type { DepartmentKey } from "@/lib/os/types";
import { OS_DEPARTMENTS } from "@/lib/os/departments";

// ---------------------------------------------------------------------------
// Vocabularies (the migration has no CHECK constraints; these are the lists)
// ---------------------------------------------------------------------------

export const ACTOR_TYPES = ["human", "agent", "system", "external"] as const;
export type LedgerActorType = (typeof ACTOR_TYPES)[number];

export const SOURCES = ["native", "stripe", "gmail", "zernio", "meta", "calendar", "twilio", "recall", "import", "backfill"] as const;
export type LedgerSource = (typeof SOURCES)[number];

export const CONFIDENCES = ["verified", "inferred", "human_confirmed"] as const;
export type LedgerConfidence = (typeof CONFIDENCES)[number];

/** The harnesses outside this app that may POST to /api/ledger/ingest. */
export const PRODUCERS = ["bea", "maven", "atlas"] as const;
export type LedgerProducer = (typeof PRODUCERS)[number];

export const JOIN_KEYS = ["contact_id", "deal_id", "customer_id"] as const;
export type JoinKey = (typeof JOIN_KEYS)[number];

export const SUBJECT_TYPES = [
  "lead",
  "contact",
  "deal",
  "customer",
  "message",
  "content",
  "touch",
  "task",
  "meeting",
  "call",
  "proposal",
  "agreement",
  "invoice",
  "project",
  "deliverable",
  "ticket",
  "subscription",
  "payment",
  "refund",
  "approval",
  "routine_run",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

export const DEPARTMENT_KEYS: readonly DepartmentKey[] = OS_DEPARTMENTS.map((d) => d.key);

export function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Value shapes
// ---------------------------------------------------------------------------

/**
 * An id: a provider or database identifier. Letters, digits and `_ . : / -`,
 * starting with a letter or digit. No `@` (an email), no `+` (an E.164 phone),
 * no whitespace (a sentence), and none of the PERSONAL_SHAPES below.
 */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
/** A code: a lowercase machine word from a known vocabulary (intent, reason, stage). */
export const CODE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
/** ISO 4217, upper case. */
export const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Values made only of id characters that are still a person, not an id. The
 * harnesses' SMS and voice providers key contacts by phone number, so these
 * are the shapes that actually arrive:
 *   - a North American number, bare: 5145550199, 15145550199;
 *   - any digits-and-separators run of phone length (7 to 15 digits):
 *     514-555-0199, 514.555.0199, 555-0199 (a bare date is refused too; a time
 *     belongs in a time field);
 *   - a Canadian postal code: H2X1Y4, H2X-1Y4;
 *   - a Title-case name pair: Jean.Tremblay, Jane-Doe, Jean_Tremblay.
 * A lowercase slug (jane.doe) cannot be told from an id like sales.team, and an
 * opaque id still points at a person through the entity tables; the erasure
 * rewrites those tables, which is why the ledger holds only ids. A provider id
 * that happens to be a bare 10-digit number goes in namespaced (tg:5165125484).
 */
const PERSONAL_SHAPES: readonly RegExp[] = [
  /^1?\d{10}$/,
  /^(?=(?:\D*\d){7,15}\D*$)\d+(?:[-.]\d+)+$/,
  /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][-.]?\d[ABCEGHJ-NPRSTV-Z]\d$/i,
  /^[A-Z][a-z]+(?:[._-][A-Z][a-z]+)+$/,
];

export function looksPersonal(v: string): boolean {
  return PERSONAL_SHAPES.some((re) => re.test(v));
}

export const isLedgerId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v) && !looksPersonal(v);
export const isLedgerCode = (v: unknown): v is string => typeof v === "string" && CODE_RE.test(v);

/**
 * A timestamp WITH its zone: `Z` or `±hh:mm`. A naive one ("2026-09-20T10:00:00",
 * what Python's datetime.utcnow().isoformat() prints) would be read in the
 * server's own zone, so the same event would land at different instants, and
 * hash differently, on two hosts.
 */
const ZONED_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * The instant as UTC ISO-8601 (ms), or null when it is not a real zoned timestamp.
 *
 * The shape check is not enough: Date.parse rolls impossible values over
 * (2026-02-30 becomes 2026-03-02), and the ledger is append-only, so a
 * producer's bad date would be stored as a different day for good. Calendar
 * days, clock fields and the offset are checked before parsing.
 */
export function zonedTimeToIso(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = ZONED_TIME_RE.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, oh, om] = m;
  const month = Number(mo);
  const daysInMonth = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
  if (month < 1 || month > 12 || Number(d) < 1 || Number(d) > daysInMonth) return null;
  if (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59)) return null;
  // Real offsets run from -12:00 to +14:00.
  if (oh !== undefined && (Number(oh) > 14 || Number(om) > 59)) return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export type FieldSpec =
  | { kind: "id"; optional?: boolean }
  | { kind: "code"; optional?: boolean; values?: readonly string[] }
  | { kind: "int"; optional?: boolean; min?: number; max?: number }
  | { kind: "bool"; optional?: boolean }
  | { kind: "time"; optional?: boolean };

export type PayloadSchema = Readonly<Record<string, FieldSpec>>;

const id = (): FieldSpec => ({ kind: "id" });
const code = (values?: readonly string[]): FieldSpec => ({ kind: "code", ...(values ? { values } : {}) });
const int = (min?: number, max?: number): FieldSpec => ({ kind: "int", min, max });
const time = (): FieldSpec => ({ kind: "time" });
const opt = (f: FieldSpec): FieldSpec => ({ ...f, optional: true });

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };

function checkField(name: string, spec: FieldSpec, v: unknown): Valid<unknown> {
  const field = `payload.${name}`;
  switch (spec.kind) {
    case "id":
      return isLedgerId(v) ? { ok: true, value: v } : { ok: false, error: "payload_not_an_id", field };
    case "code":
      if (!isLedgerCode(v)) return { ok: false, error: "payload_not_a_code", field };
      if (spec.values && !spec.values.includes(v)) return { ok: false, error: "payload_code_unknown", field };
      return { ok: true, value: v };
    case "int":
      if (typeof v !== "number" || !Number.isSafeInteger(v)) return { ok: false, error: "payload_not_an_integer", field };
      if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) {
        return { ok: false, error: "payload_out_of_range", field };
      }
      return { ok: true, value: v };
    case "bool":
      return typeof v === "boolean" ? { ok: true, value: v } : { ok: false, error: "payload_not_a_boolean", field };
    case "time": {
      const iso = zonedTimeToIso(v);
      return iso ? { ok: true, value: iso } : { ok: false, error: "payload_not_a_time", field };
    }
  }
}

/**
 * A payload checked against its schema. Every declared field is checked;
 * an undeclared field is refused (that is how free text is kept out: there is
 * nowhere to put it). Returns the payload with times normalised to UTC.
 */
export function validatePayload(schema: PayloadSchema, payload: unknown): Valid<Record<string, unknown>> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "payload_not_an_object" };
  const input = payload as Record<string, unknown>;
  for (const k of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(schema, k)) return { ok: false, error: "payload_field_unknown", field: `payload.${k}` };
  }
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const v = input[name];
    if (v === undefined || v === null) {
      if (spec.optional) continue;
      return { ok: false, error: "payload_field_required", field: `payload.${name}` };
    }
    const r = checkField(name, spec, v);
    if (!r.ok) return r;
    out[name] = r.value;
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export type CatalogEntry = {
  key: string;
  version: number;
  department: DepartmentKey;
  /**
   * The ONE repo module allowed to emit this key natively (tests/ledger-core
   * fails on an emit of it anywhere else). "app/api/ledger/ingest/route.ts"
   * means the key arrives only from the producers below.
   */
  owningModule: string;
  /** Python harnesses allowed to send this key through /api/ledger/ingest. */
  producers: readonly LedgerProducer[];
  subjectTypes: readonly SubjectType[];
  requiredJoinKeys: readonly JoinKey[];
  /**
   * required: value_cents and currency must be set; none: they must not be.
   * value_cents is an amount, never negative: the key says which way the money
   * moved (refund.issued, not a negative payment.received).
   */
  value: "required" | "optional" | "none";
  payload: PayloadSchema;
  /** The idempotency key every emitter of this event builds. */
  idempotency: string;
  /**
   * Required when more than one writer may record this key: the native owner
   * and an ingest producer, or several producers. Each writer's idempotency
   * keys must match its own pattern, and emit refuses one that does not. The
   * patterns are how two writers never count one fact twice: either both build
   * the SAME key from the provider's own id (a fact both of them see lands
   * once), or they own disjoint slices (each records only what it originated).
   */
  writers?: Readonly<Partial<Record<LedgerWriter, RegExp>>>;
  description: string;
};

/** Who wrote an event: the owning module ("native") or an ingest producer. */
export type LedgerWriter = "native" | LedgerProducer;

type Def = Omit<CatalogEntry, "version" | "producers" | "value"> &
  Partial<Pick<CatalogEntry, "version" | "producers" | "value">>;
const ev = (d: Def): CatalogEntry => ({ version: 1, producers: [], value: "none", ...d });

/** owningModule for a key that arrives only from producers: nothing in the app emits it. */
export const INGEST_ONLY = "app/api/ledger/ingest/route.ts";
const CHANNEL = code(["email", "sms", "dm", "call"]);
/** One idempotency key segment, and the rest of a key. */
const SEG = "[^:\\s]+";
const REST = "[\\x21-\\x7E]+";
const keyRe = (source: string): RegExp => new RegExp(`^${source}$`);
const both = (re: RegExp, producer: LedgerProducer): Partial<Record<LedgerWriter, RegExp>> => ({ native: re, [producer]: re });

/** Each harness numbers its own runs, so each owns its own run: namespace. */
const RUN_WRITERS: Partial<Record<LedgerWriter, RegExp>> = Object.fromEntries(PRODUCERS.map((p) => [p, keyRe(`run:${p}:${REST}`)]));

const DEFS: readonly CatalogEntry[] = [
  // ── Outreach ──────────────────────────────────────────────────────────────
  ev({ key: "outreach.enrolled", department: "sales", owningModule: "lib/drips/enroller.ts", subjectTypes: ["contact"], requiredJoinKeys: ["contact_id"],
    payload: { sequence_id: id(), cycle: int(1) }, idempotency: "enroll:{sequence_id}:{contact_id}:{cycle}",
    description: "A contact was enrolled in an outreach sequence." }),
  ev({ key: "message.sent", department: "sales", owningModule: "lib/drips/send.ts", producers: ["bea"], subjectTypes: ["message"], requiredJoinKeys: ["contact_id"],
    payload: { channel: CHANNEL, provider: code(), provider_message_id: opt(id()), template_id: opt(id()) },
    idempotency: "msg:{provider}:{provider_message_id}", writers: both(keyRe(`msg:${SEG}:${REST}`), "bea"),
    description: "An outbound message left the business (recorded once the provider has given it an id)." }),
  ev({ key: "message.delivered", department: "sales", owningModule: "lib/drips/reconcile-email-telemetry.ts", subjectTypes: ["message"], requiredJoinKeys: [],
    payload: { channel: CHANNEL, provider: code(), provider_message_id: id() }, idempotency: "{provider}:{provider_event_id}",
    description: "The provider confirmed delivery." }),
  ev({ key: "message.bounced", department: "sales", owningModule: "lib/drips/reconcile-email-telemetry.ts", subjectTypes: ["message"], requiredJoinKeys: [],
    payload: { channel: CHANNEL, provider: code(), provider_message_id: id(), bounce_type: code(["hard", "soft"]) },
    idempotency: "{provider}:{provider_event_id}", description: "The provider reported a bounce." }),
  ev({ key: "message.opened", department: "sales", owningModule: "app/api/track/open/[id]/route.ts", subjectTypes: ["message"], requiredJoinKeys: [],
    payload: { channel: CHANNEL, provider: code(), provider_message_id: id() }, idempotency: "open:{tracking_id}:{n}",
    description: "A tracked message was opened." }),
  ev({ key: "message.clicked", department: "sales", owningModule: "app/api/track/click/[id]/route.ts", subjectTypes: ["message"], requiredJoinKeys: [],
    payload: { channel: CHANNEL, provider: code(), provider_message_id: id(), link_id: opt(id()) }, idempotency: "click:{tracking_id}:{n}",
    description: "A tracked link was clicked." }),
  ev({ key: "message.unsubscribed", department: "sales", owningModule: "app/api/unsubscribe/route.ts", subjectTypes: ["message", "contact"], requiredJoinKeys: [],
    payload: { channel: CHANNEL, provider: opt(code()) }, idempotency: "{provider}:{provider_event_id}",
    description: "A recipient unsubscribed from a message." }),
  ev({ key: "content.published", department: "marketing", owningModule: "lib/founders-marketing-core.ts", producers: ["maven"], subjectTypes: ["content"], requiredJoinKeys: [],
    payload: { platform: code(), platform_post_id: id(), asset_id: opt(id()) }, idempotency: "post:{platform}:{platform_post_id}",
    writers: both(keyRe(`post:${SEG}:${REST}`), "maven"), description: "A post went live on a platform." }),

  // ── Lead ──────────────────────────────────────────────────────────────────
  ev({ key: "touch.recorded", department: "marketing", owningModule: "app/api/forms/view/route.ts", subjectTypes: ["touch"], requiredJoinKeys: [],
    payload: {
      visitor_id: id(), seq: int(0), touch_kind: code(["first", "last", "assist"]), form_id: opt(id()),
      utm_source: opt(code()), utm_medium: opt(code()), utm_campaign: opt(id()), click_id_kind: opt(code(["fbclid", "gclid", "ttclid"])),
    },
    idempotency: "touch:{visitor_id}:{seq}", description: "A first-party marketing touch (landing, form view) with its attribution." }),
  ev({ key: "lead.captured", department: "sales", owningModule: "app/api/forms/submit/route.ts", producers: ["bea"], subjectTypes: ["lead"], requiredJoinKeys: ["contact_id"],
    payload: { capture_channel: code(["form", "dm", "email", "call", "import", "referral"]), form_id: opt(id()), lead_source: opt(code()) },
    idempotency: "form:{submission_id} | ig:{conversation_id} | email:{message_id} | import:{batch}:{row}",
    // The app captures form submissions; BEA captures DMs, email and imports.
    writers: { native: keyRe(`form:${REST}`), bea: keyRe(`(?:ig|email|import):${REST}`) },
    description: "A new lead entered the pipeline (touch_id carries the attribution)." }),
  ev({ key: "message.received", department: "sales", owningModule: INGEST_ONLY, producers: ["bea"], subjectTypes: ["message"], requiredJoinKeys: [],
    payload: { channel: CHANNEL, provider: code(), provider_message_id: id(), intent: code(), priority: opt(code()) },
    idempotency: "{provider}:{message_id}", description: "An inbound message arrived, with its classified intent code." }),
  ev({ key: "lead.qualified", department: "sales", owningModule: "lib/oasis-lead-stage-engine.ts", subjectTypes: ["lead"], requiredJoinKeys: ["contact_id"],
    payload: { reason: code(), attempt: int(1) }, idempotency: "qual:{contact_id}:qualified:{n}", description: "A lead was qualified." }),
  ev({ key: "lead.disqualified", department: "sales", owningModule: "lib/oasis-lead-stage-engine.ts", subjectTypes: ["lead"], requiredJoinKeys: ["contact_id"],
    payload: { reason: code(), attempt: int(1) }, idempotency: "qual:{contact_id}:disqualified:{n}", description: "A lead was disqualified, with a reason code." }),

  // ── Nurture ───────────────────────────────────────────────────────────────
  ev({ key: "stage.changed", department: "sales", owningModule: "lib/lead-stage-engine.ts", subjectTypes: ["lead", "deal"], requiredJoinKeys: ["contact_id"],
    payload: { pipeline_key: code(), from_stage: opt(code()), to_stage: code() }, idempotency: "stage:{record_id}:{prior_updated_at}",
    description: "A pipeline record moved stage." }),
  ev({ key: "task.created", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["task"], requiredJoinKeys: [],
    payload: { project_id: opt(id()), task_kind: opt(code()) }, idempotency: "task:{task_id}:created", description: "A task was created." }),
  ev({ key: "task.completed", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["task"], requiredJoinKeys: [],
    payload: { project_id: opt(id()), task_kind: opt(code()) }, idempotency: "task:{task_id}:completed", description: "A task was completed." }),

  // ── Book ──────────────────────────────────────────────────────────────────
  ev({ key: "meeting.booked", department: "sales", owningModule: "lib/website-sales-booking.ts", producers: ["bea"], subjectTypes: ["meeting"], requiredJoinKeys: ["contact_id"],
    payload: { provider: code(), provider_event_id: id(), meeting_kind: opt(code()), starts_at: time() },
    idempotency: "cal:{provider}:{event_id}:booked:{rev}", writers: both(keyRe(`cal:${SEG}:${SEG}:booked:\\d+`), "bea"),
    description: "A meeting was booked." }),
  ev({ key: "meeting.rescheduled", department: "sales", owningModule: "lib/website-sales-booking.ts", producers: ["bea"], subjectTypes: ["meeting"], requiredJoinKeys: ["contact_id"],
    payload: { provider: code(), provider_event_id: id(), starts_at: time(), rev: int(1) },
    idempotency: "cal:{provider}:{event_id}:rescheduled:{rev}", writers: both(keyRe(`cal:${SEG}:${SEG}:rescheduled:\\d+`), "bea"),
    description: "A booked meeting moved." }),
  ev({ key: "meeting.cancelled", department: "sales", owningModule: "lib/website-sales-booking.ts", producers: ["bea"], subjectTypes: ["meeting"], requiredJoinKeys: ["contact_id"],
    payload: { provider: code(), provider_event_id: id(), cancelled_by: opt(code(["contact", "host", "system"])) },
    idempotency: "cal:{provider}:{event_id}:cancelled:{rev}", writers: both(keyRe(`cal:${SEG}:${SEG}:cancelled:\\d+`), "bea"),
    description: "A booked meeting was cancelled." }),

  // ── Call ──────────────────────────────────────────────────────────────────
  ev({ key: "meeting.held", department: "sales", owningModule: "app/api/call-appointments/[id]/route.ts", subjectTypes: ["meeting"], requiredJoinKeys: ["contact_id"],
    payload: { provider_event_id: id() }, idempotency: "cal:{event_id}:attendance", description: "A booked meeting happened." }),
  ev({ key: "meeting.no_show", department: "sales", owningModule: "app/api/call-appointments/[id]/route.ts", subjectTypes: ["meeting"], requiredJoinKeys: ["contact_id"],
    payload: { provider_event_id: id() }, idempotency: "cal:{event_id}:attendance", description: "The contact did not show." }),
  ev({ key: "call.logged", department: "sales", owningModule: "app/api/call-appointments/[id]/route.ts", subjectTypes: ["call"], requiredJoinKeys: ["contact_id"],
    payload: { provider: code(), call_id: id(), disposition: code(), duration_sec: int(0) }, idempotency: "call:{provider}:{call_id}",
    description: "A call was logged with a disposition code." }),
  ev({ key: "objection.raised", department: "sales", owningModule: "lib/web-leads/objections/events.ts", subjectTypes: ["call", "meeting", "lead"], requiredJoinKeys: ["contact_id"],
    payload: { objection_code: code(), source_kind: code(["call", "meeting", "message"]), confidence_pct: opt(int(0, 100)) },
    idempotency: "obj:{meeting_or_call_id}:{code}", description: "An objection from the pack was raised." }),

  // ── Close ─────────────────────────────────────────────────────────────────
  ev({ key: "proposal.sent", department: "sales", owningModule: "lib/website-sales-workflow.ts", subjectTypes: ["proposal"], requiredJoinKeys: ["contact_id", "deal_id"],
    value: "optional", payload: { doc_id: id(), doc_version: int(1) }, idempotency: "proposal:{doc_id}:v{n}", description: "A proposal was sent." }),
  ev({ key: "agreement.signed", department: "sales", owningModule: "lib/esign/db.ts", subjectTypes: ["agreement"], requiredJoinKeys: ["contact_id"],
    payload: { envelope_id: id() }, idempotency: "esign:{envelope_id}:completed", description: "Every signer signed." }),
  ev({ key: "deal.won", department: "sales", owningModule: "lib/lead-stage-engine.ts", subjectTypes: ["deal"], requiredJoinKeys: ["deal_id", "contact_id"],
    value: "optional", payload: { pipeline_key: code(), cycle: int(1) }, idempotency: "deal:{deal_id}:won:{cycle}", description: "A deal closed won." }),
  ev({ key: "deal.lost", department: "sales", owningModule: "lib/lead-stage-engine.ts", subjectTypes: ["deal"], requiredJoinKeys: ["deal_id", "contact_id"],
    payload: { pipeline_key: code(), cycle: int(1), lost_reason: code() }, idempotency: "deal:{deal_id}:lost:{cycle}",
    description: "A deal closed lost, with a reason code." }),

  // ── Invoice ───────────────────────────────────────────────────────────────
  ev({ key: "invoice.issued", department: "finance", owningModule: "lib/founders-finances/invoice-store.ts", subjectTypes: ["invoice"], requiredJoinKeys: [],
    value: "required", payload: { invoice_id: id(), source_system: code(["native", "stripe", "qbo", "xero"]), due_on: opt(time()) },
    idempotency: "inv:{source}:{invoice_id}:issued", description: "An invoice was issued." }),
  ev({ key: "invoice.voided", department: "finance", owningModule: "lib/founders-finances/invoice-store.ts", subjectTypes: ["invoice"], requiredJoinKeys: [],
    payload: { invoice_id: id(), source_system: code(["native", "stripe", "qbo", "xero"]) }, idempotency: "inv:{source}:{invoice_id}:voided",
    description: "An invoice was voided." }),

  // ── Onboard ───────────────────────────────────────────────────────────────
  ev({ key: "customer.created", department: "client_success", owningModule: "lib/os/customers/store.ts", subjectTypes: ["customer"], requiredJoinKeys: ["customer_id"],
    payload: { source_lead_id: opt(id()), origin: code(["conversion", "manual", "import"]) }, idempotency: "cust:{customer_id}",
    description: "A client record was created." }),
  ev({ key: "onboarding.milestone_reached", department: "client_success", owningModule: "lib/os/customers/store.ts", subjectTypes: ["customer"], requiredJoinKeys: ["customer_id"],
    payload: { milestone: code(), level: int(0, 20) }, idempotency: "onb:{customer_id}:{milestone}", description: "A client reached an onboarding milestone." }),
  ev({ key: "project.created", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["project"], requiredJoinKeys: [],
    payload: {}, idempotency: "proj:{project_id}:created", description: "A delivery project was created." }),

  // ── Deliver ───────────────────────────────────────────────────────────────
  ev({ key: "project.stage_changed", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["project"], requiredJoinKeys: [],
    payload: { from_status: opt(code()), to_status: code() }, idempotency: "proj:{project_id}:{prior_updated_at}", description: "A project moved status." }),
  ev({ key: "project.launched", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["project"], requiredJoinKeys: [],
    payload: {}, idempotency: "proj:{project_id}:launched", description: "A project went live for the client." }),
  ev({ key: "deliverable.shipped", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["deliverable"], requiredJoinKeys: [],
    payload: { project_id: opt(id()) }, idempotency: "dlv:{deliverable_id}", description: "A deliverable reached the client (approval_id links the gate)." }),

  // ── Support ───────────────────────────────────────────────────────────────
  ev({ key: "ticket.opened", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["ticket"], requiredJoinKeys: [],
    payload: { priority: opt(code()), channel: opt(code()) }, idempotency: "tkt:{ticket_id}:opened:{n}", description: "A support ticket was opened." }),
  ev({ key: "ticket.first_response", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["ticket"], requiredJoinKeys: [],
    payload: { response_minutes: opt(int(0)) }, idempotency: "tkt:{ticket_id}:first_response:{n}", description: "The first reply on a ticket." }),
  ev({ key: "ticket.sla_breached", department: "client_success", owningModule: "lib/delivery/sla-cron.ts", subjectTypes: ["ticket"], requiredJoinKeys: [],
    payload: { sla_kind: code(["first_response", "resolution"]) }, idempotency: "tkt:{ticket_id}:sla_breached:{n}", description: "A ticket passed its SLA." }),
  ev({ key: "ticket.resolved", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["ticket"], requiredJoinKeys: [],
    payload: {}, idempotency: "tkt:{ticket_id}:resolved:{n}", description: "A ticket was resolved." }),
  ev({ key: "ticket.reopened", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["ticket"], requiredJoinKeys: [],
    payload: {}, idempotency: "tkt:{ticket_id}:reopened:{n}", description: "A resolved ticket was reopened." }),
  ev({ key: "csat.recorded", department: "client_success", owningModule: "lib/delivery/store.ts", subjectTypes: ["ticket"], requiredJoinKeys: [],
    payload: { score: int(1, 5) }, idempotency: "csat:{ticket_id}", description: "A satisfaction score was recorded." }),

  // ── Retain ────────────────────────────────────────────────────────────────
  ev({ key: "subscription.started", department: "finance", owningModule: "lib/founders-finances/stripe-ingest.ts", subjectTypes: ["subscription"], requiredJoinKeys: [],
    value: "required", payload: { provider_subscription_id: id(), plan_code: opt(code()), interval: opt(code(["day", "week", "month", "year"])) },
    idempotency: "stripe:{event_id}", description: "A subscription started." }),
  ev({ key: "subscription.renewed", department: "finance", owningModule: "lib/founders-finances/stripe-ingest.ts", subjectTypes: ["subscription"], requiredJoinKeys: [],
    value: "required", payload: { provider_subscription_id: id(), plan_code: opt(code()) }, idempotency: "stripe:{event_id}", description: "A subscription renewed." }),
  ev({ key: "subscription.changed", department: "finance", owningModule: "lib/founders-finances/stripe-ingest.ts", subjectTypes: ["subscription"], requiredJoinKeys: [],
    value: "optional", payload: { provider_subscription_id: id(), from_plan_code: opt(code()), plan_code: opt(code()) },
    idempotency: "stripe:{event_id}", description: "A subscription changed plan or quantity." }),
  ev({ key: "subscription.cancelled", department: "finance", owningModule: "lib/founders-finances/stripe-ingest.ts", subjectTypes: ["subscription"], requiredJoinKeys: [],
    payload: { provider_subscription_id: id(), cancel_reason: opt(code()) }, idempotency: "stripe:{event_id}", description: "A subscription was cancelled." }),
  ev({ key: "customer.churned", department: "client_success", owningModule: "lib/os/customers/store.ts", subjectTypes: ["customer"], requiredJoinKeys: ["customer_id"],
    payload: { reason: opt(code()) }, idempotency: "churn:{customer_id}:{date}", description: "A client churned." }),
  ev({ key: "customer.reactivated", department: "client_success", owningModule: "lib/os/customers/store.ts", subjectTypes: ["customer"], requiredJoinKeys: ["customer_id"],
    payload: {}, idempotency: "reactivate:{customer_id}:{date}", description: "A churned client came back." }),

  // ── Collect ───────────────────────────────────────────────────────────────
  ev({ key: "payment.received", department: "finance", owningModule: "lib/founders-finances/stripe-ingest.ts", subjectTypes: ["payment"], requiredJoinKeys: [],
    value: "required", payload: { provider_payment_id: id(), method: opt(code()) }, idempotency: "stripe:{charge_id} | qbo:{payment_id}",
    description: "Money arrived (confidence verified when read from the provider)." }),
  ev({ key: "payment.failed", department: "finance", owningModule: "lib/founders-finances/stripe-ingest.ts", subjectTypes: ["payment"], requiredJoinKeys: [],
    value: "optional", payload: { provider_payment_id: id(), failure_code: opt(code()) }, idempotency: "stripe:{charge_id}:failed", description: "A payment attempt failed." }),
  ev({ key: "refund.issued", department: "finance", owningModule: "lib/founders-finances/stripe-ingest.ts", subjectTypes: ["refund"], requiredJoinKeys: [],
    value: "required", payload: { provider_refund_id: id(), provider_payment_id: opt(id()) }, idempotency: "stripe:{refund_id}", description: "Money went back." }),
  ev({ key: "invoice.paid", department: "finance", owningModule: "lib/founders-finances/stripe-ingest.ts", subjectTypes: ["invoice"], requiredJoinKeys: [],
    value: "required", payload: { invoice_id: id(), source_system: code(["native", "stripe", "qbo", "xero"]) }, idempotency: "inv:{invoice_id}:paid",
    description: "An invoice was paid in full." }),

  // ── Cross-cutting: approvals (mirrored 1:1 from approval_events) ──────────
  ev({ key: "approval.requested", department: "chief_of_staff", owningModule: "lib/os/approvals/store.ts", subjectTypes: ["approval"], requiredJoinKeys: [],
    payload: { action_kind: code(), revision: int(1), risk_level: code(), requested_by_type: code() }, idempotency: "appr:{approval_event_id}",
    description: "A department proposed an outward action." }),
  ev({ key: "approval.edited", department: "chief_of_staff", owningModule: "lib/os/approvals/store.ts", subjectTypes: ["approval"], requiredJoinKeys: [],
    payload: { action_kind: code(), revision: int(2), supersedes_id: id(), risk_level: code() }, idempotency: "appr:{approval_event_id}",
    description: "A proposal was revised; the new revision replaces the old one." }),
  ev({ key: "approval.approved", department: "chief_of_staff", owningModule: "lib/os/approvals/store.ts", subjectTypes: ["approval"], requiredJoinKeys: [],
    payload: { action_kind: code(), decided_via: code() }, idempotency: "appr:{approval_event_id}", description: "A person approved a proposal." }),
  ev({ key: "approval.sent_back", department: "chief_of_staff", owningModule: "lib/os/approvals/store.ts", subjectTypes: ["approval"], requiredJoinKeys: [],
    payload: { action_kind: code(), decided_via: code() }, idempotency: "appr:{approval_event_id}",
    description: "A person sent a proposal back (the note stays in approval_events)." }),
  ev({ key: "approval.rejected", department: "chief_of_staff", owningModule: "lib/os/approvals/store.ts", subjectTypes: ["approval"], requiredJoinKeys: [],
    payload: { action_kind: code(), decided_via: code(), reason: opt(code()) }, idempotency: "appr:{approval_event_id}",
    description: "Reserved: approvals have no reject decision today (sent_back is the no)." }),
  ev({ key: "approval.executed", department: "chief_of_staff", owningModule: "lib/os/approvals/store.ts", subjectTypes: ["approval"], requiredJoinKeys: [],
    payload: { action_kind: code(), outcome: code(), provider: opt(code()) }, idempotency: "appr:{approval_event_id}",
    description: "The executor carried out an approved action." }),
  ev({ key: "approval.failed", department: "chief_of_staff", owningModule: "lib/os/approvals/store.ts", subjectTypes: ["approval"], requiredJoinKeys: [],
    payload: { action_kind: code(), reason: code() }, idempotency: "appr:{approval_event_id}", description: "The executor or provider refused an approved action." }),
  ev({ key: "approval.expired", department: "chief_of_staff", owningModule: "lib/os/approvals/store.ts", subjectTypes: ["approval"], requiredJoinKeys: [],
    payload: { action_kind: code() }, idempotency: "appr:{approval_event_id}", description: "Nobody decided a proposal in time." }),

  // ── Cross-cutting: routines and consent ───────────────────────────────────
  ev({ key: "routine.run_completed", department: "operations", owningModule: INGEST_ONLY, producers: ["bea", "maven", "atlas"], subjectTypes: ["routine_run"], requiredJoinKeys: [],
    payload: { routine_key: code(), duration_ms: opt(int(0)) }, idempotency: "run:{producer}:{routine_run_id}", writers: RUN_WRITERS,
    description: "A scheduled routine finished." }),
  ev({ key: "routine.run_failed", department: "operations", owningModule: INGEST_ONLY, producers: ["bea", "maven", "atlas"], subjectTypes: ["routine_run"], requiredJoinKeys: [],
    payload: { routine_key: code(), error_code: code(), duration_ms: opt(int(0)) }, idempotency: "run:{producer}:{routine_run_id}",
    writers: RUN_WRITERS, description: "A scheduled routine failed." }),
  ev({ key: "consent.granted", department: "sales", owningModule: "lib/sms/consent.ts", subjectTypes: ["contact"], requiredJoinKeys: ["contact_id"],
    payload: { channel: CHANNEL, basis: opt(code()) }, idempotency: "consent:{contact_id}:{channel}:granted:{n}", description: "A contact gave consent on a channel." }),
  ev({ key: "consent.revoked", department: "sales", owningModule: "lib/sms/consent.ts", producers: ["bea"], subjectTypes: ["contact"], requiredJoinKeys: ["contact_id"],
    payload: { channel: CHANNEL, basis: opt(code()) }, idempotency: "consent:{contact_id}:{channel}:revoked:{n}",
    // The app handles SMS STOP; BEA handles email, DM and call opt-outs.
    writers: { native: keyRe(`consent:${SEG}:sms:revoked:\\d+`), bea: keyRe(`consent:${SEG}:(?:email|dm|call):revoked:\\d+`) },
    description: "A contact withdrew consent on a channel." }),
  ev({ key: "suppression.added", department: "sales", owningModule: "lib/sms/consent.ts", producers: ["bea"], subjectTypes: ["contact"], requiredJoinKeys: [],
    payload: { channel: CHANNEL, reason: code() }, idempotency: "suppress:{channel}:{suppression_id}",
    writers: { native: keyRe(`suppress:sms:${REST}`), bea: keyRe(`suppress:(?:email|dm|call):${REST}`) },
    description: "An address or number was suppressed." }),
];

/** Every entry, in catalog order. tests/ledger-core.test.ts pins that no key appears twice. */
export const CATALOG_ENTRIES: readonly CatalogEntry[] = DEFS;

export const LEDGER_CATALOG: ReadonlyMap<string, CatalogEntry> = new Map(DEFS.map((d) => [d.key, d]));

/** The entry for an event key, or null. The only way anything looks one up. */
export function catalogEntry(eventKey: unknown): CatalogEntry | null {
  return typeof eventKey === "string" ? (LEDGER_CATALOG.get(eventKey) ?? null) : null;
}
