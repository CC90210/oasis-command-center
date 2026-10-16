"use client";

/**
 * The public booking link, oasisai.work/book (app/book/page.tsx).
 *
 * Calendar first: the visitor sees real open times before typing anything,
 * picks one, gives four details, and is booked. Every time shown is in the
 * VISITOR's time zone (switchable); the server stores and books UTC instants.
 *
 * Two requests make the booking, both existing public routes:
 *   1. POST /api/forms/submit (anonymous_init, the "book" form, step 0): the
 *      lead is created or matched by email/phone and a signed token minted;
 *      the consent boxes are recorded in the consent ledger here.
 *   2. POST /api/forms/booking {token, starts_at, request_id}: availability is
 *      re-read fresh, the Google Meet is created, the lead moves to "Founder
 *      meeting booked", the call lands on the hosts' Schedule.
 * A failed step 2 never loses the visitor: the lead already exists, the chosen
 * details stay filled in, and a taken slot sends them back to fresh times.
 * When no time can be shown at all (the calendar cannot be read, or every
 * time is taken), the visitor can still leave their details: step 1 alone
 * puts them in Sales as a warm inbound lead, so a broken calendar never
 * turns a ready buyer away with nothing recorded.
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { consentDisclosureText, type ConsentChannel, type ConsentIdentity } from "@/lib/consent/ledger-disclosure";
import { ZONE_CHOICES } from "@/lib/meeting-time";

export type BookingField = {
  name: string;
  label: string;
  type: "text" | "email" | "phone" | "select" | "textarea";
  required: boolean;
  placeholder: string;
  help: string;
  maxLength: number | null;
  options: { value: string; label: string }[];
};

type Attribution = {
  rep?: string;
  source?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  kw?: string;
};

type Props = {
  tenantSlug: string;
  formSlug: string;
  durationMinutes: number;
  headline: string;
  subheadline: string;
  thanksMessage: string;
  fields: BookingField[];
  consentIdentity: ConsentIdentity;
  attribution: Attribution;
};

type SlotState =
  | { status: "loading" }
  | { status: "ready"; slots: string[] }
  | { status: "error"; message: string };

type Booked = { startsAt: string; endsAt: string; meetUrl: string };

const FALLBACK_ZONE = "America/Toronto";
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function visitorZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE;
  }
}

function fmt(iso: string, zone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: FALLBACK_ZONE, ...options }).format(new Date(iso));
  }
}

function dayKey(iso: string, zone: string): string {
  return fmt(iso, zone, { year: "numeric", month: "2-digit", day: "2-digit" });
}

function zoneName(zone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "long" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");
    return part?.value || zone;
  } catch {
    return zone;
  }
}

function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // RFC 4122 v4 from getRandomValues (the booking route accepts v4 only).
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function icsStamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsHref(booked: Booked, title: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//OASIS AI//Booking//EN",
    "BEGIN:VEVENT",
    // Stable per booking (the Meet code + start). No "@domain": it would read as
    // an unverified mailbox (tests/verified-mailboxes.test.ts), and RFC 5545
    // only asks that a UID be globally unique.
    `UID:oasis-booking-${booked.meetUrl.replace(/[^a-z0-9-]/gi, "").slice(-24)}-${icsStamp(booked.startsAt)}`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(booked.startsAt)}`,
    `DTEND:${icsStamp(booked.endsAt)}`,
    `SUMMARY:${title}`,
    `LOCATION:${booked.meetUrl}`,
    `DESCRIPTION:Join with Google Meet: ${booked.meetUrl}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join("\r\n"))}`;
}

/** Visitor-facing words for the booking route's error codes. */
function bookingMessage(code: string | undefined): string {
  switch (code) {
    case "already_booked":
      return "You already have a call booked with us. The invite is in your inbox; reply to it if you need a different time.";
    case "lead_stage_not_bookable":
      return "You are already working with our team. Reply to our last email and we will set up a time with you directly.";
    case "rate_limited":
      return "Too many tries in a row. Wait a minute, then try again.";
    case "retry_required":
    case "booking_create_failed":
      return "We could not lock that time with Google Calendar. Please try again, or pick another time.";
    default:
      return "Something went wrong booking that time. Please try again, or pick another time.";
  }
}

