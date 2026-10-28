"use client";

/**
 * Pick a new time for a founder meeting that did not happen
 * (app/book/rebook/[token]/page.tsx, CC 2026-10-28).
 *
 * The lead already gave us everything when they first booked, so this is the
 * calendar alone: pick a time, confirm, done. The times come from
 * POST /api/forms/booking/rebook/slots for this meeting's length and host; the
 * booking is POST /api/forms/booking/rebook, which MOVES the same meeting (same
 * invite, new time), with one request id per chosen time so a retry replays.
 * Every time is shown in the visitor's own time zone (switchable).
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ZONE_CHOICES } from "@/lib/meeting-time";
import { withRecordingNotice } from "@/lib/meet/recording-notice";
import {
  FALLBACK_ZONE,
  dayKey,
  fmt,
  icsHref,
  newRequestId,
  visitorZone,
  zoneName,
  type Booked,
} from "@/components/booking/BookingPage";

type Props = {
  token: string;
  firstName: string;
  offerLabel: string;
  durationMinutes: number;
  missedAt: string;
};

type SlotState =
  | { status: "loading" }
  | { status: "ready"; slots: string[] }
  | { status: "error"; message: string }
  | { status: "closed" };

function rebookMessage(code: string | undefined): string {
  switch (code) {
    case "rate_limited":
      return "Too many tries in a row. Wait a minute, then try again.";
    case "already_rebooked":
      return "This call is already on the calendar. Refresh the page to see its time.";
    case "rebook_closed":
    case "rebook_unavailable":
      return "This link can no longer book a time. Reply to our email and we will set one up with you.";
    default:
      return "We could not lock that time with Google Calendar. Please try again, or pick another time.";
  }
}

export function RebookPage(props: Props) {
  const [zone, setZone] = useState<string>(FALLBACK_ZONE);
  const [slotState, setSlotState] = useState<SlotState>({ status: "loading" });
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [requestId, setRequestId] = useState<{ slot: string; id: string } | null>(null);

  useEffect(() => setZone(visitorZone()), []);

  const loadSlots = useCallback(async () => {
    setSlotState({ status: "loading" });
    try {
      const res = await fetch("/api/forms/booking/rebook/slots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: props.token }),
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; slots?: unknown; error?: string } | null;
      if (data?.error === "rebook_closed" || data?.error === "already_rebooked") {
        setSlotState({ status: "closed" });
        return;
      }
      if (!data?.ok || !Array.isArray(data.slots)) throw new Error("slots_unavailable");
      setSlotState({ status: "ready", slots: data.slots.filter((s): s is string => typeof s === "string") });
    } catch {
      setSlotState({ status: "error", message: "The calendar could not load. Refresh the page, or try again in a minute." });
    }
  }, [props.token]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  const days = useMemo(() => {
    if (slotState.status !== "ready") return [] as Array<{ key: string; first: string; slots: string[] }>;
    const byDay = new Map<string, string[]>();
    for (const s of slotState.slots) {
      const key = dayKey(s, zone);
      byDay.set(key, [...(byDay.get(key) ?? []), s]);
    }
    return [...byDay.entries()].map(([key, list]) => ({ key, first: list[0], slots: list }));
  }, [slotState, zone]);

  useEffect(() => {
    if (!days.length) return;
    if (!day || !days.some((d) => d.key === day)) setDay(days[0].key);
  }, [days, day]);

  const daySlots = days.find((d) => d.key === day)?.slots ?? [];
  const zoneChoices = useMemo(() => {
    const list = ZONE_CHOICES.map((z) => ({ value: z.timeZone, label: z.label }));
    if (!list.some((z) => z.value === zone)) list.unshift({ value: zone, label: zoneName(zone) });
    return list;
  }, [zone]);

  const book = async () => {
    if (!slot || busy) return;
    setBusy(true);
    setError(null);
    const id = requestId && requestId.slot === slot ? requestId.id : newRequestId();
    setRequestId({ slot, id });
    try {
      const res = await fetch("/api/forms/booking/rebook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: props.token, starts_at: slot, request_id: id }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; starts_at?: string; ends_at?: string; meet_url?: string; call_recorded?: boolean }
        | null;
      if (data?.ok && data.starts_at && data.ends_at && data.meet_url) {
        setBooked({ startsAt: data.starts_at, endsAt: data.ends_at, meetUrl: data.meet_url, recorded: data.call_recorded === true });
        return;
      }
      if (data?.error === "slot_unavailable") {
        setRequestId(null);
        setSlot(null);
        setNotice("That time was just taken. Here are the times still open.");
        await loadSlots();
        return;
      }
      if (data?.error === "retry_required") setRequestId(null);
      setError(rebookMessage(data?.error));
    } catch {
      setError("Your connection dropped before we heard back. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const callTitle = `${props.durationMinutes}-minute call with OASIS AI`;
  const hello = props.firstName ? `${props.firstName}, pick` : "Pick";

  if (booked) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-5 py-16">
        <p className="m-eyebrow font-data text-[10px] uppercase tracking-[0.26em] text-signal">Booked</p>
        <h1 className="mt-5 font-display text-[2rem] font-semibold leading-tight tracking-[-0.02em] text-fg">
          You&apos;re back on our calendar.
        </h1>
        <div className="mt-8 rounded-lg border border-ops-line bg-ops-panel p-5">
          <p className="font-display text-lg font-semibold text-fg">
            {fmt(booked.startsAt, zone, { weekday: "long", month: "long", day: "numeric" })}
          </p>
          <p className="mt-1 text-[15px] text-fg-muted">
            {fmt(booked.startsAt, zone, { hour: "numeric", minute: "2-digit" })} to{" "}
            {fmt(booked.endsAt, zone, { hour: "numeric", minute: "2-digit" })} ({zoneName(zone)})
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <a
              href={booked.meetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-md bg-signal px-5 py-2.5 text-[15px] font-semibold text-ops-void hover:brightness-110"
            >
              Join the call
            </a>
            <a
              href={icsHref(booked, callTitle)}
              download="oasis-call.ics"
              className="inline-flex items-center justify-center rounded-md border border-ops-edge px-5 py-2.5 text-[15px] font-medium text-fg-muted hover:text-fg"
            >
              Add to calendar
            </a>
          </div>
        </div>
        <p className="mt-6 text-[15px] leading-relaxed text-fg-muted">
          {withRecordingNotice(
            "The updated calendar invite is on its way to your inbox, and we will remind you before the call.",
            booked.recorded,
          )}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="m-eyebrow font-data text-[10px] uppercase tracking-[0.26em] text-signal">OASIS AI</p>
      <h1 className="mt-5 font-display text-[2rem] font-semibold leading-[1.1] tracking-[-0.02em] text-fg sm:text-[2.4rem]">
        {hello} a new time for your {props.offerLabel}.
      </h1>
      <p className="mt-4 max-w-xl text-[16px] leading-relaxed text-fg-muted">
        We missed each other on {fmt(props.missedAt, zone, { weekday: "long", month: "long", day: "numeric" })}. Choose
        any open time below and the same video call link moves with it. {props.durationMinutes} minutes, on video.
      </p>

      <div className="mt-6 flex max-w-sm items-center gap-3 text-[14px]">
        <label htmlFor="rebook-zone" className="shrink-0 font-data text-[11px] uppercase tracking-[0.18em] text-fg-dim">
          Time zone
        </label>
        <select
          id="rebook-zone"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          className="w-full rounded-md border border-ops-line bg-ops-panel px-2.5 py-1.5 text-[14px] text-fg focus:border-signal focus:outline-none"
        >
          {zoneChoices.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
      </div>

      <section aria-label="Pick a time" className="mt-6 rounded-xl border border-ops-line bg-ops-panel p-4 sm:p-6">
        {notice ? (
          <p role="status" className="mb-4 rounded-md border border-signal/30 bg-signal/5 px-3 py-2 text-[14px] text-fg">
            {notice}
          </p>
        ) : null}
        {slotState.status === "loading" ? (
          <div className="space-y-3" aria-busy="true">
            <div className="h-16 animate-pulse rounded-md bg-ops-raised" />
            <div className="h-28 animate-pulse rounded-md bg-ops-raised" />
          </div>
        ) : slotState.status === "closed" ? (
          <p className="text-[15px] text-fg-muted">
            This link can no longer book a time. Reply to our email and we will set one up with you.
          </p>
        ) : slotState.status === "error" ? (
          <div>
            <p className="text-[15px] text-fg-muted">{slotState.message}</p>
            <button
              type="button"
              onClick={() => void loadSlots()}
              className="mt-4 rounded-md border border-ops-edge px-4 py-2 text-[14px] text-fg hover:border-fg-dim"
            >
              Try again
            </button>
          </div>
        ) : days.length === 0 ? (
          <p className="text-[15px] text-fg-muted">
            Every open time is taken right now. Reply to our email and we will make room for you.
          </p>
        ) : (
          <>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2" role="tablist" aria-label="Days">
              {days.map((d) => {
                const active = d.key === day;
                return (
                  <button
                    key={d.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setDay(d.key)}
                    className={`flex min-w-[4.75rem] shrink-0 flex-col items-center rounded-lg border px-3 py-2.5 transition-colors ${
                      active
                        ? "border-signal bg-signal/10 text-fg"
                        : "border-ops-line bg-ops-void text-fg-muted hover:border-ops-edge hover:text-fg"
                    }`}
                  >
                    <span className="font-data text-[10px] uppercase tracking-[0.18em]">{fmt(d.first, zone, { weekday: "short" })}</span>
                    <span className="mt-0.5 font-display text-xl font-semibold">{fmt(d.first, zone, { day: "numeric" })}</span>
                    <span className="text-[11px]">{fmt(d.first, zone, { month: "short" })}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4" role="tabpanel">
              {daySlots.map((s) => {
                const active = s === slot;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setSlot(s);
                      setError(null);
                      setNotice(null);
                    }}
                    aria-pressed={active}
                    className={`rounded-md border px-2 py-2.5 text-[14px] font-medium tabular-nums transition-colors ${
                      active ? "border-signal bg-signal text-ops-void" : "border-ops-line bg-ops-void text-fg hover:border-signal/60"
                    }`}
                  >
                    {fmt(s, zone, { hour: "numeric", minute: "2-digit" })}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </section>

      {slot ? (
        <div className="mt-6 rounded-xl border border-ops-line bg-ops-panel p-4 sm:p-6">
          <p className="font-data text-[10px] uppercase tracking-[0.18em] text-signal">Your new time</p>
          <p className="mt-1 font-display text-[17px] font-semibold text-fg">
            {`${fmt(slot, zone, { weekday: "long", month: "long", day: "numeric" })} at ${fmt(slot, zone, { hour: "numeric", minute: "2-digit" })}`}
          </p>
          {error ? (
            <p role="alert" className="mt-4 rounded-md border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-[14px] text-fg">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => void book()}
            disabled={busy}
            className="mt-5 inline-flex w-full items-center justify-center rounded-md bg-signal px-6 py-3 text-[15px] font-semibold tracking-[-0.01em] text-ops-void transition-all hover:brightness-110 disabled:opacity-60 sm:w-auto"
          >
            {busy ? "Booking..." : "Book this time"}
          </button>
        </div>
      ) : null}
    </main>
  );
}
