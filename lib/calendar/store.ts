/**
 * Turso persistence for the calendar (migration 186).
 *
 * Every query filters on tenant_id AND user_id: a calendar is private to the
 * user who owns it, and with no row-level security in Turso the filter is the
 * authorization boundary. Reads fail loudly (CalendarStoreError); nothing
 * here converts a storage fault into an empty calendar.
 */

import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  DEFAULT_PREFS,
  type CalendarColor,
  type CalendarPrefs,
  type CalendarRecord,
  type EventInput,
  type EventOp,
  type EventRecord,
  type Recurrence,
} from "./types";
import { LIMITS, shabbatConflict, validateEventInput, validatePrefs } from "./validate";

export class CalendarStoreError extends Error {
  constructor(readonly code: string, readonly status = 500, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CalendarStoreError";
  }
}

export type Owner = { tenantId: string; userId: string };

const MAX_EVENTS = 5000;

function storageError(error: { message?: string } | null, code: string): never {
  const msg = error?.message ?? "unknown";
  // A missing table means migration 186 has not been applied to this database.
  if (/no such table|does not exist|relation .* not found/i.test(msg))
    throw new CalendarStoreError("calendar_storage_missing", 503, "apply database/turso/186_calendar.turso.sql");
  throw new CalendarStoreError(code, 500, msg);
}

const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

function json<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v !== "string") return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

type CalendarRow = Record<string, unknown>;
type EventRow = Record<string, unknown>;

