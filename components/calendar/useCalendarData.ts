"use client";

/**
 * Client state for the calendar: one load, optimistic writes, rollback on
 * failure, and undo. Every event change is a batch of ops sent to
 * POST /api/calendar/events; the server re-validates and enforces Shabbat.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { inputOf } from "@/lib/calendar/recurrence";
import {
  DEFAULT_PREFS,
  type CalendarColor,
  type CalendarPrefs,
  type CalendarRecord,
  type EventOp,
  type EventRecord,
} from "@/lib/calendar/types";

export type LoadState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; code: string; message: string };

type ApiError = { ok: false; error: string; detail?: string };

export class CalendarApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new CalendarApiError("offline", "Could not reach the server. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as (T & { ok?: boolean }) | ApiError | null;
  if (!res.ok || !body || body.ok === false) {
    const err = body as ApiError | null;
    throw new CalendarApiError(err?.error ?? `http_${res.status}`, messageFor(err?.error ?? "", err?.detail));
  }
  return body as T;
}

export function messageFor(code: string, detail?: string): string {
  switch (code) {
    case "shabbat_protected":
      return "That time is inside Shabbat, which is protected. Pick another time.";
    case "calendar_storage_missing":
      return "Calendar storage is not set up on this database yet (migration 186).";
    case "unauthorized":
      return "Your session has ended. Sign in again to see your calendar.";
    case "default_calendar_protected":
      return "Your main calendar cannot be deleted.";
    case "calendar_delete_too_large":
      return "This calendar was not deleted: you have more than 5,000 events, and deleting from a partial list could leave some behind.";
    case "calendar_limit_reached":
      return "You have reached the 50-calendar limit.";
    case "event_not_found":
      return "That event no longer exists. The calendar has been refreshed.";
    case "cross_origin_refused":
      return "The request was refused because it did not come from this site.";
    default:
      return detail && detail.includes("changes saved")
        ? `Only part of that change saved (${detail.split(": ").pop()}). The calendar has been refreshed.`
        : "That change could not be saved. Nothing was lost; try again.";
  }
}

type OpResult = { op: EventOp["op"]; id: string; tempId?: string; event?: EventRecord };

let tempSeq = 0;
const tempId = () => `tmp-${Date.now().toString(36)}-${(tempSeq++).toString(36)}`;

/** Apply ops to a local row set, returning the new rows. */
function applyLocal(rows: EventRecord[], ops: EventOp[], ids: string[]): EventRecord[] {
  let next = rows;
  const now = new Date().toISOString();
  ops.forEach((op, i) => {
    if (op.op === "create") next = [...next, { ...op.event, id: ids[i], createdAt: now, updatedAt: now }];
    else if (op.op === "update") next = next.map((r) => (r.id === op.id ? { ...r, ...op.patch, updatedAt: now } : r));
    else next = next.filter((r) => r.id !== op.id);
  });
  return next;
}

/** Ops that reverse `ops`, given the rows as they were before. */
function inverseOps(before: EventRecord[], ops: EventOp[], results: OpResult[]): EventOp[] {
  const inv: EventOp[] = [];
  ops.forEach((op, i) => {
    const res = results[i];
    if (op.op === "create") inv.push({ op: "delete", id: res.id });
    else if (op.op === "update") {
      const prev = before.find((r) => r.id === op.id);
      if (prev) inv.push({ op: "update", id: op.id, patch: inputOf(prev) });
    } else {
      const prev = before.find((r) => r.id === op.id);
      // The deleted row's old id becomes a tempId, so overrides recreated in the
      // same batch re-attach to the recreated master (the server maps it).
      if (prev) inv.push({ op: "create", tempId: prev.id, event: inputOf(prev) });
    }
  });
  return inv.reverse();
}

