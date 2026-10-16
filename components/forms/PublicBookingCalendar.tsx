"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, CheckCircle2, Loader2, Video } from "lucide-react";
import { getOrCreateVisitId } from "@/lib/offers/tracking-client";

type Availability = {
  ok: boolean;
  slots?: string[];
  duration_minutes?: number;
  time_zone?: string;
  error?: string;
};

type Receipt = {
  ok: true;
  starts_at: string;
  ends_at: string;
  meet_url: string;
  calendar_url: string;
  time_zone: string;
};

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  weekday: "long",
  month: "short",
  day: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function friendlyError(code: string | undefined): string {
  if (code === "slot_unavailable") return "That time was just taken. Pick another slot below.";
  if (code === "retry_required") return "The first attempt was safely rolled back. Please try that time again.";
  if (code === "already_booked") return "This request already has a meeting on the calendar.";
  if (code === "rate_limited") return "Too many attempts at once. Wait a moment and try again.";
  // The visitor's own details cannot make a call, and no retry changes that: say so, and
  // say how it gets fixed, instead of "availability is unavailable".
  if (code === "invalid_client_phone" || code === "client_phone_required") {
    return "We couldn't use the phone number you entered, so we couldn't book this time. Your details are saved. Reply to your confirmation email with a good number and we'll book you in.";
  }
  if (code === "lead_stage_not_bookable") {
    return "Your request is already with our team. Reply to your confirmation email and we'll set the time with you.";
  }
  return "Live availability is temporarily unavailable. Your details are saved, and the OASIS team will follow up.";
}

