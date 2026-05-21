/**
 * Event projection — translate raw agent_events rows into a human-readable
 * shape for the dashboard.
 *
 * The agent_events substrate stores wire-format event types
 * (BRAVO_RECORD_STATUS_CHANGED, outbound.recorded, etc.) and a JSON payload.
 * The /operations Activity Tape was rendering the wire format verbatim,
 * which CC correctly flagged as JSON noise — meaningful to a developer
 * reading event_bus.py, opaque to an operator.
 *
 * This module exposes:
 *   - EVENT_TYPE_LABELS — plain-English name per event_type
 *   - EVENT_TYPE_TONE   — colour hint per family so the badges scan visually
 *   - projectEvent(raw) — full projection: label, tone, one-line summary,
 *                         normalised severity/timestamp/agent fields
 *
 * Mirrors scripts/event_router.py:_project() so the on-host event-router
 * log and the cloud dashboard speak the same dialect. When you add a new
 * event_type to event_bus.py, add the label here too — there's no
 * compile-time check (the wire format is just a string), so the cost of
 * forgetting is "operator sees raw screaming snake case for that event."
 */

export type EventTone = "accent" | "engaged" | "warm" | "hot" | "info" | "neutral";

export interface ProjectedEvent {
  id: string;
  event_type: string;
  label: string;
  summary: string;
  tone: EventTone;
  severity: string;
  source_agent: string;
  target_agent: string;
  published_at: string | null;
}

/**
 * Plain-English label per known event_type. Fallback is the wire format
 * with screaming snake replaced by Title Case.
 */
export const EVENT_TYPE_LABELS: Record<string, string> = {
  // Outbound (the noisy ones — these are 95% of the feed).
  BRAVO_OUTBOUND_SENT: "Outbound sent",
  "outbound.recorded": "Outbound logged",
  BRAVO_OUTBOUND_FAILED: "Outbound failed",

  // Email-engagement (n8n webhook fires these when SendGrid reports open/click).
  BRAVO_EMAIL_OPENED: "Email opened",
  BRAVO_EMAIL_CLICKED: "Email clicked",
  BRAVO_EMAIL_BOUNCED: "Email bounced",
  BRAVO_EMAIL_REPLIED: "Email replied",

  // Record lifecycle (leads / applications / offers / funded deals).
  BRAVO_RECORD_STATUS_CHANGED: "Record status changed",
  BRAVO_RECORD_CREATED: "Record created",
  BRAVO_RECORD_UPDATED: "Record updated",
  BRAVO_LEAD_STATUS_CHANGED: "Lead status changed",
  BRAVO_LEAD_LINK_VIEWED: "Form link viewed",
  BRAVO_FUNDED_DEAL_RENEWAL_WINDOW_OPENED: "Renewal window opened",

  // Inbound.
  "inbound.classified": "Inbound classified",
  BRAVO_INBOUND_RECEIVED: "Inbound received",

  // V6 substrate / system signal.
  BRAVO_SESSION_LOG_APPENDED: "Session log written",
  BRAVO_PULSE_REFRESHED: "Pulse refreshed",
  BRAVO_CHAT_INTERACTION: "Chat interaction",
  BRAVO_BUILD3_VERIFICATION: "Build-3 verification",
  BRAVO_BUILD3_BASEROW: "Build-3 Baserow",
  BRAVO_BUILD3_FALLBACK_TEST_2: "Build-3 fallback test",

  // SunBiz (mirror events from the client agent).
  SUNBIZ_LEAD_SOURCED: "SunBiz lead sourced",
  SUNBIZ_SESSION_LOG_APPENDED: "SunBiz session logged",

  // Dashboard-action mutations (correlation_id == tenant_id; see lib/action-log.ts).
  dashboard_action: "Dashboard action",
};

/**
 * Tone per event family. Used to colour the badge in the Activity Tape so
 * a glance picks up "this is outbound" vs "this is a status change."
 */