export function useCalendarData() {
  const [calendars, setCalendars] = useState<CalendarRecord[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [prefs, setPrefs] = useState<CalendarPrefs>(DEFAULT_PREFS);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [truncated, setTruncated] = useState(false);
  const [saving, setSaving] = useState(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  // Saves run one at a time. With two in flight, rolling one back to its
  // snapshot would undo the other; serialized, each snapshot is exact.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const reload = useCallback(async () => {
    try {
      const data = await call<{ calendars: CalendarRecord[]; events: EventRecord[]; prefs: CalendarPrefs; truncated: boolean }>("/api/calendar");
      setCalendars(data.calendars);
      eventsRef.current = data.events;
      setEvents(data.events);
      setPrefs(data.prefs);
      setTruncated(data.truncated);
      setLoad({ status: "ready" });
    } catch (err) {
      const e = err instanceof CalendarApiError ? err : new CalendarApiError("unknown", "The calendar could not load.");
      setLoad({ status: "error", code: e.code, message: e.message });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Optimistically applies ops, persists them, and returns the inverse ops for
   * undo. On failure the local state is restored and the error rethrown.
   */
  const commitNow = useCallback(
    async (ops: EventOp[]): Promise<EventOp[]> => {
      const before = eventsRef.current;
      const ids = ops.map((op) => (op.op === "create" ? tempId() : op.op === "update" || op.op === "delete" ? op.id : ""));
      // Map optimistic temp ids onto server-side tempIds so overrides can
      // reference a master created in the same batch.
      const withTemp = ops.map((op, i) => (op.op === "create" && !op.tempId ? { ...op, tempId: ids[i] } : op));
      // Write the ref as well as state: the next queued commit starts in a
      // microtask, before React renders, and must see these rows, not the
      // previous render's (which still hold temp ids).
      const optimistic = applyLocal(before, withTemp, ids);
      eventsRef.current = optimistic;
      setEvents(optimistic);
      setSaving((n) => n + 1);
      try {
        const { results } = await call<{ results: OpResult[] }>("/api/calendar/events", {
          method: "POST",
          body: JSON.stringify({ ops: withTemp }),
        });
        let next = eventsRef.current;
        results.forEach((r, i) => {
          if (r.op === "create" && r.event) next = next.map((row) => (row.id === ids[i] ? r.event! : row));
          else if (r.op === "update" && r.event) next = next.map((row) => (row.id === r.id ? r.event! : row));
        });
        eventsRef.current = next;
        setEvents(next);
        return inverseOps(before, withTemp, results);
      } catch (err) {
        eventsRef.current = before;
        setEvents(before);
        // Re-read after any failure: the server is the truth, and a partial
        // batch or a concurrent change elsewhere must not linger locally.
        void reload();
        throw err;
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [reload],
  );

  const commit = useCallback(
    (ops: EventOp[]): Promise<EventOp[]> => {
      const next = queue.current.then(() => commitNow(ops));
      queue.current = next.catch(() => undefined);
      return next;
    },
    [commitNow],
  );

  const addCalendar = useCallback(async (name: string, color: CalendarColor) => {
    const { calendar } = await call<{ calendar: CalendarRecord }>("/api/calendar/calendars", {
      method: "POST",
      body: JSON.stringify({ name, color }),
    });
    setCalendars((c) => [...c, calendar]);
    return calendar;
  }, []);

  const patchCalendar = useCallback(async (id: string, patch: Partial<Pick<CalendarRecord, "name" | "color" | "visible">>) => {
    let before: CalendarRecord[] = [];
    setCalendars((c) => {
      before = c;
      return c.map((x) => (x.id === id ? { ...x, ...patch } : x));
    });
    try {
      await call(`/api/calendar/calendars/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
    } catch (err) {
      setCalendars(before);
      throw err;
    }
  }, []);

  const removeCalendar = useCallback(async (id: string) => {
    await call(`/api/calendar/calendars/${encodeURIComponent(id)}`, { method: "DELETE" });
    // The server also removed overrides in other calendars and added
    // exceptions to surviving series; re-read rather than guess.
    await reload();
  }, [reload]);

  const savePrefs = useCallback(async (next: CalendarPrefs) => {
    const { prefs: saved } = await call<{ prefs: CalendarPrefs }>("/api/calendar/prefs", {
      method: "PUT",
      body: JSON.stringify(next),
    });
    setPrefs(saved);
  }, []);

  return {
    calendars,
    events,
    prefs,
    load,
    truncated,
    saving: saving > 0,
    reload,
    commit,
    addCalendar,
    patchCalendar,
    removeCalendar,
    savePrefs,
  };
}

export type CalendarData = ReturnType<typeof useCalendarData>;
