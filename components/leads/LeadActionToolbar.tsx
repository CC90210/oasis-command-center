"use client";

/**
 * LeadActionToolbar — the primary CTAs at the top of the lead drawer.
 *
 * Replaces the previous "AI Lead Score" + "Recommended Next Move" boxes,
 * which were big visual real estate spent on meta-actions (clicking a
 * button to make Claude write a summary about the lead) instead of
 * money-moving operations.
 *
 * The actions surfaced here are the ones an operator on a call actually
 * needs ready-to-fire:
 *   1. Send check-in email — queues a personalized email through the
 *      existing /api/leads/[id]/email endpoint (send_gateway daemon
 *      picks it up within 60s).
 *   2. Schedule call — pops a Google Calendar event creator pre-filled
 *      with the lead's context.
 *   3. Mark stale / re-trigger drip — toggles drip-paused so the OASIS
 *      sequences picks the lead back up on the next pass.
 *
 * Re-score + Re-recommend remain accessible under an "AI tools" disclosure
 * below the toolbar — same handlers, demoted visual weight.
 */

import { useState, type FormEvent, type ReactNode } from "react";
import {
  Mail,
  CalendarPlus,
  PauseCircle,
  PlayCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  Sparkles,
  Compass,
} from "lucide-react";

type CheckInTemplate = {
  subject: string;
  body: string;
};

function buildCheckInTemplate({
  leadName,
  leadCompany,
  daysSinceLastTouch,
}: {
  leadName: string | null;
  leadCompany: string | null;
  daysSinceLastTouch: number | null;
}): CheckInTemplate {
  const firstName = (leadName || "").split(/\s+/)[0] || "there";
  const contextLine =
    daysSinceLastTouch !== null && daysSinceLastTouch > 7
      ? `It's been a minute since we last connected — wanted to make sure I didn't drop the thread.`
      : `Wanted to circle back on the conversation we had going.`;
  const subject = leadCompany
    ? `Quick check-in — ${leadCompany}`
    : `Quick check-in`;
  const body = `Hey ${firstName},

${contextLine}

If now's a better moment to chat — even 10 minutes — happy to find a time that works. Otherwise, totally fine to circle back later in the month.

Either way, let me know.

— Sent via OASIS`;
  return { subject, body };
}

function buildCalendarUrl({
  leadName,
  leadCompany,
  leadEmail,
  operatorEmail,
}: {
  leadName: string | null;
  leadCompany: string | null;
  leadEmail: string | null;
  /** Operator's Google account email. Passed to Calendar via authuser=
   * so the event creator opens against THIS account, not whichever
   * Google account is the browser's default. Without this, CC's "Gold
   * Storm" personal browser was popping up its own primary account
   * instead of the conaugh@oasisai.work one he's signed into the
   * dashboard with. */
  operatorEmail: string | null;
}): string {
  const titleParts = ["Call"];
  if (leadName) titleParts.push(leadName);
  else if (leadCompany) titleParts.push(leadCompany);
  const title = titleParts.join(" — ");
  const details = [
    leadCompany ? `Company: ${leadCompany}` : null,
    leadEmail ? `Email: ${leadEmail}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const params = new URLSearchParams({ text: title });
  if (details) params.set("details", details);
  if (leadEmail) params.set("add", leadEmail);
  if (operatorEmail) params.set("authuser", operatorEmail);
  return `https://calendar.google.com/calendar/r/eventedit?${params.toString()}`;
}

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "ok"; interactionId: string }
  | { kind: "error"; message: string };

