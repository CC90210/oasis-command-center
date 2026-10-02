"use client";

/**
 * Book the Meet: book the founder meeting from the battle card or Call Mode,
 * with the owner still on the line, without leaving the call screen.
 *
 * BookMeetForm is presentational (props in, markup out) so tests can render
 * every state. BookMeetPanel owns the reads, the request ids and the flow.
 *
 * The flow and its failure handling live in lib/web-leads/book-meet-flow.ts.
 * The four gates live in lib/sales-qualification.ts, shared with Pipeline.
 * No colour is keyed to meaning beyond the existing tokens: accent for the
 * primary action and success, status-warm for anything a rep must act on.
 * Nothing about the client is stored in the browser.
 *
 * DO-NOT-CALL: the "owner asked for this meeting" box shows only when the
 * booking view or a refusal says the lead is do-not-call, and it is only ever
 * the rep's own tick (never inferred), same as every other confirmation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarCheck, Loader2, X } from "lucide-react";
import { mayHostAuditCall } from "@/lib/team-roles";
import { SMS_CONSENT_DISCLOSURE, SMS_CONSENT_DISCLOSURE_VERSION } from "@/lib/sms/auto-responses";
import { QUALIFICATION_GATES, PAIN_WORDS_MAX, type QualificationGateKey } from "@/lib/sales-qualification";
import {
  EASTERN_TIME_ZONE,
  MEETING_TIME_OPTIONS,
  ZONE_CHOICES,
  dateChoiceInZone,
  formatMeetingInZone,
  type ProspectZone,
} from "@/lib/meeting-time";
import {
  DEFAULT_CLIENT_AGENDA,
  bookMeetBlockedReason,
  bookMeetMessage,
  bookingSignature,
  meetingAtOf,
  outcomeSignature,
  runBookMeetFlow,
  type BookMeetDraft,
  type BookMeetResult,
  type BookedMeeting,
  type FlowIO,
  type HttpResult,
} from "@/lib/web-leads/book-meet-flow";

export type HostOption = {
  userId: string;
  name: string;
  email: string | null;
  calendarReady: boolean | null;
  identityMismatch: boolean;
  connectedAddress: string | null;
};
export type BookMeetStatus = { kind: "idle" } | { kind: "working"; step: "call" | "check" | "booking" } | BookMeetResult;

export type BookMeetFormProps = {
  variant: "card" | "callmode";
  businessName: string;
  draft: BookMeetDraft;
  zone: ProspectZone;
  hosts: HostOption[];
  hostState: "loading" | "ready" | "unavailable";
  systemCalendarFallback: boolean;
  altEmails: string[];
  altPhone: string | null;
  status: BookMeetStatus;
  blockedReason: string | null;
  blocked: { code: string; message: string } | null;
  existingMeeting: BookedMeeting | null;
  now: number;
  onDraft: (next: BookMeetDraft) => void;
  onSubmit: () => void;
  onUnlock: () => void;
  onClose?: () => void;
  onNextLead?: () => void;
};

const EMPTY_GATES: BookMeetDraft["gates"] = {
  authorityConfirmed: false,
  websiteProblemConfirmed: false,
  timingConfirmed: false,
  minimumInvestmentConfirmed: false,
};
const EMPTY_CONFIRMATIONS: BookMeetDraft["confirmations"] = {
  contactConfirmed: false,
  clientAgreedToTime: false,
  handoffComplete: false,
  ownerRequestedMeeting: false,
};

const FIELD =
  "mt-1 block w-full min-h-11 rounded-md border border-bg-border bg-bg-deep px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 read-only:opacity-70 disabled:opacity-60";
const LABEL = "block text-xs font-semibold text-fg-muted";
const SECTION = "space-y-2 border-t border-bg-border pt-4";
const BUTTON =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const PRIMARY = `${BUTTON} border-accent bg-accent text-white transition-[filter] hover:brightness-110`;
const SECONDARY = `${BUTTON} border-bg-border bg-bg-panel text-fg transition-colors hover:border-accent/50`;
const NOTICE = "rounded-md border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-fg";

function Check({
  checked, disabled, onChange, children, describedBy,
}: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void; children: React.ReactNode; describedBy?: string }) {
  return (
    <label
      className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-sm text-fg ${
        checked ? "border-accent bg-accent-soft" : "border-bg-border bg-bg-panel hover:border-accent/50"
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-accent"
        checked={checked}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

function calendarLine(host: HostOption | undefined, fallback: boolean): string | null {
  if (!host || host.calendarReady === null) return null;
  if (host.calendarReady) return "Google Calendar is ready for this host.";
  if (fallback) return "Ready to book from the OASIS AI calendar. The client gets the invite and Meet link, and the OASIS AI account appears as the organiser.";
  if (host.identityMismatch) return `This host connected ${host.connectedAddress || "a different Google account"}. Pick another host, or they reconnect with their OASIS email.`;
  return "This host must reconnect Google Calendar before a booking can be created. Pick another host.";
}

export function BookMeetForm(p: BookMeetFormProps) {
  const { draft, status } = p;
  const readOnly = status.kind === "working" || status.kind === "unconfirmed" || status.kind === "booked_finish" || status.kind === "booked";
  const set = (patch: Partial<BookMeetDraft>) => p.onDraft({ ...draft, ...patch });
  const setGate = (key: QualificationGateKey, value: boolean) => set({ gates: { ...draft.gates, [key]: value } });
  const confirm = (patch: Partial<BookMeetDraft["confirmations"]>) => set({ confirmations: { ...draft.confirmations, ...patch } });
  const at = meetingAtOf(draft);
  const theirTime = at ? formatMeetingInZone(at, draft.timeZone) : null;
  const easternTime = at && draft.timeZone !== EASTERN_TIME_ZONE ? formatMeetingInZone(at, EASTERN_TIME_ZONE) : null;
  const zoneLabel = ZONE_CHOICES.find((z) => z.timeZone === draft.timeZone)?.label ?? p.zone.label;
  const host = p.hosts.find((h) => h.userId === draft.hostUserId);
  const fieldError = status.kind === "fix" ? status.field : null;
  const hostLine = calendarLine(host, p.systemCalendarFallback);

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 tabIndex={-1} data-book-meet-heading className="text-lg font-bold text-fg focus:outline-none">Book the Meet</h2>
        <p className="mt-0.5 text-sm text-fg-muted">{p.businessName}</p>
      </div>
      {p.onClose && status.kind !== "working" && status.kind !== "unconfirmed" ? (
        <button type="button" onClick={p.onClose} className={SECONDARY} aria-label="Close Book the Meet">
          <X className="h-4 w-4" aria-hidden />Close
        </button>
      ) : null}
    </div>
  );

  if (p.blocked) {
    return (
      <section aria-label="Book the Meet" className="space-y-3">
        {header}
        <div role="alert" className={NOTICE}>{p.blocked.message}</div>
        {p.existingMeeting ? <Receipt meeting={p.existingMeeting} zone={draft.timeZone} /> : null}
      </section>
    );
  }

  if (status.kind === "booked") {
    return (
      <section aria-label="Book the Meet" className="space-y-3">
        {header}
        <div role="status" className="rounded-md border border-accent/50 bg-accent-soft p-3 text-sm text-fg">
          <p className="font-semibold">Booked. The invite is on its way to {draft.contact.email}.</p>
          <p className="mt-1">Host: {host?.name ?? "the selected host"}</p>
        </div>
        <Receipt meeting={status.meeting} zone={draft.timeZone} />
        {p.variant === "callmode" && p.onNextLead ? (
          <button type="button" onClick={p.onNextLead} className={`${PRIMARY} w-full min-h-14 lg:min-h-11`}>Next lead</button>
        ) : p.onClose ? (
          <button type="button" onClick={p.onClose} className={SECONDARY}>Done</button>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-label="Book the Meet" className="space-y-4">
      {header}
      <p className="text-sm text-fg-muted">
        They said yes. Book it while they are on the line.{" "}
        {draft.doNotCall
          ? "This lead is on the do-not-call list, so the call is not logged; the booking is the record."
          : "This also logs the call as Interested."}
      </p>

      <fieldset className="space-y-2" disabled={readOnly}>
        <legend className={LABEL}>Check these while you talk</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {QUALIFICATION_GATES.map((gate) => (
            <div key={gate.key} className="space-y-1">
              <Check
                checked={draft.gates[gate.key]}
                disabled={readOnly}
                describedBy={`gate-hint-${gate.key}`}
                onChange={(v) => setGate(gate.key, v)}
              >
                <span className="font-semibold">{gate.label}</span>
                <span id={`gate-hint-${gate.key}`} className="block text-xs text-fg-muted">{gate.hint}</span>
              </Check>
              {gate.key === "websiteProblemConfirmed" ? (
                <label className={LABEL}>
                  Their words
                  <input
                    className={FIELD}
                    value={draft.painWords}
                    maxLength={PAIN_WORDS_MAX}
                    readOnly={readOnly}
                    placeholder="What they said is going wrong"
                    onChange={(e) => set({ painWords: e.target.value })}
                  />
                </label>
              ) : null}
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className={SECTION} disabled={readOnly}>
        <legend className={LABEL}>When</legend>
        <label className={LABEL}>
          Their time zone{p.zone.known ? "" : " (we do not know their province, so this is Eastern until you change it)"}
          <select className={FIELD} value={draft.timeZone} onChange={(e) => set({ timeZone: e.target.value })}>
            {ZONE_CHOICES.map((z) => <option key={z.timeZone} value={z.timeZone}>{z.label}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          {[{ label: "Today", days: 0 }, { label: "Tomorrow", days: 1 }, { label: "In 2 days", days: 2 }].map((c) => (
            <button
              key={c.label}
              type="button"
              disabled={readOnly}
              className={SECONDARY}
              aria-pressed={draft.meetingDate === dateChoiceInZone(c.days, draft.timeZone, p.now)}
              onClick={() => set({ meetingDate: dateChoiceInZone(c.days, draft.timeZone, p.now) })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className={LABEL}>
            Day
            <input type="date" className={FIELD} value={draft.meetingDate} readOnly={readOnly}
              aria-invalid={fieldError === "time" ? true : undefined}
              onChange={(e) => set({ meetingDate: e.target.value })} />
          </label>
          <label className={LABEL}>
            Time ({zoneLabel})
            <select className={FIELD} value={draft.meetingTime}
              aria-invalid={fieldError === "time" ? true : undefined}
              onChange={(e) => set({ meetingTime: e.target.value })}>
              <option value="">Pick a time</option>
              {MEETING_TIME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
        {theirTime ? (
          <p className="text-sm text-fg tabular-nums">
            {theirTime} {zoneLabel}
            {easternTime ? <span className="text-fg-muted">, which is {easternTime} Eastern</span> : null}
          </p>
        ) : null}
      </fieldset>

      <fieldset className={SECTION} disabled={readOnly}>
        <legend className={LABEL}>Who hosts</legend>
        <label className={LABEL}>
          Host
          <select className={FIELD} value={draft.hostUserId} disabled={p.hostState !== "ready" || readOnly}
            aria-invalid={fieldError === "host" ? true : undefined}
            onChange={(e) => set({ hostUserId: e.target.value })}>
            <option value="">Pick a host</option>
            {p.hosts.map((h) => <option key={h.userId} value={h.userId}>{h.name}</option>)}
          </select>
        </label>
        {p.hostState === "loading" ? <p role="status" className="text-xs text-fg-muted">Loading hosts...</p> : null}
        {p.hostState === "unavailable" ? (
          <p role="alert" className={NOTICE}>The host list could not load. Nothing was booked. Close this and open it again.</p>
        ) : null}
        {hostLine ? <p className="text-xs text-fg-muted">{hostLine}</p> : null}
      </fieldset>

      <fieldset className={SECTION} disabled={readOnly}>
        <legend className={LABEL}>Where the invite goes</legend>
        <label className={LABEL}>
          Email for the invite <span className="font-normal">(required)</span>
          <input type="email" required className={FIELD} value={draft.contact.email} readOnly={readOnly}
            aria-invalid={fieldError === "email" ? true : undefined}
            onChange={(e) => set({ contact: { ...draft.contact, email: e.target.value } })} />
        </label>
        {!draft.contact.email.trim() ? <p className="text-xs text-fg">Ask: what is the best email for the calendar invite?</p> : null}
        {p.altEmails.length ? (
          <div className="flex flex-wrap gap-2">
            {p.altEmails.map((email) => (
              <button key={email} type="button" className={SECONDARY} disabled={readOnly}
                onClick={() => set({ contact: { ...draft.contact, email } })}>
                Use {email}
              </button>
            ))}
          </div>
        ) : null}
        <label className={LABEL}>
          Phone <span className="font-normal">(required)</span>
          <input type="tel" required className={`${FIELD} tabular-nums`} value={draft.contact.phone} readOnly={readOnly}
            aria-invalid={fieldError === "phone" ? true : undefined}
            onChange={(e) => set({ contact: { ...draft.contact, phone: e.target.value }, smsConsent: false })} />
        </label>
        {p.altPhone ? (
          <button type="button" className={SECONDARY} disabled={readOnly}
            onClick={() => set({ contact: { ...draft.contact, phone: p.altPhone! }, smsConsent: false })}>
            Use owner direct line <span className="tabular-nums">{p.altPhone}</span>
          </button>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <label className={LABEL}>
            Their name
            <input className={FIELD} value={draft.contact.name} readOnly={readOnly}
              onChange={(e) => set({ contact: { ...draft.contact, name: e.target.value } })} />
          </label>
          <label className={LABEL}>
            Business
            <input className={FIELD} value={draft.contact.company} readOnly={readOnly}
              onChange={(e) => set({ contact: { ...draft.contact, company: e.target.value } })} />
          </label>
        </div>
        <details>
          <summary className="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-fg-muted">More details</summary>
          <label className={LABEL}>
            Website (optional)
            <input type="url" className={FIELD} value={draft.contact.website} readOnly={readOnly}
              aria-invalid={fieldError === "website" ? true : undefined}
              onChange={(e) => set({ contact: { ...draft.contact, website: e.target.value } })} />
          </label>
        </details>
      </fieldset>

      <fieldset className={SECTION} disabled={readOnly}>
        <legend className={LABEL}>What they will see in the invite</legend>
        <textarea className={`${FIELD} min-h-20 py-2`} rows={3} maxLength={500} value={draft.agenda} readOnly={readOnly}
          aria-label="What they will see in the invite"
          aria-invalid={fieldError === "agenda" ? true : undefined}
          onChange={(e) => set({ agenda: e.target.value })} />
        <label className={LABEL}>
          Note for the host (they never see this)
          <textarea className={`${FIELD} min-h-20 py-2`} rows={3} maxLength={3400} value={draft.hostNote} readOnly={readOnly}
            aria-invalid={fieldError === "note" ? true : undefined}
            placeholder="Crews, tools they use now, objections, anything you promised"
            onChange={(e) => set({ hostNote: e.target.value })} />
        </label>
        <p className="text-xs text-fg-muted">Their words are added to the top of this note automatically.</p>
      </fieldset>

      <fieldset className={SECTION} disabled={readOnly}>
        <legend className={LABEL}>Read it back</legend>
        <Check checked={draft.confirmations.contactConfirmed} disabled={readOnly}
          onChange={(v) => confirm({ contactConfirmed: v })}>
          I read the email back and it is right.
        </Check>
        <Check checked={draft.confirmations.clientAgreedToTime} disabled={readOnly}
          onChange={(v) => confirm({ clientAgreedToTime: v })}>
          They agreed to this day and time.
        </Check>
        <Check checked={draft.confirmations.handoffComplete} disabled={readOnly}
          onChange={(v) => confirm({ handoffComplete: v })}>
          The note for the host is done.
        </Check>
        {draft.doNotCall ? (
          <div className="space-y-1">
            <Check checked={draft.confirmations.ownerRequestedMeeting} disabled={readOnly}
              describedBy="book-meet-dnc-hint"
              onChange={(v) => confirm({ ownerRequestedMeeting: v })}>
              The owner asked for this meeting on this call.
            </Check>
            <p id="book-meet-dnc-hint" className="text-xs text-fg-muted">
              This business is on the do-not-call list. Tick this only if the owner asked for the meeting. Your name and the time are saved with the booking.
            </p>
          </div>
        ) : null}
        {draft.contact.phone.trim() ? (
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-fg-muted">Optional: text reminders</summary>
            <p className="text-xs text-fg-muted">Read this to them word for word, and tick only if they say yes:</p>
            <p className="my-2 text-sm text-fg">{SMS_CONSENT_DISCLOSURE}</p>
            <Check checked={draft.smsConsent} disabled={readOnly} onChange={(v) => set({ smsConsent: v })}>
              They said yes to text reminders at {draft.contact.phone.trim()}.
            </Check>
          </details>
        ) : null}
      </fieldset>

      {"message" in status ? (
        <div role="alert" tabIndex={-1} data-book-meet-alert className={NOTICE}>{status.message}</div>
      ) : null}

      <div className="space-y-2 border-t border-bg-border pt-4">
        {status.kind === "unconfirmed" || status.kind === "booked_finish" ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="button" onClick={p.onSubmit} className={`${PRIMARY} min-h-14 lg:min-h-11`}>Try again</button>
            {status.kind === "unconfirmed" ? (
              <button type="button" onClick={p.onUnlock} className={SECONDARY}>Change details</button>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={p.onSubmit}
            disabled={Boolean(p.blockedReason) || status.kind === "working"}
            aria-busy={status.kind === "working" ? true : undefined}
            aria-describedby="book-meet-reason"
            className={`${PRIMARY} w-full min-h-14 lg:min-h-11`}
          >
            {status.kind === "working" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <CalendarCheck className="h-4 w-4" aria-hidden />}
            {status.kind === "working"
              ? status.step === "call" ? "Saving the call..." : status.step === "check" ? "Checking the lead..." : "Booking with Google..."
              : status.kind === "retry_safe" ? "Try again" : "Book the Meet and send the invite"}
          </button>
        )}
        <p id="book-meet-reason" className="text-xs text-fg-muted">
          {p.blockedReason && status.kind !== "working" ? p.blockedReason : "Ready when you are."}
        </p>
        {status.kind === "unconfirmed" ? (
          <p className="text-xs text-fg-muted">
            Change details only if the time or email was wrong. If Google already sent the first invite, it is cancelled automatically within 15 minutes and they get the new one.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Receipt({ meeting, zone }: { meeting: BookedMeeting; zone: string }) {
  if (!meeting.meetingAt) return null;
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-xs font-semibold text-fg-muted">Their time</dt>
        <dd className="tabular-nums text-fg">{formatMeetingInZone(meeting.meetingAt, zone)}</dd>
      </div>
      <div>
        <dt className="text-xs font-semibold text-fg-muted">Eastern</dt>
        <dd className="tabular-nums text-fg">{formatMeetingInZone(meeting.meetingAt, EASTERN_TIME_ZONE)}</dd>
      </div>
      {meeting.meetLink ? (
        <div className="sm:col-span-2">
          <dt className="text-xs font-semibold text-fg-muted">Google Meet</dt>
          <dd><a href={meeting.meetLink} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center break-all text-accent underline">{meeting.meetLink}</a></dd>
        </div>
      ) : null}
      {meeting.calendarUrl ? (
        <div className="sm:col-span-2">
          <dt className="sr-only">Calendar</dt>
          <dd><a href={meeting.calendarUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-accent underline">Open in Google Calendar</a></dd>
        </div>
      ) : null}
    </dl>
  );
}

/* ── Container ────────────────────────────────────────────────────────── */

