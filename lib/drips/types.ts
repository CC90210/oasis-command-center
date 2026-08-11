/**
 * drips/types.ts — shared shape for drip sequences.
 *
 * Phase 4 of the SunBiz CRM build (2026-05-15). The dashboard's
 * sequence builder (/sequences/[id]/edit) writes these shapes into
 * drip_sequences.steps + drip_sequences.trigger_filter; the Python
 * runner (bravo_cli/sequence_runner.py) reads them back to fire sends.
 *
 * Two languages, one schema — keep this file's shape in lockstep with
 * the runner's expectations. The runner does shape validation at load
 * time; mismatches surface in the daemon log.
 */

// ---------------------------------------------------------------------------
// Channel + step types
// ---------------------------------------------------------------------------

export type DripChannel = "sms" | "email";

export type DripStep = {
  channel: DripChannel;
  /**
   * Wait this long after the previous step (or after enrollment for
   * step 0) before firing. 0 = fire immediately. The daemon clamps
   * negative or non-finite values to 0 defensively.
   */
  delay_minutes: number;
  /** Email subject — required when channel === "email". */
  subject?: string;
  /**
   * Message body. Mustache-style substitution via lib/drips/templates.ts:
   *   {{lead.first_name}} {{lead.business_name}} {{lender.name}}
   * Missing values render as empty string (operator-friendly default
   * vs throwing on the send path).
   */
  body: string;
  /**
   * Optional rich HTML body for email steps. Phase-2 seeds (Inquiry
   * Welcomer, migrations 078/080) store body_text + body_html; the runner
   * sends multipart/alternative when body_html is present. Carried through
   * here so an editor save doesn't strip the HTML part.
   */
  body_html?: string;
  /** Optional sender label — agent name, e.g. "Solara" or "Helios". */
  from_label?: string;
  /**
   * Optional pinned sending number (E.164, e.g. "+15614650503"). SMS steps
   * only. When set, this step's SMS goes out from THIS number on the parent/
   * admin TextTorrent account, bypassing the per-rep sender identity — the
   * mechanism behind the two-number accelerated-chase alternation (each step
   * carries numberA or numberB). Ignored on email steps. Charset/E.164
   * validated here; a malformed value is dropped so it can never reach the
   * send body's sender_id (see [[argv-for-path-handling]]) and the step falls
   * back to the normal per-rep identity.
   */
  from_number?: string;
  /**
   * Optional body variations (2026-07-10). When present, the executor picks ONE
   * DETERMINISTICALLY per (lead_id, step_index) — so a given lead always gets
   * the same variant across retries/reclaims, while different leads spread
   * across the set. Falls back to `body` when absent/empty. `subject_variants`
   * is the email-subject analogue (paired by index with body_variants when both
   * are present). Lets a stage send "the same message in nice variations."
   */
  body_variants?: string[];
  subject_variants?: string[];
  /**
   * Which job this step's copy does in the arc: opener, nudge, value, question,
   * last_call, revive. Keys the approved template pool
   * (drip_template_pool.role) so rotation only ever substitutes templates doing
   * the SAME job — an opener never stands in for a last call.
   *
   * Absent means "nudge", the neutral middle. Every existing step therefore
   * keeps working without edit, and an unseeded pool changes nothing.
   */
  role?: string;
};

export type DripTriggerFilter = {
  /** Entity type — e.g. "lead", "offer". */
  entity?: string;
  /** Field name that changed — e.g. "stage", "status". */
  field?: string;
  /** Target stage / status the change landed on. */
  to?: string;
  /** Source stage / status the change came from (rarely useful — exposed
   *  for completeness so an operator can express
   *  "only when going from sent_application directly to declined"). */
  from?: string;
};

export type DripSequence = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  trigger_event: string;
  trigger_filter: DripTriggerFilter;
  steps: DripStep[];
  enabled: boolean;
  one_per_lead: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

export class DripDefinitionError extends Error {
  constructor(public path: string, public reason: string) {
    super(`drip definition invalid at ${path}: ${reason}`);
    this.name = "DripDefinitionError";
  }
}

const VALID_CHANNELS: ReadonlySet<DripChannel> = new Set(["sms", "email"]);

function isStringRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new DripDefinitionError(`${path}.${key}`, "expected non-empty string");
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return arr.length > 0 ? arr : undefined;
}

function parseStep(v: unknown, path: string): DripStep {
  if (!isStringRecord(v)) throw new DripDefinitionError(path, "expected object");
  const channel = requireString(v, "channel", path);
  if (!VALID_CHANNELS.has(channel as DripChannel)) {
    throw new DripDefinitionError(`${path}.channel`, `unknown channel "${channel}"`);
  }
  const delayRaw = v.delay_minutes;
  if (typeof delayRaw !== "number" || !Number.isFinite(delayRaw)) {
    throw new DripDefinitionError(`${path}.delay_minutes`, "expected finite number");
  }
  // Accept both step shapes: legacy `body` and the Phase-2 `body_text`
  // (+ optional `body_html`) used by the Inquiry Welcomer migrations
  // (SunBiz-Agent 078/080). The Python runner reads body_text first and
  // falls back to body — without this fallback those sequences render as
  // "Sequence definition corrupt" in the editor despite firing fine.
  const bodyRaw =
    typeof v.body === "string" && v.body.trim() ? v.body : v.body_text;
  if (typeof bodyRaw !== "string" || !bodyRaw.trim()) {
    throw new DripDefinitionError(`${path}.body`, "expected non-empty string");
  }
  const body = bodyRaw;
  const step: DripStep = {
    channel: channel as DripChannel,
    delay_minutes: Math.max(0, Math.floor(delayRaw)),
    body,
  };
  const bodyHtml = optionalString(v, "body_html");
  if (bodyHtml) step.body_html = bodyHtml;
  if (channel === "email") {
    step.subject = requireString(v, "subject", path);
  } else if (typeof v.subject === "string" && v.subject.length > 0) {
    // SMS doesn't use subject but accept it without error so operators
    // can switch a step from email -> sms without re-typing.
    step.subject = v.subject;
  }
  const fromLabel = optionalString(v, "from_label");
  if (fromLabel) step.from_label = fromLabel;
  // Pinned sender number — SMS only, strict E.164 allowlist. A malformed value
  // is silently dropped (not an error) so the step degrades to the per-rep
  // identity rather than pushing a bad string toward the TT send body.
  const fromNumber = optionalString(v, "from_number");
  if (fromNumber && channel === "sms" && /^\+[1-9][0-9]{9,14}$/.test(fromNumber.trim())) {
    step.from_number = fromNumber.trim();
  }
  const bodyVariants = optionalStringArray(v, "body_variants");
  if (bodyVariants) step.body_variants = bodyVariants;
  const subjectVariants = optionalStringArray(v, "subject_variants");
  if (subjectVariants) step.subject_variants = subjectVariants;
  // Template-pool role. Validated against the same set the DB check constraint
  // enforces, so a typo degrades to the neutral "nudge" bucket rather than
  // silently matching no pool and falling back for reasons nobody can see.
  const role = optionalString(v, "role");
  if (role && ["opener", "nudge", "value", "question", "last_call", "revive"].includes(role.trim())) {
    step.role = role.trim();
  }
  return step;
}

/**
 * Validate a `drip_sequences.steps` jsonb value. Returns the typed
 * array. Throws DripDefinitionError on shape violations so callers
 * can surface a 400 with the offending path.
 */
export function parseDripSteps(value: unknown): DripStep[] {
  if (!Array.isArray(value)) {
    throw new DripDefinitionError("$", "expected steps to be an array");
  }
  if (value.length === 0) {
    throw new DripDefinitionError("$", "drip must have at least one step");
  }
  return value.map((s, idx) => parseStep(s, `$[${idx}]`));
}

export function parseDripTriggerFilter(value: unknown): DripTriggerFilter {
  if (value === null || value === undefined) return {};
  if (!isStringRecord(value)) {
    throw new DripDefinitionError("$.trigger_filter", "expected object");
  }
  const out: DripTriggerFilter = {};
  if (typeof value.entity === "string") out.entity = value.entity;
  if (typeof value.field === "string") out.field = value.field;
  if (typeof value.to === "string") out.to = value.to;
  if (typeof value.from === "string") out.from = value.from;
  return out;
}