export function LeadActionToolbar({
  leadId,
  leadName,
  leadCompany,
  leadEmail,
  daysSinceLastTouch,
  operatorEmail,
  aiToolsSlot,
}: {
  leadId: string;
  leadName: string | null;
  leadCompany: string | null;
  leadEmail: string | null;
  daysSinceLastTouch: number | null;
  /** Operator's signed-in Google account. Used to deep-link Google
   * Calendar to the right authuser so the event editor opens against
   * the operator's connected account instead of whichever Google
   * account the browser defaults to. Null is fine — Calendar falls
   * back to the browser default. */
  operatorEmail?: string | null;
  /** Rendered inside the "AI tools" disclosure. The page passes the
   * existing ScoreLeadButton + NextActionButton as a server-rendered
   * fragment so we don't have to import them from a bracketed-route path. */
  aiToolsSlot?: ReactNode;
}) {
  const initialTemplate = buildCheckInTemplate({
    leadName,
    leadCompany,
    daysSinceLastTouch,
  });

  const [checkInOpen, setCheckInOpen] = useState(false);
  const [subject, setSubject] = useState(initialTemplate.subject);
  const [body, setBody] = useState(initialTemplate.body);
  const [sendState, setSendState] = useState<SendState>({ kind: "idle" });
  const [aiToolsOpen, setAiToolsOpen] = useState(false);

  const calendarUrl = buildCalendarUrl({
    leadName,
    leadCompany,
    leadEmail,
    operatorEmail: operatorEmail ?? null,
  });
  const canEmail = !!leadEmail;

  async function handleSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canEmail) return;
    setSendState({ kind: "sending" });
    try {
      const res = await fetch(`/api/leads/${leadId}/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to_email: leadEmail, subject, body }),
      });
      const data = (await res.json()) as
        | { ok: true; interaction_id: string }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        setSendState({
          kind: "error",
          message: ("error" in data && data.error) || `HTTP ${res.status}`,
        });
        return;
      }
      setSendState({ kind: "ok", interactionId: data.interaction_id });
      // Reset the form to the template after a successful send so a
      // second send doesn't accidentally fire the same body twice.
      setSubject(initialTemplate.subject);
      setBody(initialTemplate.body);
      setTimeout(() => setCheckInOpen(false), 2500);
    } catch (err) {
      setSendState({
        kind: "error",
        message: err instanceof Error ? err.message : "network_failure",
      });
    }
  }

  return (
    <div className="space-y-3">
      {/* Primary CTA row — three big buttons */}
      <div className="grid gap-2 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => setCheckInOpen((v) => !v)}
          disabled={!canEmail}
          title={canEmail ? "Compose a check-in email" : "Add an email to send"}
          className={`group relative rounded-lg border px-4 py-3 text-left transition-all ${
            canEmail
              ? "border-accent/40 bg-accent/5 hover:bg-accent/10"
              : "border-bg-border bg-bg-elev/30 opacity-50 cursor-not-allowed"
          }`}
        >
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-accent" />
            <span className="text-sm font-bold text-fg">Send check-in</span>
          </div>
          <div className="text-xs text-fg-muted mt-1">
            {canEmail
              ? "Personalized email via send_gateway"
              : "Lead has no email on file"}
          </div>
        </button>

        <a
          href={calendarUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-bg-border bg-bg-elev/50 hover:bg-bg-elev px-4 py-3 transition-all"
        >
          <div className="flex items-center gap-2">
            <CalendarPlus className="w-4 h-4 text-fg" />
            <span className="text-sm font-bold text-fg">Schedule call</span>
          </div>
          <div className="text-xs text-fg-muted mt-1">
            Opens Google Calendar with context pre-filled
          </div>
        </a>

        <MarkStaleButton leadId={leadId} />
      </div>

      {/* Inline check-in composer */}
      {checkInOpen && (
        <form
          onSubmit={handleSend}
          className="rounded-lg border border-accent/40 bg-bg-elev/40 p-4 space-y-3"
        >
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-fg-dim">
              To
            </label>
            <div className="text-sm font-mono text-fg mt-0.5">{leadEmail}</div>
          </div>
          <div>
            <label
              htmlFor={`subject-${leadId}`}
              className="text-[10px] uppercase tracking-wider font-bold text-fg-dim"
            >
              Subject
            </label>
            <input
              id={`subject-${leadId}`}
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="mt-0.5 w-full bg-bg-elev border border-bg-border rounded px-3 py-2 text-sm text-fg"
              required
              maxLength={200}
            />
          </div>
          <div>
            <label
              htmlFor={`body-${leadId}`}
              className="text-[10px] uppercase tracking-wider font-bold text-fg-dim"
            >
              Body
            </label>
            <textarea
              id={`body-${leadId}`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              className="mt-0.5 w-full bg-bg-elev border border-bg-border rounded px-3 py-2 text-sm text-fg font-sans leading-relaxed"
              required
              maxLength={32000}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-fg-muted">
              {sendState.kind === "ok" && (
                <span className="text-accent inline-flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Queued — send_gateway will deliver within 60s
                </span>
              )}
              {sendState.kind === "error" && (
                <span className="text-status-warm inline-flex items-center gap-1">
                  <XCircle className="w-3.5 h-3.5" />
                  Couldn&apos;t queue: {sendState.message}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCheckInOpen(false)}
                className="text-xs text-fg-dim hover:text-fg px-3 py-2"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sendState.kind === "sending" || sendState.kind === "ok"}
                className="btn-primary inline-flex items-center gap-1.5 !px-3 !py-2 text-xs"
              >
                {sendState.kind === "sending" && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                )}
                {sendState.kind === "sending" ? "Queuing…" : "Queue send"}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* AI tools disclosure — re-score + re-recommend, demoted */}
      <div className="rounded-lg border border-bg-border bg-bg-elev/30">
        <button
          type="button"
          onClick={() => setAiToolsOpen((v) => !v)}
          className="w-full px-4 py-2.5 flex items-center justify-between text-left hover:bg-bg-elev/50 transition-colors"
        >
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Sparkles className="w-3.5 h-3.5" />
            AI tools
            <span className="text-fg-dim">·</span>
            <Compass className="w-3.5 h-3.5" />
            <span>Re-score · Re-recommend next move</span>
          </div>
          <span className="text-[10px] text-fg-dim">
            {aiToolsOpen ? "hide" : "show"}
          </span>
        </button>
        {aiToolsOpen && aiToolsSlot && (
          <div className="border-t border-bg-border p-4 grid gap-3 lg:grid-cols-2">
            {aiToolsSlot}
          </div>
        )}
      </div>
    </div>
  );
}

function MarkStaleButton({ leadId }: { leadId: string }) {
  // Toggles lead.data.drip_paused. The OASIS drip / nurture sequence is
  // the background job that sends scheduled follow-up emails over time
  // (Day 2 check-in, Day 5 break-up, Day 14 final, etc) — driven by the
  // Sequence runner daemon. Pausing skips this specific lead from the
  // sequence so the operator can take it over manually; resuming
  // re-enrolls it.
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"paused" | "active" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/drip-toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const data = (await res.json()) as
        | { ok: true; paused: boolean }
        | { ok: false; error: string };
      if (!res.ok || !data.ok) {
        setError(("error" in data && data.error) || `HTTP ${res.status}`);
        return;
      }
      setResult(data.paused ? "paused" : "active");
    } catch (e) {
      setError(e instanceof Error ? e.message : "network_failure");
    } finally {
      setBusy(false);
    }
  }

  const icon =
    result === "paused" ? (
      <PauseCircle className="w-4 h-4 text-status-warm" />
    ) : (
      <PlayCircle className="w-4 h-4 text-fg" />
    );

  const title =
    result === "paused"
      ? "Auto follow-ups paused on this lead. Click to resume — Sequence runner will pick the lead back up on its next pass and send the next scheduled follow-up."
      : result === "active"
        ? "Auto follow-ups will continue. Sequence runner sends the next scheduled email on its next pass."
        : "Pause / resume the OASIS auto follow-up sequence for THIS lead. The sequence sends scheduled check-ins over time (Day 2, Day 5, Day 14 etc). Pause if you're taking the conversation over manually; resume to let the daemon take it back.";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={title}
      className="rounded-lg border border-bg-border bg-bg-elev/50 hover:bg-bg-elev px-4 py-3 transition-all text-left disabled:opacity-50"
    >
      <div className="flex items-center gap-2">
        {busy ? <Loader2 className="w-4 h-4 animate-spin text-fg" /> : icon}
        <span className="text-sm font-bold text-fg">
          {result === "paused"
            ? "Auto follow-ups paused"
            : result === "active"
              ? "Auto follow-ups on"
              : "Pause auto follow-ups"}
        </span>
      </div>
      <div className="text-xs text-fg-muted mt-1">
        {error
          ? `Error: ${error}`
          : result === "paused"
            ? "OASIS won't auto-send scheduled check-ins to this lead. Click to re-enable."
            : result === "active"
              ? "OASIS will auto-send the next scheduled check-in"
              : "Stop OASIS from auto-sending scheduled check-ins to this lead"}
      </div>
    </button>
  );
}
