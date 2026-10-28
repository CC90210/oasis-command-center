/**
 * lib/os/agent-ops.ts - what Admin > Agent ops says about a directive and an agent's action (2026-10-28).
 *
 * PURE: no database, no session, no clock of its own (every function takes `now`), so the delivery
 * states and the action diff are proven at exact instants (tests/agent-ops-hub.test.ts).
 *
 * ONE STATE PER NOTE, and only what the record proves. A note the operator posted for an agent with a
 * local reader is relayed by the agents owner's computer (app/api/bridge/inbox, bravo_cli/inbox_relay.py):
 * Waiting, then Delivered, then Read. Everything else says plainly that no computer carries it, rather
 * than looking like it is on its way.
 */
import { isRelayRecipient, type DbInboxMessage } from "@/lib/agent-inbox-db";
import { machineState, timeAgo } from "@/lib/devices/presence";
import { redactAll } from "@/lib/secret-redaction";

/** When delivery began (bravo__246): a note posted before it was never going to be relayed. */
export const DELIVERY_STARTED_AT = "2026-10-28T00:00:00.000Z";

const AGENT_NAMES: Record<string, string> = {
  bravo: "Bravo",
  atlas: "Atlas",
  maven: "Maven",
  aura: "Aura",
  codex: "Codex",
  "life-preservation": "Life preservation",
  broadcast: "every agent",
  cc: "You",
};

/** An agent slug as a person reads it. */
export function agentName(slug: string): string {
  const key = slug.trim().toLowerCase();
  return AGENT_NAMES[key] ?? key;
}

/** The computer that delivers notes: the agents owner's most recently seen approved pairing. */
export type DeliveryComputer = {
  label: string;
  lastSeenAt: string | null;
  /** Its bridge advertises agent_inbox_v1, i.e. it runs the relay. */
  deliversNotes: boolean;
};

export type DeliveryTone = "neutral" | "info" | "warm" | "engaged";
export type DeliveryState = { key: string; tone: DeliveryTone; text: string };

type NoteFacts = Pick<
  DbInboxMessage,
  "to_agent" | "created_at" | "read_at" | "relay_eligible" | "delivered_at" | "delivered_label" | "acked_at" | "read_via"
>;

/** The one time-ago wording (lib/devices/presence.ts timeAgo), at this render's clock. */
const stamp = (iso: string | null | undefined, now: number) => timeAgo(iso ?? null, { now });

/**
 * What happened to this note, in one sentence. `computer` is null when the
 * workspace has no agents owner computer (or it could not be read: the caller
 * passes `undefined` then, and a waiting note says it could not check).
 */
export function deliveryStateOf(note: NoteFacts, computer: DeliveryComputer | null | undefined, now: number): DeliveryState {
  const who = agentName(note.to_agent);
  // The agent's own receipt first: it outranks a dismissal made after the note was delivered.
  if (note.acked_at) return { key: "read", tone: "engaged", text: `Read by ${who} · ${stamp(note.acked_at, now)}` };
  if (note.read_at && note.read_via === "dashboard") {
    return { key: "dismissed", tone: "neutral", text: `Dismissed here · ${stamp(note.read_at, now)}` };
  }
  if (note.read_at && note.read_via === "cloud_chat") {
    return { key: "read_cloud", tone: "engaged", text: `Read by ${who} in a cloud chat · ${stamp(note.read_at, now)}` };
  }
  if (note.read_at) return { key: "read_earlier", tone: "engaged", text: `Read · ${stamp(note.read_at, now)}` };
  if (note.delivered_at) {
    return {
      key: "delivered",
      tone: "info",
      text: `Delivered to ${note.delivered_label || "your computer"} · ${stamp(note.delivered_at, now)}, not read yet`,
    };
  }
  if (note.to_agent.trim().toLowerCase() === "cc") return { key: "for_you", tone: "warm", text: "For you · not read yet" };
  const relayed = note.relay_eligible === 1 || note.relay_eligible === true;
  if (!relayed) {
    if (Date.parse(note.created_at) < Date.parse(DELIVERY_STARTED_AT)) {
      return { key: "before_delivery", tone: "neutral", text: "Posted before delivery existed" };
    }
    if (!isRelayRecipient(note.to_agent)) {
      return { key: "no_reader", tone: "neutral", text: `No computer delivers to ${who}; a cloud chat with ${who} reads it` };
    }
    return { key: "agent_note", tone: "neutral", text: "An agent's note: it stays here and is never sent to a computer" };
  }
  if (computer === undefined) return { key: "waiting_unknown", tone: "warm", text: "Waiting for delivery (couldn't check your computer just now)" };
  if (computer === null) return { key: "no_computer", tone: "warm", text: "Waiting: no computer is set up to deliver it" };
  if (!computer.deliversNotes) {
    return { key: "old_bridge", tone: "warm", text: `Waiting: ${computer.label}'s bridge predates delivery, so restart it to update` };
  }
  if (machineState(computer.lastSeenAt, now) === "online") {
    return { key: "waiting", tone: "info", text: `Waiting for ${computer.label} to pick it up, within a minute` };
  }
  return {
    key: "waiting_offline",
    tone: "warm",
    text: computer.lastSeenAt
      ? `Waiting for ${computer.label}, offline since ${timeAgo(computer.lastSeenAt, { now, moment: true })}`
      : `Waiting for ${computer.label}, which has not checked in yet`,
  };
}

/** One changed top-level key of an action's before/after. Values are short, display-ready text. */
export type KeyChange = { key: string; change: "added" | "removed" | "changed"; before: string | null; after: string | null };

const VALUE_CHARS = 120;

/** The whole value as text, type kept (1 and "1" differ): what two values are compared by. */
function serialized(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A value for display: the WHOLE text scrubbed of secrets first, then shortened, so a credential that
 * crosses the cut is still recognised whole (Codex review of #768). Strings show without quotes.
 */
function shown(value: unknown): string {
  const text = redactAll(typeof value === "string" ? value : serialized(value));
  return text.length > VALUE_CHARS ? `${text.slice(0, VALUE_CHARS - 1)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The top-level keys an action changed, sorted by key. A before or after that is not an object is
 * compared as one value under the key "value". At most `limit` changes; the caller says how many more.
 */
export function keyChanges(before: unknown, after: unknown, limit = 12): { changes: KeyChange[]; more: number } {
  const b = asRecord(before) ?? (before === undefined || before === null ? {} : { value: before });
  const a = asRecord(after) ?? (after === undefined || after === null ? {} : { value: after });
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const changes: KeyChange[] = [];
  for (const key of keys) {
    const inB = Object.prototype.hasOwnProperty.call(b, key);
    const inA = Object.prototype.hasOwnProperty.call(a, key);
    if (inB && inA) {
      // Compared whole and typed; only a real change is then formatted.
      if (serialized(b[key]) !== serialized(a[key])) changes.push({ key, change: "changed", before: shown(b[key]), after: shown(a[key]) });
    } else if (inA) {
      changes.push({ key, change: "added", before: null, after: shown(a[key]) });
    } else {
      changes.push({ key, change: "removed", before: shown(b[key]), after: null });
    }
  }
  return { changes: changes.slice(0, limit), more: Math.max(0, changes.length - limit) };
}