type ContextBody = {
  ok: true;
  viewerUserId: string;
  stage: string | null;
  canBook: boolean;
  blocked: string | null;
  doNotCall: boolean;
  prefill: { name: string; company: string; email: string; altEmails: string[]; phone: string; altPhone: string | null; website: string };
  prospectZone: ProspectZone;
  meeting: { at: string; meetLink: string | null; calendarUrl: string | null } | null;
};
type MemberRow = {
  auth_user_id: string | null; email: string | null; full_name: string; display_name: string | null;
  team_role: string; is_owner: boolean; calendar_ready?: boolean | null; calendar_connected?: boolean | null;
  calendar_identity_mismatch?: boolean | null; connected_google_address?: string | null;
};

async function http(url: string, init?: RequestInit): Promise<HttpResult> {
  try {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  } catch {
    return { networkError: true };
  }
}

function smsConsentArtifact(): Record<string, unknown> {
  return {
    disclosure_text: SMS_CONSENT_DISCLOSURE,
    disclosure_version: SMS_CONSENT_DISCLOSURE_VERSION,
    seller_named: "OASIS AI Solutions",
    captured_at: new Date().toISOString(),
    method: "verbal",
    source_url: window.location.href,
  };
}

export function BookMeetPanel(props: {
  leadId: string;
  businessName: string;
  variant: "card" | "callmode";
  onClose?: () => void;
  onBooked?: (meeting: BookedMeeting) => void;
  onNextLead?: () => void;
  onUnresolvedChange?: (unresolved: boolean) => void;
}) {
  const { leadId, onUnresolvedChange, onBooked } = props;
  const [ctx, setCtx] = useState<{ state: "loading" } | { state: "error" } | { state: "ready"; body: ContextBody }>({ state: "loading" });
  const [hosts, setHosts] = useState<{ state: "loading" | "ready" | "unavailable"; list: HostOption[]; fallback: boolean }>({ state: "loading", list: [], fallback: false });
  const [draft, setDraft] = useState<BookMeetDraft | null>(null);
  const [status, setStatus] = useState<BookMeetStatus>({ kind: "idle" });
  const [outcomeSaved, setOutcomeSaved] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const idsRef = useRef<{ outcome: string; outcomeSig: string; booking: string; bookingSig: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Context read. Per-effect `alive`, never a module-scope promise (Worker request isolation).
  useEffect(() => {
    let alive = true;
    setCtx({ state: "loading" });
    http(`/api/web-leads/${encodeURIComponent(leadId)}?view=booking`).then((r) => {
      if (!alive) return;
      if ("networkError" in r || r.status !== 200 || r.body.ok !== true) { setCtx({ state: "error" }); return; }
      setCtx({ state: "ready", body: r.body as unknown as ContextBody });
    });
    return () => { alive = false; };
  }, [leadId]);

  // Hosts, same filter as Pipeline (app/pipeline/[id]/LeadLifecycleActions.tsx). Only when the panel opens.
  useEffect(() => {
    let alive = true;
    http("/api/team/members").then((r) => {
      if (!alive) return;
      if ("networkError" in r || r.status !== 200 || !Array.isArray(r.body.members)) { setHosts({ state: "unavailable", list: [], fallback: false }); return; }
      const list = (r.body.members as MemberRow[])
        .filter((m) => m.auth_user_id && (m.is_owner || mayHostAuditCall(m.team_role)))
        .map((m) => ({
          userId: m.auth_user_id!,
          name: m.display_name || m.full_name,
          email: m.email,
          calendarReady: m.calendar_ready ?? m.calendar_connected ?? null,
          identityMismatch: m.calendar_identity_mismatch === true,
          connectedAddress: m.connected_google_address ?? null,
        }));
      setHosts({ state: "ready", list, fallback: r.body.system_calendar_fallback === true });
    });
    return () => { alive = false; };
  }, []);

  // Build the draft once both reads are in.
  useEffect(() => {
    if (draft || ctx.state !== "ready" || hosts.state === "loading") return;
    const b = ctx.body;
    const zone = b.prospectZone.timeZone;
    const viewerIsHost = hosts.list.some((h) => h.userId === b.viewerUserId);
    setDraft({
      leadId,
      gates: { ...EMPTY_GATES },
      painWords: "",
      timeZone: zone,
      meetingDate: dateChoiceInZone(1, zone),
      meetingTime: "",
      hostUserId: viewerIsHost ? b.viewerUserId : hosts.list[0]?.userId ?? "",
      contact: { name: b.prefill.name, company: b.prefill.company, email: b.prefill.email, phone: b.prefill.phone, website: b.prefill.website },
      agenda: DEFAULT_CLIENT_AGENDA,
      hostNote: "",
      doNotCall: b.doNotCall === true,
      confirmations: { ...EMPTY_CONFIRMATIONS },
      smsConsent: false,
    });
  }, [ctx, hosts, draft, leadId]);

  // Focus the heading when the panel opens; refresh "now" each minute so "already passed" stays true.
  const formReady = draft !== null;
  useEffect(() => { rootRef.current?.querySelector<HTMLElement>("[data-book-meet-heading]")?.focus(); }, [formReady]);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(t); }, []);
  // Move focus to any new alert.
  useEffect(() => {
    if ("message" in status) rootRef.current?.querySelector<HTMLElement>("[data-book-meet-alert]")?.focus();
  }, [status]);

  const unresolved = status.kind === "working" || status.kind === "unconfirmed" || status.kind === "booked_finish";
  useEffect(() => { onUnresolvedChange?.(unresolved); }, [unresolved, onUnresolvedChange]);
  useEffect(() => {
    if (!unresolved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unresolved]);

  const blockedReason = useMemo(() => (draft ? bookMeetBlockedReason(draft, now) : "Loading..."), [draft, now]);

  const submit = useCallback(async () => {
    if (!draft || status.kind === "working" || (blockedReason && status.kind !== "unconfirmed" && status.kind !== "booked_finish")) return;
    const bSig = bookingSignature(draft);
    const oSig = outcomeSignature(draft);
    const cur = idsRef.current;
    idsRef.current = {
      outcome: !cur || (!outcomeSaved && cur.outcomeSig !== oSig) ? crypto.randomUUID() : cur.outcome,
      outcomeSig: oSig,
      booking: !cur || cur.bookingSig !== bSig ? crypto.randomUUID() : cur.booking,
      bookingSig: bSig,
    };
    const io: FlowIO = {
      postOutcome: (id, body) => http(`/api/web-leads/${encodeURIComponent(id)}/outcome`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      getContext: (id) => http(`/api/web-leads/${encodeURIComponent(id)}?view=booking`),
      patchBooking: (id, body) => http(`/api/website-sales/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    };
    setStatus({ kind: "working", step: outcomeSaved || draft.doNotCall ? "check" : "call" });
    const { result, outcomeSaved: saved } = await runBookMeetFlow(
      draft,
      { outcomeRequestId: idsRef.current.outcome, bookingRequestId: idsRef.current.booking },
      { outcomeSaved },
      io,
      draft.smsConsent ? smsConsentArtifact() : null,
      (step) => setStatus({ kind: "working", step }),
    );
    setOutcomeSaved(saved);
    // A do-not-call refusal means the lead is on the list now even if it was
    // not when the panel opened: show the owner-asked box (unticked).
    if (result.kind === "fix" && result.field === "dnc") setDraft((d) => (d ? { ...d, doNotCall: true } : d));
    setStatus(result);
    if (result.kind === "booked") {
      window.dispatchEvent(new CustomEvent("oasis:lead-touch", { detail: { leadId } }));
      onBooked?.(result.meeting);
    }
  }, [draft, status.kind, blockedReason, outcomeSaved, leadId, onBooked]);

  if (ctx.state === "loading" || (ctx.state === "ready" && !draft && !ctx.body.blocked)) {
    return <div ref={rootRef} role="status" aria-busy="true" className="text-sm text-fg-muted">Loading Book the Meet...</div>;
  }
  if (ctx.state === "error") {
    return (
      <div ref={rootRef} role="alert" className={NOTICE}>
        We could not check this lead just now. Nothing was booked. Close this and open it again.
      </div>
    );
  }
  const body = ctx.body;
  const blocked = body.blocked ? { code: body.blocked, message: bookMeetMessage(body.blocked, "blocked") } : null;
  const formDraft: BookMeetDraft = draft ?? {
    leadId, gates: { ...EMPTY_GATES }, painWords: "", timeZone: body.prospectZone.timeZone, meetingDate: "", meetingTime: "",
    hostUserId: "", contact: { name: "", company: "", email: "", phone: "", website: "" }, agenda: DEFAULT_CLIENT_AGENDA,
    hostNote: "", doNotCall: body.doNotCall === true, confirmations: { ...EMPTY_CONFIRMATIONS }, smsConsent: false,
  };

  return (
    <div ref={rootRef}>
      <BookMeetForm
        variant={props.variant}
        businessName={props.businessName}
        draft={formDraft}
        zone={body.prospectZone}
        hosts={hosts.list}
        hostState={hosts.state}
        systemCalendarFallback={hosts.fallback}
        altEmails={body.prefill.altEmails}
        altPhone={body.prefill.altPhone}
        status={status}
        blockedReason={blockedReason}
        blocked={blocked}
        existingMeeting={body.meeting ? { meetingAt: body.meeting.at, meetLink: body.meeting.meetLink, calendarUrl: body.meeting.calendarUrl } : null}
        now={now}
        onDraft={setDraft}
        onSubmit={() => void submit()}
        onUnlock={() => setStatus({ kind: "idle" })}
        onClose={props.onClose}
        onNextLead={props.onNextLead}
      />
    </div>
  );
}