function toneFor(eventType: string, severity: string | null | undefined): EventTone {
  if (severity === "error") return "hot";
  if (severity === "warn") return "warm";
  if (eventType.includes("OUTBOUND") || eventType.startsWith("outbound")) return "accent";
  if (eventType.includes("INBOUND") || eventType.startsWith("inbound")) return "info";
  if (eventType.includes("STATUS_CHANGED") || eventType.includes("LEAD")) return "engaged";
  if (eventType.includes("SESSION_LOG") || eventType.includes("PULSE")) return "neutral";
  return "accent";
}

/**
 * Optional resolver: map of record_id (lead or application UUID) → human label.
 * Operations page batch-resolves these via Supabase before projecting; without
 * a resolver, the projector falls back to a truncated UUID.
 */
export type RecordResolver = Map<string, string>;

function resolveRecordLabel(id: unknown, resolver?: RecordResolver): string {
  if (!id || typeof id !== "string") return "";
  if (resolver) {
    const name = resolver.get(id);
    if (name) return name;
  }
  // Fallback: short prefix so the row is still identifiable / dedupable.
  return id.slice(0, 8);
}

/**
 * Build a one-line summary string from the payload — the same field
 * preview-extraction the on-host event_router uses, but more discerning
 * about which fields actually narrate a business event.
 *
 * Examples:
 *   BRAVO_OUTBOUND_SENT { channel: "email", to: "h@example.com" }
 *     → "email → h@example.com"
 *   BRAVO_RECORD_STATUS_CHANGED { entity_type: "lead", from: "cold", to: "follow_up" }
 *     → "lead · cold → follow_up"
 *   outbound.recorded { subject: "Re: Funded deal", channel: "email" }
 *     → "email · Re: Funded deal"
 *   BRAVO_EMAIL_OPENED { lead_id: "ff7dcd..." } + resolver
 *     → "Bennett Agency"
 */
function buildSummary(
  eventType: string,
  payload: Record<string, unknown>,
  resolver?: RecordResolver,
): string {
  // Email-engagement events: identify by the lead, not the wire-format UUID.
  if (eventType.startsWith("BRAVO_EMAIL_")) {
    const label = resolveRecordLabel(payload.lead_id || payload.record_id, resolver);
    if (label) return label;
  }

  // Status-change events get arrow notation.
  const from = payload.from || payload.from_stage || payload.previous_stage;
  const to = payload.to || payload.to_stage || payload.new_stage || payload.stage;
  if (from && to) {
    const entity = (payload.entity_type as string) || (payload.entity as string) || "record";
    return `${entity} · ${from} → ${to}`;
  }

  // Outbound: channel → recipient, with subject when present.
  if (eventType.toUpperCase().includes("OUTBOUND") || eventType.startsWith("outbound")) {
    const channel = (payload.channel as string) || "send";
    const to_addr = payload.to || payload.recipient || payload.email;
    const subject = (payload.subject as string) || (payload.preview as string);
    const parts: string[] = [String(channel)];
    if (to_addr) parts.push(`→ ${String(to_addr).slice(0, 60)}`);
    if (subject) parts.push(`· ${String(subject).slice(0, 80)}`);
    return parts.join(" ");
  }

  // Inbound: opposite shape — sender + subject.
  if (eventType.toUpperCase().includes("INBOUND") || eventType.startsWith("inbound")) {
    const from_addr = payload.from || payload.sender;
    const subject = payload.subject;
    if (from_addr && subject) return `${String(from_addr).slice(0, 60)} · ${String(subject).slice(0, 80)}`;
    if (subject) return String(subject).slice(0, 120);
    if (from_addr) return `from ${String(from_addr).slice(0, 60)}`;
  }

  // Session log / pulse — note or kind.
  if (payload.note) return String(payload.note).slice(0, 120);
  if (payload.preview) return String(payload.preview).slice(0, 120);
  if (payload.kind && payload.agent) return `${payload.agent} · ${payload.kind}`;

  // Fallback: a compact key=value sweep over the most-informative fields.
  // lead_id is resolved through the resolver when supplied so the operator
  // sees "Bennett Agency" instead of "ff7dcd57-87b5-4823-…".
  const PREVIEW_KEYS = ["agent", "kind", "lead_id", "client", "platform",
                        "amount_cad", "amount_usd", "net_mrr_usd",
                        "session_id", "invoice_id"];
  const parts: string[] = [];
  for (const k of PREVIEW_KEYS) {
    const v = payload[k];
    if (v === undefined || v === null || v === "") continue;
    let rendered = String(v).slice(0, 40);
    if (k === "lead_id") {
      const resolved = resolveRecordLabel(v, resolver);
      if (resolved) rendered = resolved;
    }
    parts.push(`${k}=${rendered}`);
    if (parts.length >= 3) break;
  }
  return parts.join(" ") || "—";
}

