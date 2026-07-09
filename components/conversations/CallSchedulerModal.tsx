"use client";

/**
 * CallSchedulerModal — "Request a call" / "Schedule a call" (built to the
 * scheduling-UI research spec, 2026-07). Books an in-house call
 * (POST /api/conversations/schedule-call -> pending scheduled_calls row) then
 * offers a Google Calendar deep-link. Never dials anyone; it records intent +
 * the dispatch cron reminds the rep.
 *
 * The time picker is a custom slot column (no native datetime-local): quick
 * presets on the fast path, then a 14-day pill rail + a scrolling column of
 * 30-min slots across the full 24h day (calls can be booked at any time) where
 * the selected slot expands and reveals an inline Confirm. A smart default (the
 * next half-hour) is pre-selected so a callback is one tap. When the merchant's
 * timezone (derived
 * from their phone area code) differs from the operator's, every slot shows the
 * merchant's local time too, tinted amber outside 8am-8pm.
 *
 * Two modes: locked contact (opened from a conversation) and editable contact
 * (the Calls board's "Schedule a call", no lead attached).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X, CalendarPlus, Check, Loader2, ChevronRight } from "lucide-react";
import { tzFromPhone } from "@/lib/phone-timezone";

const OP_TZ =
  typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "America/New_York";
const MIN = 60_000;
const DAY_MS = 86_400_000;

function fmtTime(d: Date, tz = OP_TZ): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);
}
function tzAbbr(d: Date, tz = OP_TZ): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZoneName: "short", timeZone: tz })
    .formatToParts(d)
    .find((x) => x.type === "timeZoneName");
  return p ? p.value : "";
}
function merchantHour(d: Date, tz: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(d).replace(/\D/g, ""),
  );
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function dayLabelShort(d: Date): string {
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, new Date(Date.now() + DAY_MS))) return "Tmrw";
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(d);
}
function dayFull(d: Date): string {
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, new Date(Date.now() + DAY_MS))) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" }).format(d);
}
function smartDefault(): Date {
  // Next :00/:30 strictly after now, any hour of day (calls can be booked at
  // any time, no business-hours restriction).
  const d = new Date();
  d.setSeconds(0, 0);
  if (d.getMinutes() < 30) d.setMinutes(30);
  else {
    d.setMinutes(0);
    d.setHours(d.getHours() + 1);
  }
  return d;
}
function slotsFor(day: Date): Date[] {
  const out: Date[] = [];
  for (let h = 0; h < 24; h++) {
    for (const mn of [0, 30]) {
      const d = new Date(day);
      d.setHours(h, mn, 0, 0);
      out.push(d);
    }
  }
  return out;
}
function slotSection(d: Date): string {
  const h = d.getHours();
  if (h < 6) return "Night";
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}
function calendarUrl(args: { at: number; label: string; company?: string; phone?: string | null; notes?: string }): string {
  const start = new Date(args.at);
  const end = new Date(args.at + 30 * MIN);
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const title = `Call ${args.label || "lead"}${args.company ? ` (${args.company})` : ""}`;
  const details = [args.phone ? `Phone: ${args.phone}` : null, args.notes || null].filter(Boolean).join("\n");
  const params = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${stamp(start)}/${stamp(end)}`, ctz: OP_TZ });
  if (details) params.set("details", details);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

type Booked = { id: string; at: number; label: string };

export function CallSchedulerModal({
  leadId = null,
  threadKey = null,
  defaultLabel = "",
  defaultPhone = null,
  company,
  editableContact = false,
  onClose,
  onBooked,
}: {
  leadId?: string | null;
  threadKey?: string | null;
  defaultLabel?: string;
  defaultPhone?: string | null;
  company?: string;
  editableContact?: boolean;
  onClose: () => void;
  onBooked?: () => void;
}) {
  const suggested = useMemo(() => smartDefault(), []);
  const days = useMemo(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    return Array.from({ length: 14 }, (_, i) => new Date(base.getTime() + i * DAY_MS));
  }, []);

  const [chosen, setChosen] = useState<Date>(suggested);
  const [day, setDay] = useState<Date>(() => {
    const d = new Date(suggested);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [showPicker, setShowPicker] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [notes, setNotes] = useState("");
  const [label, setLabel] = useState(defaultLabel);
  const [phone, setPhone] = useState(defaultPhone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);
  const slotScrollRef = useRef<HTMLDivElement | null>(null);

  const merchantTz = useMemo(
    () => tzFromPhone(editableContact ? phone : defaultPhone),
    [editableContact, phone, defaultPhone],
  );
  const showDual = !!merchantTz && merchantTz !== OP_TZ;

  const contactPhone = editableContact ? phone : defaultPhone;

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const book = useCallback(async () => {
    setError(null);
    if (Number.isNaN(chosen.getTime())) return setError("Pick a valid time.");
    if (chosen.getTime() < Date.now() + 15_000) return setError("Pick a time in the future.");
    let name = defaultLabel;
    let ph = defaultPhone ?? "";
    if (editableContact) {
      name = label.trim();
      ph = phone.trim();
      if (!name && !ph) return setError("Add a name or phone for the call.");
    }
    setBusy(true);
    try {
      const r = await fetch("/api/conversations/schedule-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          lead_id: leadId,
          thread_key: threadKey,
          to_phone: ph || undefined,
          contact_label: name || undefined,
          scheduled_for: chosen.toISOString(),
          notes: notes.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setError(j?.message || "Couldn't book the call. Try again.");
        setBusy(false);
        return;
      }
      setBooked({ id: j.id, at: chosen.getTime(), label: name || "lead" });
      onBooked?.();
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }, [chosen, defaultLabel, defaultPhone, editableContact, label, phone, notes, leadId, threadKey, onBooked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void book();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, book]);

  // Scroll the selected slot into view when the picker opens / day changes.
  useEffect(() => {
    if (!showPicker) return;
    const t = setTimeout(() => {
      slotScrollRef.current?.querySelector("[data-sel='1']")?.scrollIntoView({ block: "center" });
    }, 50);
    return () => clearTimeout(t);
  }, [showPicker, day, chosen]);

  const presets = useMemo(() => {
    const inHour = new Date(Date.now() + 60 * MIN);
    inHour.setSeconds(0, 0);
    inHour.setMinutes(Math.ceil(inHour.getMinutes() / 15) * 15, 0, 0);
    const tmr = (h: number) => {
      const d = new Date(Date.now() + DAY_MS);
      d.setHours(h, 0, 0, 0);
      return d;
    };
    return [
      { label: "In 1 hour", d: inHour },
      { label: "Tomorrow 10am", d: tmr(10) },
      { label: "Tomorrow 2pm", d: tmr(14) },
    ];
  }, []);

  const pickPreset = (d: Date) => {
    setChosen(new Date(d));
    const dd = new Date(d);
    dd.setHours(0, 0, 0, 0);
    setDay(dd);
  };
  const pickDay = (d: Date) => {
    const nd = new Date(d);
    nd.setHours(0, 0, 0, 0);
    setDay(nd);
    const nc = new Date(nd);
    nc.setHours(chosen.getHours(), chosen.getMinutes(), 0, 0);
    setChosen(nc);
  };

  const slots = useMemo(() => slotsFor(day), [day]);
  const now = new Date();
  const isToday = sameDay(day, now);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editableContact ? "Schedule a call" : "Request a call"}
        className="relative flex h-[520px] max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-bg-border bg-bg-panel shadow-2xl"
      >
        {/* header */}
        <div className="shrink-0 border-b border-bg-border px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-bold text-fg">{editableContact ? "Schedule a call" : "Request a call"}</span>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-fg-dim hover:bg-bg-elev hover:text-fg">
              <X className="h-4 w-4" />
            </button>
          </div>
          {editableContact ? (
            <div className="mt-2 flex gap-2">
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Contact name"
                className="w-full rounded-lg border border-bg-border bg-bg-elev/50 px-2.5 py-1.5 text-[12px] text-fg placeholder:text-fg-dim focus:border-violet-500/50 focus:outline-none"
              />
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(555) 555-5555"
                className="w-full rounded-lg border border-bg-border bg-bg-elev/50 px-2.5 py-1.5 text-[12px] text-fg placeholder:text-fg-dim focus:border-violet-500/50 focus:outline-none"
              />
            </div>
          ) : (
            <div className="mt-1.5 flex items-center gap-2 text-[12px] text-fg-muted">
              <span className="font-semibold text-fg">{defaultLabel || "Lead"}</span>
              {defaultPhone ? <span className="font-mono text-violet-300">{defaultPhone}</span> : null}
            </div>
          )}
          <div className="mt-1.5 text-[10.5px] text-fg-dim">
            Times in {tzAbbr(new Date())} · {OP_TZ.replace(/_/g, " ")}
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-4 py-3.5">
          {booked ? (
            <SuccessCard
              booked={booked}
              notes={notes}
              company={company}
              phone={contactPhone}
              merchantTz={showDual ? merchantTz : null}
              onClose={onClose}
            />
          ) : (
            <div className="flex flex-col gap-3.5">
              {/* presets */}
              <div>
                <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-fg-dim">Quick pick</div>
                <div className="flex flex-wrap gap-2">
                  {presets.map((p) => {
                    const sel = Math.abs(chosen.getTime() - p.d.getTime()) < 60_000;
                    return (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => pickPreset(p.d)}
                        className={`flex min-w-[96px] flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                          sel
                            ? "border-violet-500 bg-violet-500/15"
                            : "border-bg-border bg-bg-elev/40 hover:border-violet-500/40 hover:bg-violet-500/10"
                        }`}
                      >
                        <span className="text-[12px] font-semibold text-fg">{p.label}</span>
                        <span className="font-mono text-[10.5px] text-fg-dim">{fmtTime(p.d)}</span>
                      </button>
                    );
                  })}
                </div>
                {showDual && merchantTz ? <DualLine at={chosen.getTime()} tz={merchantTz} /> : null}
              </div>

              {/* precise picker disclosure */}
              <button
                type="button"
                aria-expanded={showPicker}
                onClick={() => setShowPicker((s) => !s)}
                className="flex items-center gap-1.5 text-[12px] font-semibold text-violet-300"
              >
                <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showPicker ? "rotate-90" : ""}`} />
                Pick a specific time
              </button>

              {showPicker ? (
                <div className="flex flex-col gap-2">
                  {/* day rail */}
                  <div className="flex gap-2 overflow-x-auto pb-1.5">
                    {days.map((d) => {
                      const sel = sameDay(d, day);
                      const today = sameDay(d, now);
                      return (
                        <button
                          key={d.toISOString()}
                          type="button"
                          onClick={() => pickDay(d)}
                          className={`flex w-[52px] shrink-0 flex-col items-center gap-0.5 rounded-xl border py-2 transition-colors ${
                            sel
                              ? "border-violet-500 bg-violet-500 text-white"
                              : today
                                ? "border-violet-500/40 bg-bg-elev/40"
                                : "border-bg-border bg-bg-elev/40 hover:border-violet-500/40"
                          }`}
                        >
                          <span className={`text-[10px] font-bold uppercase tracking-wide ${sel ? "text-white" : "text-fg-dim"}`}>
                            {dayLabelShort(d)}
                          </span>
                          <span className={`text-[16px] font-bold ${sel ? "text-white" : "text-fg"}`}>{d.getDate()}</span>
                        </button>
                      );
                    })}
                  </div>
                  {sameDay(suggested, day) ? (
                    <div className="-mt-1 pl-0.5 text-[10.5px] text-fg-dim">Suggested: the next available slot</div>
                  ) : null}

                  {/* slot column */}
                  <div
                    ref={slotScrollRef}
                    className="max-h-56 overflow-y-auto [mask-image:linear-gradient(180deg,transparent,#000_14px,#000_calc(100%-14px),transparent)]"
                  >
                    <SlotList
                      slots={slots}
                      chosen={chosen}
                      suggested={suggested}
                      isToday={isToday}
                      now={now}
                      onPick={(s) => setChosen(new Date(s))}
                      onConfirm={(s) => {
                        setChosen(new Date(s));
                        void book();
                      }}
                    />
                  </div>
                </div>
              ) : null}

              <div className="h-px bg-bg-border" />

              {/* notes disclosure */}
              <div>
                <button
                  type="button"
                  aria-expanded={showNotes}
                  onClick={() => setShowNotes((s) => !s)}
                  className="flex items-center gap-1.5 text-[12px] font-semibold text-violet-300"
                >
                  <ChevronRight className={`h-3.5 w-3.5 transition-transform ${showNotes ? "rotate-90" : ""}`} />
                  Add a note
                </button>
                {showNotes ? (
                  <div className="mt-2">
                    <textarea
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      rows={2}
                      placeholder="What's this call about?"
                      className="max-h-32 w-full resize-none rounded-lg border border-bg-border bg-bg-elev/40 px-2.5 py-2 text-[12.5px] text-fg placeholder:text-fg-dim focus:border-violet-500/50 focus:outline-none"
                    />
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {["Left VM", "Requested callback", "Discuss renewal"].map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => setNotes((n) => (n ? `${n.replace(/\s*$/, "")} ${q}` : q))}
                          className="rounded-md border border-bg-border px-2 py-1 text-[10.5px] font-semibold text-fg-muted hover:border-violet-500/40 hover:text-violet-300"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        {!booked ? (
          <div className="shrink-0 border-t border-bg-border px-4 py-3">
            {error ? <div className="mb-2 text-center text-[11.5px] text-red-300">{error}</div> : null}
            <button
              type="button"
              onClick={() => void book()}
              disabled={busy}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2.5 text-[12.5px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
              Book call · <span className="font-mono font-semibold">
                {dayFull(chosen)} {fmtTime(chosen)} {tzAbbr(chosen)}
              </span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DualLine({ at, tz }: { at: number; tz: string }) {
  const d = new Date(at);
  const mh = merchantHour(d, tz);
  const odd = mh < 8 || mh >= 20;
  return (
    <div className="mt-2 text-[11px] text-fg-muted">
      Merchant local:{" "}
      <span className={odd ? "text-amber-300" : ""}>
        {fmtTime(d, tz)} {tzAbbr(d, tz)}
        {odd ? " · outside 8am-8pm" : ""}
      </span>
    </div>
  );
}

function SlotList({
  slots,
  chosen,
  suggested,
  isToday,
  now,
  onPick,
  onConfirm,
}: {
  slots: Date[];
  chosen: Date;
  suggested: Date;
  isToday: boolean;
  now: Date;
  onPick: (s: Date) => void;
  onConfirm: (s: Date) => void;
}) {
  const out: ReactNode[] = [];
  let lastSec = "";
  let dividerPlaced = false;
  slots.forEach((s) => {
    const sec = slotSection(s);
    if (sec !== lastSec) {
      out.push(
        <div
          key={`h-${sec}`}
          className="sticky top-0 z-[2] bg-bg-panel/90 px-0.5 pb-1 pt-1.5 text-[9.5px] font-bold uppercase tracking-wider text-fg-dim backdrop-blur"
        >
          {sec}
        </div>,
      );
      lastSec = sec;
    }
    const past = isToday && s <= now;
    if (isToday && !dividerPlaced && s > now) {
      out.push(
        <div key="now-div" className="my-1.5 flex items-center gap-1.5">
          <span className="text-[9px] font-bold uppercase tracking-wide text-violet-300">Now</span>
          <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
          <span className="h-px flex-1 bg-violet-500/40" />
        </div>,
      );
      dividerPlaced = true;
    }
    const sel = Math.abs(s.getTime() - chosen.getTime()) < 60_000;
    const sugg = sel && Math.abs(s.getTime() - suggested.getTime()) < 60_000;
    out.push(
      <button
        key={s.toISOString()}
        type="button"
        data-sel={sel ? "1" : "0"}
        disabled={past}
        onClick={() => onPick(s)}
        className={`mb-1.5 flex w-full items-center justify-between rounded-lg border px-3 text-[13px] transition-all ${
          sel ? "border-violet-500/40 bg-violet-500/10" : "border-bg-border bg-bg-panel hover:border-violet-500/40"
        } ${past ? "pointer-events-none opacity-30" : ""}`}
        style={{ height: sel ? "52px" : "44px" }}
      >
        <span className={`font-mono tabular-nums ${sel ? "font-semibold text-fg" : "text-fg-muted"}`}>
          {fmtTime(s)}
          {sugg ? (
            <span className="ml-2 rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-violet-300">
              Suggested
            </span>
          ) : null}
        </span>
        {sel ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onConfirm(s);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                onConfirm(s);
              }
            }}
            className="inline-flex items-center gap-1 rounded-md bg-violet-500 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-violet-400"
          >
            <Check className="h-3 w-3" /> Confirm
          </span>
        ) : null}
      </button>,
    );
  });
  return <>{out}</>;
}

function SuccessCard({
  booked,
  notes,
  company,
  phone,
  merchantTz,
  onClose,
}: {
  booked: Booked;
  notes: string;
  company?: string;
  phone?: string | null;
  merchantTz: string | null;
  onClose: () => void;
}) {
  const d = new Date(booked.at);
  return (
    <div className="flex flex-col items-center gap-3.5 py-2 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15">
        <Check className="h-7 w-7 text-emerald-400" />
      </div>
      <div>
        <div className="text-[16px] font-bold text-fg">
          {dayFull(d)} · {fmtTime(d)} {tzAbbr(d)}
        </div>
        {merchantTz ? (
          <div className="text-[12px] text-fg-muted">
            {fmtTime(d, merchantTz)} {tzAbbr(d, merchantTz)} merchant local
          </div>
        ) : null}
        {notes.trim() ? <div className="mt-1 text-[12px] italic text-fg-dim">&ldquo;{notes.trim()}&rdquo;</div> : null}
      </div>
      <div className="flex w-full flex-col gap-2">
        <a
          href={calendarUrl({ at: booked.at, label: booked.label, company, phone, notes: notes.trim() || undefined })}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-[12.5px] font-semibold text-white hover:bg-violet-500"
        >
          <CalendarPlus className="h-4 w-4" /> Add to Google Calendar
        </a>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-bg-border px-3 py-2 text-[12.5px] font-semibold text-fg-muted hover:bg-bg-elev"
        >
          Done
        </button>
      </div>
    </div>
  );
}