export function BookingPage(props: Props) {
  const { fields, consentIdentity, durationMinutes } = props;
  const [zone, setZone] = useState<string>(FALLBACK_ZONE);
  const [slotState, setSlotState] = useState<SlotState>({ status: "loading" });
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, ""])),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Record<ConsentChannel, boolean>>({ email: false, sms: false });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [showNote, setShowNote] = useState(false);
  // No time could be shown: take the details alone (see the header comment).
  const [detailsOnly, setDetailsOnly] = useState(false);
  const [leftDetails, setLeftDetails] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const requestIdRef = useRef<{ slot: string; id: string } | null>(null);
  const detailsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setZone(visitorZone()), []);

  const loadSlots = useCallback(async () => {
    setSlotState({ status: "loading" });
    try {
      const res = await fetch(`/api/forms/booking/slots?form=${encodeURIComponent(props.formSlug)}`, {
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; slots?: unknown } | null;
      if (!data?.ok || !Array.isArray(data.slots)) throw new Error("slots_unavailable");
      const slots = data.slots.filter((s): s is string => typeof s === "string");
      setSlotState({ status: "ready", slots });
    } catch {
      setSlotState({
        status: "error",
        message: "The calendar could not load. Refresh the page, or try again in a minute.",
      });
    }
  }, [props.formSlug]);

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

  // Keep a valid day selected as slots or the zone change.
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

  const chooseSlot = (iso: string) => {
    setSlot(iso);
    setError(null);
    setNotice(null);
    requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const setValue = (name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    setFieldErrors((e) => {
      if (!e[name]) return e;
      const next = { ...e };
      delete next[name];
      return next;
    });
    // Details changed after a lead was created: create/match again so the
    // corrected details reach the lead (matched by email, never duplicated).
    tokenRef.current = null;
  };

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    for (const f of fields) {
      const v = (values[f.name] ?? "").trim();
      if (f.required && !v) errors[f.name] = f.type === "select" ? "Pick one." : "Required.";
      else if (v && f.type === "email" && !EMAIL_SHAPE.test(v)) errors[f.name] = "Enter a valid email address.";
      else if (v && f.type === "phone") {
        const digits = v.replace(/\D/g, "").length;
        if (digits < 8 || digits > 15) errors[f.name] = "Enter a phone number with its area code.";
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const submit = async () => {
    if ((!slot && !detailsOnly) || busy) return;
    if (!validate()) return;
    setBusy(true);
    setError(null);
    try {
      let token = tokenRef.current;
      if (!token) {
        const payload = Object.fromEntries(
          fields.map((f) => [f.name, (values[f.name] ?? "").trim()]).filter(([, v]) => v !== ""),
        );
        const { rep, source, ...utm } = props.attribution;
        const res = await fetch("/api/forms/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            anonymous_init: { tenant_slug: props.tenantSlug, form_slug: props.formSlug, rep, source },
            step_index: 0,
            payload,
            submission_path: `${window.location.pathname}${window.location.search}`,
            consent_ledger: { email: ticked.email, sms: ticked.sms },
            ...utm,
          }),
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; minted_token?: string; error?: string } | null;
        if (!data?.ok || !data.minted_token) {
          setError(
            data?.error === "rate_limited"
              ? "Too many tries in a row. Wait a minute, then try again."
              : "We could not save your details. Check them and try again.",
          );
          return;
        }
        token = data.minted_token;
        tokenRef.current = token;
      }
      if (detailsOnly || !slot) {
        setLeftDetails(true);
        return;
      }

      // One request id per chosen time: a retry of the same time is idempotent.
      if (!requestIdRef.current || requestIdRef.current.slot !== slot) {
        requestIdRef.current = { slot, id: newRequestId() };
      }
      const res = await fetch("/api/forms/booking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, starts_at: slot, request_id: requestIdRef.current.id }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; starts_at?: string; ends_at?: string; meet_url?: string }
        | null;
      if (data?.ok && data.starts_at && data.ends_at && data.meet_url) {
        setBooked({ startsAt: data.starts_at, endsAt: data.ends_at, meetUrl: data.meet_url });
        return;
      }
      const code = data?.error;
      if (code === "slot_unavailable") {
        requestIdRef.current = null;
        setSlot(null);
        setNotice("That time was just taken. Here are the times still open.");
        await loadSlots();
        return;
      }
      if (code === "client_phone_required" || code === "invalid_client_phone") {
        tokenRef.current = null;
        setFieldErrors((e) => ({ ...e, phone: "Enter a phone number with its area code." }));
        return;
      }
      if (code === "client_email_required") {
        tokenRef.current = null;
        setFieldErrors((e) => ({ ...e, email: "Enter a valid email address." }));
        return;
      }
      // A compensated attempt cannot be replayed under the same id.
      if (code === "retry_required") requestIdRef.current = null;
      setError(bookingMessage(code));
    } catch {
      setError("Your connection dropped before we heard back. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const callTitle = `${durationMinutes}-minute call with OASIS AI`;

  if (leftDetails) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-5 py-16">
        <p className="m-eyebrow font-data text-[10px] uppercase tracking-[0.26em] text-signal">Received</p>
        <h1 className="mt-5 font-display text-[2rem] font-semibold leading-tight tracking-[-0.02em] text-fg">
          Thanks. We&apos;ll reach out to set a time.
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-fg-muted">
          Your details are with the OASIS team. Expect an email or a text from us with times that work.
        </p>
      </main>
    );
  }

  if (booked) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-5 py-16">
        <p className="m-eyebrow font-data text-[10px] uppercase tracking-[0.26em] text-signal">Booked</p>
        <h1 className="mt-5 font-display text-[2rem] font-semibold leading-tight tracking-[-0.02em] text-fg">
          You&apos;re on our calendar.
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
              Google Meet link
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
          {props.thanksMessage ||
            "The Google Calendar invite with the Meet link is on its way to your inbox."}
        </p>
      </main>
    );
  }

  const needsNoteToggle = (f: BookingField) => f.type === "textarea" && !f.required;

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-14">
        {/* Who, what, how long */}
        <section className="lg:sticky lg:top-12 lg:self-start">
          <p className="m-eyebrow font-data text-[10px] uppercase tracking-[0.26em] text-signal">OASIS AI</p>
          <h1 className="mt-5 font-display text-[2rem] font-semibold leading-[1.1] tracking-[-0.02em] text-fg sm:text-[2.6rem]">
            {props.headline}
          </h1>
          {props.subheadline ? (
            <p className="mt-4 max-w-md text-[16px] leading-relaxed text-fg-muted">{props.subheadline}</p>
          ) : null}
          <dl className="mt-8 grid max-w-md gap-3 border-t border-ops-line pt-6 text-[14px]">
            <div className="flex gap-3">
              <dt className="w-24 shrink-0 font-data text-[11px] uppercase tracking-[0.18em] text-fg-dim">Length</dt>
              <dd className="text-fg">{durationMinutes} minutes</dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-24 shrink-0 font-data text-[11px] uppercase tracking-[0.18em] text-fg-dim">Where</dt>
              <dd className="text-fg">Google Meet video call</dd>
            </div>
            <div className="flex items-center gap-3">
              <dt className="w-24 shrink-0 font-data text-[11px] uppercase tracking-[0.18em] text-fg-dim">
                <label htmlFor="booking-zone">Time zone</label>
              </dt>
              <dd className="min-w-0 flex-1">
                <select
                  id="booking-zone"
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
              </dd>
            </div>
          </dl>
        </section>

        {/* The calendar, then the details */}
        <section aria-label="Pick a time" className="min-w-0">
          <div className="rounded-xl border border-ops-line bg-ops-panel p-4 sm:p-6">
            <h2 className="font-display text-lg font-semibold text-fg">Pick a time</h2>
            {notice ? (
              <p role="status" className="mt-3 rounded-md border border-signal/30 bg-signal/5 px-3 py-2 text-[14px] text-fg">
                {notice}
              </p>
            ) : null}

            {slotState.status === "loading" ? (
              <div className="mt-5 space-y-3" aria-busy="true">
                <div className="h-16 animate-pulse rounded-md bg-ops-raised" />
                <div className="h-28 animate-pulse rounded-md bg-ops-raised" />
              </div>
            ) : slotState.status === "error" ? (
              <div className="mt-5">
                <p className="text-[15px] text-fg-muted">{slotState.message}</p>
                <button
                  type="button"
                  onClick={() => void loadSlots()}
                  className="mt-4 rounded-md border border-ops-edge px-4 py-2 text-[14px] text-fg hover:border-fg-dim"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => setDetailsOnly(true)}
                  className="mt-4 ml-2 rounded-md border border-ops-edge px-4 py-2 text-[14px] text-fg hover:border-fg-dim"
                >
                  Leave your details instead
                </button>
              </div>
            ) : days.length === 0 ? (
              <div className="mt-5">
                <p className="text-[15px] text-fg-muted">
                  Every time in the next two weeks is taken. Leave your details and we will make room.
                </p>
                <button
                  type="button"
                  onClick={() => setDetailsOnly(true)}
                  className="mt-4 rounded-md border border-ops-edge px-4 py-2 text-[14px] text-fg hover:border-fg-dim"
                >
                  Leave your details instead
                </button>
              </div>
            ) : (
              <>
                <div className="-mx-1 mt-5 flex gap-2 overflow-x-auto px-1 pb-2" role="tablist" aria-label="Days">
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
                        <span className="font-data text-[10px] uppercase tracking-[0.18em]">
                          {fmt(d.first, zone, { weekday: "short" })}
                        </span>
                        <span className="mt-0.5 font-display text-xl font-semibold">
                          {fmt(d.first, zone, { day: "numeric" })}
                        </span>
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
                        onClick={() => chooseSlot(s)}
                        aria-pressed={active}
                        className={`rounded-md border px-2 py-2.5 text-[14px] font-medium tabular-nums transition-colors ${
                          active
                            ? "border-signal bg-signal text-ops-void"
                            : "border-ops-line bg-ops-void text-fg hover:border-signal/60"
                        }`}
                      >
                        {fmt(s, zone, { hour: "numeric", minute: "2-digit" })}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {slot || detailsOnly ? (
            <div ref={detailsRef} className="mt-6 scroll-mt-6 rounded-xl border border-ops-line bg-ops-panel p-4 sm:p-6">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-ops-line pb-4">
                <div>
                  <p className="font-data text-[10px] uppercase tracking-[0.18em] text-signal">
                    {slot ? "Your time" : "No time picked"}
                  </p>
                  <p className="mt-1 font-display text-[17px] font-semibold text-fg">
                    {slot
                      ? `${fmt(slot, zone, { weekday: "long", month: "long", day: "numeric" })} at ${fmt(slot, zone, { hour: "numeric", minute: "2-digit" })}`
                      : "We will reach out with times"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSlot(null);
                    setDetailsOnly(false);
                  }}
                  className="text-[14px] text-fg-muted underline-offset-4 hover:text-fg hover:underline"
                >
                  {slot ? "Change" : "Back to the calendar"}
                </button>
              </div>

              <form
                className="mt-5 grid gap-4"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                {fields.map((f) => {
                  const id = `booking-${f.name}`;
                  const err = fieldErrors[f.name];
                  if (needsNoteToggle(f) && !showNote) {
                    return (
                      <button
                        key={f.name}
                        type="button"
                        onClick={() => setShowNote(true)}
                        className="w-fit text-[14px] text-fg-muted underline-offset-4 hover:text-fg hover:underline"
                      >
                        + {f.label}
                      </button>
                    );
                  }
                  if (f.type === "select") {
                    return (
                      <fieldset key={f.name}>
                        <legend className="text-[14px] font-medium text-fg">
                          {f.label}
                          {f.required ? null : <span className="text-fg-dim"> (optional)</span>}
                        </legend>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {f.options.map((o) => {
                            const on = values[f.name] === o.value;
                            return (
                              <button
                                key={o.value}
                                type="button"
                                aria-pressed={on}
                                onClick={() => setValue(f.name, on ? "" : o.value)}
                                className={`rounded-full border px-3.5 py-1.5 text-[14px] transition-colors ${
                                  on
                                    ? "border-signal bg-signal/15 text-fg"
                                    : "border-ops-line bg-ops-void text-fg-muted hover:border-ops-edge hover:text-fg"
                                }`}
                              >
                                {o.label}
                              </button>
                            );
                          })}
                        </div>
                        {err ? <p className="mt-1.5 text-[13px] text-status-hot">{err}</p> : null}
                      </fieldset>
                    );
                  }
                  const common = {
                    id,
                    name: f.name,
                    value: values[f.name] ?? "",
                    placeholder: f.placeholder,
                    maxLength: f.maxLength ?? undefined,
                    "aria-invalid": err ? true : undefined,
                    "aria-describedby": err || f.help ? `${id}-note` : undefined,
                    className: `w-full rounded-md border bg-ops-void px-3 py-2.5 text-[15px] text-fg placeholder:text-fg-dim focus:outline-none ${
                      err ? "border-status-hot" : "border-ops-line focus:border-signal"
                    }`,
                  };
                  return (
                    <div key={f.name}>
                      <label htmlFor={id} className="text-[14px] font-medium text-fg">
                        {f.label}
                        {f.required ? null : <span className="text-fg-dim"> (optional)</span>}
                      </label>
                      <div className="mt-1.5">
                        {f.type === "textarea" ? (
                          <textarea {...common} rows={3} onChange={(e) => setValue(f.name, e.target.value)} />
                        ) : (
                          <input
                            {...common}
                            type={f.type === "phone" ? "tel" : f.type === "email" ? "email" : "text"}
                            autoComplete={
                              f.type === "email" ? "email" : f.type === "phone" ? "tel" : f.name === "name" ? "name" : f.name === "company" ? "organization" : undefined
                            }
                            inputMode={f.type === "phone" ? "tel" : f.type === "email" ? "email" : undefined}
                            onChange={(e) => setValue(f.name, e.target.value)}
                          />
                        )}
                      </div>
                      {err || f.help ? (
                        <p id={`${id}-note`} className={`mt-1.5 text-[13px] ${err ? "text-status-hot" : "text-fg-dim"}`}>
                          {err || f.help}
                        </p>
                      ) : null}
                    </div>
                  );
                })}

                <div className="grid gap-3 border-t border-ops-line pt-4">
                  {(["email", "sms"] as ConsentChannel[]).map((channel) => (
                    <label key={channel} className="flex items-start gap-3 text-[13px] leading-relaxed text-fg-muted">
                      <input
                        type="checkbox"
                        checked={ticked[channel]}
                        onChange={(e) => {
                          setTicked((t) => ({ ...t, [channel]: e.target.checked }));
                          // The consent ledger records a choice only on the form
                          // step (POST /api/forms/submit). A change after a failed
                          // booking, a withdrawal above all, must re-send that step,
                          // not ride on the old token (Codex review of #628).
                          tokenRef.current = null;
                        }}
                        className="mt-1 h-4 w-4 shrink-0 accent-[#00D4FF]"
                      />
                      <span>{consentDisclosureText(channel, consentIdentity)}</span>
                    </label>
                  ))}
                  <p className="text-[12px] text-fg-dim">
                    Optional. Your booking and its calendar invite do not depend on these boxes.
                  </p>
                </div>

                {error ? (
                  <p role="alert" className="rounded-md border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-[14px] text-fg">
                    {error}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex w-full items-center justify-center rounded-md bg-signal px-6 py-3 text-[15px] font-semibold tracking-[-0.01em] text-ops-void transition-all hover:brightness-110 disabled:opacity-60 sm:w-auto"
                >
                  {busy ? (slot ? "Booking..." : "Sending...") : slot ? "Book this time" : "Send my details"}
                </button>
              </form>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