function toCalendar(r: CalendarRow): CalendarRecord {
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    color: String(r.color) as CalendarColor,
    visible: bool(r.visible),
    isDefault: bool(r.is_default),
    position: Number(r.position) || 0,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toEvent(r: EventRow): EventRecord {
  return {
    id: String(r.id),
    calendarId: String(r.calendar_id),
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    location: String(r.location ?? ""),
    allDay: bool(r.all_day),
    start: String(r.start_at),
    end: String(r.end_at),
    timeZone: String(r.time_zone),
    recurrence: json<Recurrence | null>(r.recurrence, null),
    exdates: json<string[]>(r.exdates, []),
    recurringEventId: (r.recurring_event_id as string | null) ?? null,
    originalStart: (r.original_start as string | null) ?? null,
    color: ((r.color as string | null) ?? null) as CalendarColor | null,
    reminders: json<number[]>(r.reminders, []),
    guests: json<string[]>(r.guests, []),
    busy: bool(r.busy),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function eventColumns(e: EventInput) {
  return {
    calendar_id: e.calendarId,
    title: e.title,
    description: e.description,
    location: e.location,
    all_day: e.allDay ? 1 : 0,
    start_at: e.start,
    end_at: e.end,
    time_zone: e.timeZone,
    recurrence: e.recurrence ? JSON.stringify(e.recurrence) : null,
    exdates: JSON.stringify(e.exdates),
    recurring_event_id: e.recurringEventId,
    original_start: e.originalStart,
    color: e.color,
    reminders: JSON.stringify(e.reminders),
    guests: JSON.stringify(e.guests),
    busy: e.busy ? 1 : 0,
  };
}

// ── Calendars ─────────────────────────────────────────────────────────────

export async function listCalendars(owner: Owner): Promise<CalendarRecord[]> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("calendar_calendars")
    .select("*")
    .eq("tenant_id", owner.tenantId)
    .eq("user_id", owner.userId)
    .order("position", { ascending: true });
  if (error) storageError(error, "calendar_read_failed");
  const rows = ((data ?? []) as CalendarRow[]).map(toCalendar);
  if (rows.length) return rows;
  // First visit: give the user one calendar to put things in. The id is
  // derived from the owner, so two first loads racing each other collide on
  // the primary key instead of creating two defaults; the loser re-reads.
  const id = `default-${createHash("sha256").update(`${owner.tenantId}|${owner.userId}`).digest("hex").slice(0, 40)}`;
  try {
    return [await createCalendar(owner, { name: "Personal", color: "tide", isDefault: true, id })];
  } catch (err) {
    const again = await db
      .from("calendar_calendars")
      .select("*")
      .eq("tenant_id", owner.tenantId)
      .eq("user_id", owner.userId)
      .order("position", { ascending: true });
    if (again.error || !again.data?.length) throw err;
    return (again.data as CalendarRow[]).map(toCalendar);
  }
}

export async function createCalendar(
  owner: Owner,
  input: { name: string; color: CalendarColor; isDefault?: boolean; id?: string },
): Promise<CalendarRecord> {
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const existing = await db
    .from("calendar_calendars")
    .select("id,position")
    .eq("tenant_id", owner.tenantId)
    .eq("user_id", owner.userId);
  if (existing.error) storageError(existing.error, "calendar_read_failed");
  const rows = (existing.data ?? []) as CalendarRow[];
  if (rows.length >= LIMITS.calendars) throw new CalendarStoreError("calendar_limit_reached", 409);
  const row = {
    id: input.id ?? randomUUID(),
    tenant_id: owner.tenantId,
    user_id: owner.userId,
    name: input.name,
    color: input.color,
    visible: 1,
    is_default: input.isDefault ? 1 : 0,
    position: rows.reduce((m, r) => Math.max(m, Number(r.position) || 0), -1) + 1,
    created_at: now,
    updated_at: now,
  };
  const { error } = await db.from("calendar_calendars").insert(row);
  if (error) storageError(error, "calendar_write_failed");
  return toCalendar(row);
}

export async function updateCalendar(
  owner: Owner,
  id: string,
  patch: Partial<Pick<CalendarRecord, "name" | "color" | "visible">>,
): Promise<void> {
  const db = getServiceSupabase();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.color !== undefined) row.color = patch.color;
  if (patch.visible !== undefined) row.visible = patch.visible ? 1 : 0;
  const { data, error } = await db
    .from("calendar_calendars")
    .update(row)
    .eq("tenant_id", owner.tenantId)
    .eq("user_id", owner.userId)
    .eq("id", id)
    .select("id");
  if (error) storageError(error, "calendar_write_failed");
  if (!data || (data as unknown[]).length === 0) throw new CalendarStoreError("calendar_not_found", 404);
}

/** Deletes a calendar and every event in it. The default calendar cannot go. */
export async function deleteCalendar(owner: Owner, id: string): Promise<void> {
  const cals = await listCalendars(owner);
  const cal = cals.find((c) => c.id === id);
  if (!cal) throw new CalendarStoreError("calendar_not_found", 404);
  if (cal.isDefault) throw new CalendarStoreError("default_calendar_protected", 409);
  const db = getServiceSupabase();
  const ev = await db
    .from("calendar_events")
    .delete()
    .eq("tenant_id", owner.tenantId)
    .eq("user_id", owner.userId)
    .eq("calendar_id", id);
  if (ev.error) storageError(ev.error, "calendar_write_failed");
  const { error } = await db
    .from("calendar_calendars")
    .delete()
    .eq("tenant_id", owner.tenantId)
    .eq("user_id", owner.userId)
    .eq("id", id);
  if (error) storageError(error, "calendar_write_failed");
}

// ── Events ────────────────────────────────────────────────────────────────

export async function listEvents(owner: Owner): Promise<{ events: EventRecord[]; truncated: boolean }> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("calendar_events")
    .select("*")
    .eq("tenant_id", owner.tenantId)
    .eq("user_id", owner.userId)
    .order("start_at", { ascending: true })
    .limit(MAX_EVENTS + 1);
  if (error) storageError(error, "event_read_failed");
  const rows = (data ?? []) as EventRow[];
  return { events: rows.slice(0, MAX_EVENTS).map(toEvent), truncated: rows.length > MAX_EVENTS };
}

async function getEvent(owner: Owner, id: string): Promise<EventRecord | null> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("calendar_events")
    .select("*")
    .eq("tenant_id", owner.tenantId)
    .eq("user_id", owner.userId)
    .eq("id", id)
    .maybeSingle();
  if (error) storageError(error, "event_read_failed");
  return data ? toEvent(data as EventRow) : null;
}

export type OpResult = { op: EventOp["op"]; id: string; tempId?: string; event?: EventRecord };

/**
 * Applies a planned batch in order. The planner orders creates before the
 * truncation of an old series, so a failure part-way never loses an event;
 * the error names how many ops landed so the client can reload.
 */