/**
 * Friendly label for an unknown event_type. Strips a leading BRAVO_ /
 * SUNBIZ_ namespace, then converts SCREAMING_SNAKE / kebab-case / dot.path
 * to Sentence case.
 */
function fallbackLabel(eventType: string): string {
  let s = eventType.replace(/^(BRAVO|SUNBIZ|HELIOS|SOLARA|MAVEN|ATLAS)_/i, "");
  s = s.replace(/[._-]+/g, " ").replace(/_/g, " ");
  s = s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Main projector. Always returns a renderable shape — never throws on
 * malformed payloads.
 */
export function projectEvent(
  raw: {
    id: string;
    event_type: string;
    payload?: unknown;
    severity?: string | null;
    source_agent?: string | null;
    publisher_agent?: string | null;
    target_agent?: string | null;
    published_at?: string | null;
    created_at?: string | null;
  },
  resolver?: RecordResolver,
): ProjectedEvent {
  // Normalise payload to a dict.
  let payload: Record<string, unknown> = {};
  if (raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)) {
    payload = raw.payload as Record<string, unknown>;
  } else if (typeof raw.payload === "string") {
    try {
      const parsed = JSON.parse(raw.payload);
      if (parsed && typeof parsed === "object") {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // leave payload as {}
    }
  }

  const label = EVENT_TYPE_LABELS[raw.event_type] || fallbackLabel(raw.event_type);
  const severity = raw.severity || "info";
  return {
    id: raw.id,
    event_type: raw.event_type,
    label,
    summary: buildSummary(raw.event_type, payload, resolver),
    tone: toneFor(raw.event_type, severity),
    severity,
    source_agent: raw.source_agent || raw.publisher_agent || "unknown",
    target_agent: raw.target_agent || "broadcast",
    published_at: raw.published_at || raw.created_at || null,
  };
}

/**
 * Build a RecordResolver from a list of events by batch-querying tenant_records
 * for every lead_id that appears in any payload. Returns a Map keyed by record
 * UUID with the best-available human label (business_name → contact_name → email).
 *
 * Pass a Supabase service client that already scopes by tenant. If the events
 * list is empty or contains no lead_ids, returns an empty Map.
 */
export async function buildRecordResolver(
  db: { from: (table: string) => unknown },
  events: Array<{ payload?: unknown }>,
  options: { tenantId: string | null },
): Promise<RecordResolver> {
  const ids = new Set<string>();
  for (const e of events) {
    if (!e.payload || typeof e.payload !== "object") continue;
    const p = e.payload as Record<string, unknown>;
    const candidate = p.lead_id || p.record_id;
    if (typeof candidate === "string" && candidate.length >= 20) ids.add(candidate);
  }
  if (ids.size === 0 || !options.tenantId) return new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = (db.from("tenant_records") as any)
    .select("id, data")
    .eq("tenant_id", options.tenantId)
    .in("id", Array.from(ids));
  const result = await query;
  if (result.error || !Array.isArray(result.data)) return new Map();

  // OASIS leads use {name, company, email}; Sun Biz leads use
  // {business_name, contact_name, email}. The resolver looks at both
  // shapes so the Activity Tape works for either tenant unchanged.
  const map = new Map<string, string>();
  for (const row of result.data as Array<{ id: string; data: unknown }>) {
    const d = (row.data && typeof row.data === "object" ? row.data : {}) as Record<string, unknown>;
    const label =
      (typeof d.business_name === "string" && d.business_name) ||
      (typeof d.company === "string" && d.company) ||
      (typeof d.name === "string" && d.name) ||
      (typeof d.contact_name === "string" && d.contact_name) ||
      (typeof d.email === "string" && d.email) ||
      "";
    if (label) map.set(row.id, label as string);
  }
  return map;
}
