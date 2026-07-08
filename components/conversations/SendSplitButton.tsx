"use client";

/**
 * SendSplitButton — plan §3/§7. Primary Send action, recolored to the
 * active channel, plus (Phase 3) a real schedule-send split menu and an
 * 8am-9pm recipient-local TCPA warning gate on the primary Send itself.
 *
 * TCPA (47 U.S.C. § 227) restricts SMS contact to 8am-9pm in the
 * RECIPIENT's local time — estimated from their area code (lib/tcpa-
 * window.ts), falling back to the viewer's own timezone with an explicit
 * caveat when the area code isn't recognized. Applies to SMS only (email
 * has no calling-hours restriction) — the schedule menu and TCPA gate are
 * both no-ops for `channel="email"`.
 *
 * Scheduling caveat: presets fire via an in-memory `setTimeout` owned by
 * the caller (InboxShell) — durable ONLY while this browser tab stays
 * open. There is no server-side scheduler in this phase; a closed tab or a
 * Vercel cold redeploy silently drops a pending scheduled send. Flagged
 * here and in InboxShell's handleScheduleSend — a real fix needs a
 * `scheduled_sends` table + a cron/worker, out of scope for this phase.
 */
import { useState, useRef, useEffect, useMemo } from "react";
import { Send, ChevronDown, Clock, AlertTriangle } from "lucide-react";
import { checkTcpaWindow, nextTcpaWindowStart, zonedWallClockTime } from "@/lib/tcpa-window";

type SchedulePreset = { label: string; at: Date };

export function SendSplitButton({
  onSend,
  sending,
  disabled,
  channel,
  recipientPhone,
}: {
  onSend: (opts?: { scheduledAt?: string }) => void;
  sending: boolean;
  disabled?: boolean;
  channel: "sms" | "email";
  recipientPhone?: string | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOutside, setConfirmOutside] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  // Close the "outside window" confirm strip whenever the recipient/channel
  // changes (thread switch) so a stale confirmation can't linger.
  useEffect(() => setConfirmOutside(false), [recipientPhone, channel]);

  const tcpa = channel === "sms" ? checkTcpaWindow(recipientPhone) : null;

  function handlePrimarySend() {
    if (tcpa && !tcpa.withinWindow && !confirmOutside) {
      setConfirmOutside(true);
      return;
    }
    setConfirmOutside(false);
    onSend();
  }

  const presets: SchedulePreset[] = useMemo(() => {
    if (channel !== "sms") return [];
    const now = new Date();
    const zone = checkTcpaWindow(recipientPhone, now).timeZone;
    let evening = zonedWallClockTime(zone, 18, 0, now, 0);
    if (evening <= now) evening = zonedWallClockTime(zone, 18, 0, now, 1);
    const tomorrow9 = zonedWallClockTime(zone, 9, 0, now, 1);
    return [
      { label: "In 1 hour", at: new Date(now.getTime() + 60 * 60_000) },
      { label: "This evening (6pm, their time)", at: evening },
      { label: "Tomorrow 9am (their time)", at: tomorrow9 },
      { label: "Next allowed window", at: nextTcpaWindowStart(recipientPhone, now) },
    ];
  }, [channel, recipientPhone]);

  const accent = channel === "sms" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-blue-600 hover:bg-blue-500";

  return (
    <div ref={ref} className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={handlePrimarySend}
        disabled={disabled || sending}
        className={`inline-flex items-center gap-1.5 rounded-l-md px-3 py-2 text-xs font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${accent}`}
      >
        <Send className="h-3.5 w-3.5" />
        {sending ? "Sending…" : "Send"}
      </button>
      <button
        type="button"
        onClick={() => {
          setConfirmOutside(false);
          setMenuOpen((v) => !v);
        }}
        disabled={disabled || sending}
        aria-label="Send options"
        className={`rounded-r-md px-1.5 border-l border-white/20 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${accent}`}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {tcpa && confirmOutside && (
        <div className="absolute bottom-full right-0 mb-1.5 w-64 rounded-lg border border-status-warm/40 bg-bg-elev shadow-elev z-20 p-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-status-warm">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Outside TCPA hours
          </div>
          <p className="text-[11px] text-fg-muted">
            It&apos;s {tcpa.timeLabel} for this recipient{tcpa.usedFallback ? " (estimated — unknown area code)" : ""}.
            TCPA restricts SMS to 8am-9pm their local time.
          </p>
          <div className="flex items-center gap-3 pt-0.5">
            <button
              type="button"
              onClick={() => {
                setConfirmOutside(false);
                onSend();
              }}
              className="text-[11px] font-semibold text-status-warm underline underline-offset-2"
            >
              Send anyway
            </button>
            <button
              type="button"
              onClick={() => setConfirmOutside(false)}
              className="text-[11px] text-fg-dim hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {menuOpen && (
        <div className="absolute bottom-full right-0 mb-1.5 w-64 rounded-lg border border-bg-border bg-bg-elev shadow-elev z-20 p-1">
          {channel !== "sms" ? (
            <div className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-fg-dim italic">
              <Clock className="h-3.5 w-3.5 shrink-0" />
              Scheduled send is SMS-only for now.
            </div>
          ) : (
            <>
              <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-dim">
                Schedule send
              </div>
              {presets.map((p) => {
                const within = checkTcpaWindow(recipientPhone, p.at).withinWindow;
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onSend({ scheduledAt: p.at.toISOString() });
                    }}
                    className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-left text-[12px] text-fg hover:bg-bg-panel transition-colors"
                  >
                    <span>{p.label}</span>
                    <span className={`text-[10px] shrink-0 ${within ? "text-fg-dim" : "text-status-warm"}`}>
                      {p.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      {!within && " ⚠"}
                    </span>
                  </button>
                );
              })}
              <div className="px-2.5 pt-1.5 pb-1 mt-1 border-t border-bg-border text-[10px] text-fg-dim">
                Fires from this open tab — not a durable server schedule yet.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