export async function applyOps(owner: Owner, ops: EventOp[], prefs: CalendarPrefs): Promise<OpResult[]> {
  const db = getServiceSupabase();
  const calendars = new Set((await listCalendars(owner)).map((c) => c.id));
  const tempIds = new Map<string, string>();
  const results: OpResult[] = [];

  const check = (input: EventInput) => {
    if (!calendars.has(input.calendarId)) throw new CalendarStoreError("calendar_not_found", 404);
    const hit = shabbatConflict(input, prefs);
    if (hit) throw new CalendarStoreError("shabbat_protected", 409, `overlaps ${hit.start.toISOString()} - ${hit.end.toISOString()}`);
  };

  for (const [index, op] of ops.entries()) {
    try {
      if (op.op === "create") {
        const input = { ...op.event };
        if (input.recurringEventId && tempIds.has(input.recurringEventId))
          input.recurringEventId = tempIds.get(input.recurringEventId)!;
        check(input);
        const now = new Date().toISOString();
        const id = randomUUID();
        const row = { id, tenant_id: owner.tenantId, user_id: owner.userId, ...eventColumns(input), created_at: now, updated_at: now };
        const { error } = await db.from("calendar_events").insert(row);
        if (error) storageError(error, "event_write_failed");
        if (op.tempId) tempIds.set(op.tempId, id);
        results.push({ op: "create", id, tempId: op.tempId, event: toEvent(row) });
      } else if (op.op === "update") {
        const current = await getEvent(owner, op.id);
        if (!current) throw new CalendarStoreError("event_not_found", 404);
        const { id: _i, createdAt: _c, updatedAt: _u, ...base } = current;
        const merged = validateEventInput({ ...base, ...op.patch });
        if (!merged.ok) throw new CalendarStoreError(merged.error, 400);
        check(merged.value);
        const now = new Date().toISOString();
        const { error } = await db
          .from("calendar_events")
          .update({ ...eventColumns(merged.value), updated_at: now })
          .eq("tenant_id", owner.tenantId)
          .eq("user_id", owner.userId)
          .eq("id", op.id);
        if (error) storageError(error, "event_write_failed");
        results.push({ op: "update", id: op.id, event: { ...merged.value, id: op.id, createdAt: current.createdAt, updatedAt: now } });
      } else {
        const { error } = await db
          .from("calendar_events")
          .delete()
          .eq("tenant_id", owner.tenantId)
          .eq("user_id", owner.userId)
          .eq("id", op.id);
        if (error) storageError(error, "event_write_failed");
        results.push({ op: "delete", id: op.id });
      }
    } catch (err) {
      if (err instanceof CalendarStoreError && index > 0)
        throw new CalendarStoreError(err.code, err.status, `${index} of ${ops.length} changes saved before this failed`);
      throw err;
    }
  }
  return results;
}

// ── Preferences ───────────────────────────────────────────────────────────

const prefsId = (owner: Owner) => `${owner.tenantId}:${owner.userId}`;

export async function getPrefs(owner: Owner): Promise<CalendarPrefs> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("calendar_prefs")
    .select("prefs")
    .eq("tenant_id", owner.tenantId)
    .eq("user_id", owner.userId)
    .maybeSingle();
  if (error) storageError(error, "prefs_read_failed");
  if (!data) return DEFAULT_PREFS;
  const parsed = validatePrefs(json<unknown>((data as Record<string, unknown>).prefs, {}));
  // A stored value that no longer validates must not silently disable the
  // Shabbat lock: fall back to the protective defaults.
  return parsed.ok ? parsed.value : DEFAULT_PREFS;
}

export async function savePrefs(owner: Owner, prefs: CalendarPrefs): Promise<void> {
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const existing = await db
    .from("calendar_prefs")
    .select("id")
    .eq("tenant_id", owner.tenantId)
    .eq("user_id", owner.userId)
    .maybeSingle();
  if (existing.error) storageError(existing.error, "prefs_read_failed");
  const { error } = existing.data
    ? await db
        .from("calendar_prefs")
        .update({ prefs: JSON.stringify(prefs), updated_at: now })
        .eq("tenant_id", owner.tenantId)
        .eq("user_id", owner.userId)
    : await db.from("calendar_prefs").insert({
        id: prefsId(owner),
        tenant_id: owner.tenantId,
        user_id: owner.userId,
        prefs: JSON.stringify(prefs),
        updated_at: now,
      });
  if (error) storageError(error, "prefs_write_failed");
}