export function PublicBookingCalendar({
  token,
  primary,
  formSlug,
  completedStep,
  optional = false,
}: {
  token: string | null;
  primary: string;
  formSlug: string;
  completedStep: number;
  /**
   * The call is an extra, not the next step (PROTOCOL, COMMUNITY): the form's
   * own thanks sits above this, so the heading offers the call instead of
   * announcing the details are in, and the community link (already in that
   * thanks) is not repeated.
   */
  optional?: boolean;
}) {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const bookingRequest = useRef<{ slot: string; id: string } | null>(null);

  async function load() {
    if (!token) {
      setAvailability({ ok: false, error: "token_missing" });
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/forms/booking/availability", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await response.json() as Availability;
      setAvailability(data);
      if (!response.ok || !data.ok) setError(friendlyError(data.error));
    } catch {
      setAvailability({ ok: false, error: "network" });
      setError(friendlyError("network"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // The token is the lead-bound credential; a fresh one means a fresh audit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const slot of availability?.slots || []) {
      const day = dayFormat.format(new Date(slot));
      map.set(day, [...(map.get(day) || []), slot]);
    }
    return [...map.entries()].slice(0, 7);
  }, [availability]);

  async function book() {
    if (!token || !selected || booking) return;
    if (bookingRequest.current?.slot !== selected) {
      bookingRequest.current = { slot: selected, id: crypto.randomUUID() };
    }
    setBooking(true);
    setError("");
    try {
      const response = await fetch("/api/forms/booking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, starts_at: selected, request_id: bookingRequest.current.id }),
      });
      const data = await response.json() as Receipt | { ok: false; error?: string };
      if (!response.ok || !data.ok) {
        setError(friendlyError("error" in data ? data.error : undefined));
        if ("error" in data && (data.error === "slot_unavailable" || data.error === "retry_required")) {
          bookingRequest.current = null;
        }
        if ("error" in data && data.error === "slot_unavailable") {
          setSelected(null);
          await load();
        } else if ("error" in data && data.error === "retry_required") {
          await load();
        }
        return;
      }
      setReceipt(data);
    } catch {
      setError(friendlyError("network"));
    } finally {
      setBooking(false);
    }
  }

  if (receipt) {
    return (
      <div className="space-y-5 py-4 text-center" aria-live="polite">
        <CheckCircle2 className="mx-auto h-12 w-12" style={{ color: primary }} />
        <div className="space-y-2">
          <h2 className="text-xl font-bold text-fg">Your call is booked.</h2>
          <p className="text-sm text-fg-muted">
            {dayFormat.format(new Date(receipt.starts_at))} at {timeFormat.format(new Date(receipt.starts_at))}
          </p>
          <p className="text-xs leading-relaxed text-fg-dim">
            Google sent the invitation and calendar file to your email. It includes your private Meet link.
          </p>
        </div>
        <div className="mx-auto flex max-w-sm flex-col gap-2 sm:flex-row">
          <a
            href={receipt.meet_url}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-bold"
            style={{ backgroundColor: primary, color: "#111" }}
          >
            <Video className="h-4 w-4" /> Join Google Meet
          </a>
          <a
            href={receipt.calendar_url}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-bg-border px-4 py-2 text-sm font-semibold text-fg"
          >
            <CalendarDays className="h-4 w-4" /> Open calendar
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 py-3">
      {optional ? (
        <div className="space-y-2 text-center">
          <h3 className="text-lg font-bold text-fg">Want to talk it through first?</h3>
          <p className="mx-auto max-w-md text-sm leading-relaxed text-fg-muted">
            Optional: pick a {availability?.duration_minutes || 15}-minute call with our team. These are the live times we have open, and the Google Meet invite arrives instantly.
          </p>
        </div>
      ) : (
        <div className="space-y-2 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10" style={{ color: primary }} />
          <h2 className="text-xl font-bold text-fg">Your details are in. Pick a time while you’re here.</h2>
          <p className="mx-auto max-w-md text-sm leading-relaxed text-fg-muted">
            These are the live times our team has open. The call is {availability?.duration_minutes || 15} minutes and the Google Meet invite arrives instantly.
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking the calendar...
        </div>
      ) : groups.length > 0 ? (
        <div className="max-h-[24rem] space-y-4 overflow-y-auto pr-1 text-left">
          {groups.map(([day, slots]) => (
            <fieldset key={day} className="space-y-2">
              <legend className="text-xs font-bold uppercase tracking-wide text-fg-muted">{day}</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {slots.map((slot) => {
                  const active = selected === slot;
                  return (
                    <button
                      key={slot}
                      type="button"
                      onClick={() => {
                        setSelected(slot);
                        if (bookingRequest.current?.slot !== slot) bookingRequest.current = null;
                      }}
                      aria-pressed={active}
                      className="min-h-11 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors"
                      style={active
                        ? { borderColor: primary, backgroundColor: `${primary}22`, color: primary }
                        : undefined}
                    >
                      {timeFormat.format(new Date(slot))}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-bg-border bg-bg-elev/30 p-4 text-center text-sm text-fg-muted">
          No open times are showing right now. Your details are saved and the team will follow up.
        </p>
      )}

      {error && <p className="text-center text-sm text-rose-400" role="alert">{error}</p>}
      {selected && !loading && (
        <button
          type="button"
          disabled={booking}
          onClick={() => void book()}
          className="flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-base font-bold disabled:opacity-60"
          style={{ backgroundColor: primary, color: "#111" }}
        >
          {booking && <Loader2 className="h-4 w-4 animate-spin" />}
          {booking ? "Booking…" : `Book ${timeFormat.format(new Date(selected))}`}
        </button>
      )}

      {optional ? null : (
        <CommunityJoinLink
          formSlug={formSlug}
          completedStep={completedStep}
          primary={primary}
          lead="Not ready to book? Stay close without starting a sales process."
        />
      )}
    </div>
  );
}

/**
 * "Join the free OASIS Telegram community", through /go/community so the
 * click counts against this form and visit (the visit id is added once the
 * page runs, so the server's first render matches). One markup for the
 * calendar's footer and the COMMUNITY form's own last screen, where it is the
 * form's next step (review of #655: the thanks names the link only as text).
 */
export function CommunityJoinLink({
  formSlug,
  completedStep,
  primary,
  lead = null,
}: {
  formSlug: string;
  completedStep: number;
  primary: string;
  /** The line above the link; null draws the link alone, with no rule above it. */
  lead?: string | null;
}) {
  const base = `/go/community?form=${encodeURIComponent(formSlug)}&t=oasis-ai-cc&step=${completedStep}`;
  const [href, setHref] = useState(base);
  useEffect(() => {
    const visit = getOrCreateVisitId();
    setHref(visit ? `${base}&v=${encodeURIComponent(visit)}` : base);
  }, [base]);
  const link = (
    <a href={href} className="mt-2 inline-block text-sm font-semibold underline underline-offset-4" style={{ color: primary }}>
      Join the free OASIS Telegram community →
    </a>
  );
  return lead ? (
    <div className="border-t border-bg-border pt-4 text-center">
      <p className="text-xs text-fg-dim">{lead}</p>
      {link}
    </div>
  ) : (
    <div className="text-center">{link}</div>
  );
}
