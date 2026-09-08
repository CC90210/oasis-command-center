"use client";

/**
 * LeadQuickEmail — the "just email me" button, at the bottom of Edit lead details.
 *
 * THE MOMENT THIS EXISTS FOR (CC, 2026-09-08): an owner picks up, the rep gets
 * thirty seconds, and the owner says "can you just send me an email?". Until now
 * that ended the call with a promise the rep had to keep later, from a different
 * screen — the pipeline lead workspace had no send path at all, while
 * /leads/[id] did. The rep types what they learned into the fields above and
 * sends from the same panel, on any stage.
 *
 * NOT STAGE-GATED, deliberately. CC: "It shouldn't be for a specific stage ...
 * it should just be an option they have access to at all times." A gate here
 * would mean the one call that went well is the one the rep cannot follow up on
 * because the stage has not been moved yet.
 *
 * PERSONALISED FROM THE LIVE FORM, NOT THE SAVED ROW. The draft is built from
 * the editor's CURRENT state, so a rep who has just typed the audit findings and
 * the call notes sees them in the email without saving first. Saving and sending
 * are separate actions and either order works.
 *
 * WHAT IT REFUSES TO SAY. The board's placeholder strings ("Not audited yet -
 * confirm on the call", "No website found yet, needs checking") are honest
 * INTERNAL sentences and would be nonsense — or worse, a fabricated finding — in
 * a message to the prospect. They are stripped, and when nothing real is left
 * the draft simply omits that paragraph rather than inventing one. This is the
 * same rule the lead card renders under: never state a finding no one observed.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Mail, Send } from "lucide-react";
import {
  buildDraft,
  defaultNextTouch,
  TEMPLATES,
  type QuickEmailLead,
  type TemplateId,
} from "@/lib/leads/quick-email-draft";

export type { QuickEmailLead } from "@/lib/leads/quick-email-draft";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const INPUT =
  "w-full rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg outline-none transition placeholder:text-fg-faint focus:border-accent/70 focus:ring-1 focus:ring-accent/30";

export function LeadQuickEmail({
  leadId,
  tenantSlug,
  lead,
  bookingUrl,
  hasBookedMeeting,
}: {
  leadId: string;
  tenantSlug: string;
  lead: QuickEmailLead;
  /** Resolved on the SERVER so the full env fallback chain applies; a client
   *  read would only see NEXT_PUBLIC_* and silently use the hardcoded default. */
  bookingUrl: string;
  /**
   * A meeting is already on the calendar. The self-book link is then SUPPRESSED
   * rather than offered — lib/portals/stage-hooks.ts removed the qualified-stage
   * booking email for exactly this reason: once an exact time is agreed, a
   * second "pick any slot" link creates a conflicting schedule. Before a time
   * exists there is nothing to conflict with, which is the case this component
   * serves.
   */
  hasBookedMeeting: boolean;
}) {
  const router = useRouter();
  const effectiveBookingUrl = hasBookedMeeting ? "" : bookingUrl;

  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<TemplateId>("thanks_for_call");
  const [to, setTo] = useState(() => (lead.email || "").trim());
  const [touched, setTouched] = useState(false);

  // FOLLOW THE LIVE EDITOR while the rep has not typed a recipient here.
  //
  // `to` is seeded once from lead.email. Without this, a rep who fixes the Email
  // field in the panel ABOVE keeps the stale address down here and sends to it —
  // in a component whose entire premise is that it reflects the unsaved form.
  // Same "rep edits win" rule the draft follows: once they touch this field
  // nothing overwrites it. Codex caught this on review.
  const upstreamEmail = (lead.email || "").trim();
  const [seenUpstream, setSeenUpstream] = useState(upstreamEmail);
  if (!touched && upstreamEmail !== seenUpstream) {
    setSeenUpstream(upstreamEmail);
    setTo(upstreamEmail);
  }
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [scheduleNext, setScheduleNext] = useState(true);
  const [nextAt, setNextAt] = useState(defaultNextTouch);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /**
   * A send whose outcome we could not confirm.
   *
   * The route commits the queued interaction row BEFORE it finishes its own
   * work, and there is no idempotency key on it, so a thrown error or a lost
   * response can leave a message that the VPS consumer still delivers. Clearing
   * `sending` and re-enabling the button turns that into a second identical
   * email to the business owner at one click.
   *
   * Both reviewers landed on this independently (Codex, then CodeRabbit rating
   * it Major). The real fix is a route-enforced idempotency key — a change to a
   * shared endpoint that other surfaces post to, so it belongs in its own PR.
   * Until then the retry is BLOCKED rather than merely discouraged: the rep has
   * to say out loud that they checked. A warning sentence beside a live button
   * is not a control.
   */
  const [unconfirmed, setUnconfirmed] = useState(false);

  // Regenerate from the LIVE form state until the rep edits the draft; after
  // that their words win and nothing overwrites them.
  const generated = useMemo(
    () => buildDraft(template, lead, effectiveBookingUrl),
    [template, lead, effectiveBookingUrl],
  );
  const subject = draft?.subject ?? generated.subject;
  const body = draft?.body ?? generated.body;

  const toValid = EMAIL_RE.test(to.trim());
  const isNewAddress = to.trim().toLowerCase() !== (lead.email || "").trim().toLowerCase();

  async function send() {
    setSending(true);
    setStatus(null);
    const recipient = to.trim();
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ to_email: recipient, subject, body }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: string;
        send_status?: { status?: string };
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.message || json.error || `send_${res.status}`);
      }

      // The send route already recorded the canonical touch (record_lead_touch),
      // which is what the header's LAST TOUCH and the staleness SLA read. Nothing
      // to do here for that — it is why this posts to that route rather than
      // rolling its own send.
      const sent = json.send_status?.status === "sent";
      let note = sent ? "Sent." : "Queued to send.";

      // Persist anything the rep changed, AFTER a successful send. Writing a
      // typo'd address onto the lead because the send failed would overwrite a
      // good record with a bad one.
      const patch: Record<string, unknown> = {};
      if (isNewAddress && recipient) patch.email = recipient;
      if (scheduleNext && nextAt) patch.next_action_at = new Date(nextAt).toISOString();
      if (Object.keys(patch).length) {
        try {
          const pr = await fetch(
            `/api/manifest/${encodeURIComponent(tenantSlug)}/records/lead?id=${encodeURIComponent(leadId)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ patch }),
            },
          );
          const pj = (await pr.json().catch(() => ({}))) as { ok?: boolean };
          if (pr.ok && pj.ok) {
            if (patch.email) note += " Address saved to the lead.";
            if (patch.next_action_at) {
              note += ` Next touch set for ${new Date(nextAt).toLocaleDateString(undefined, {
                weekday: "short", month: "short", day: "numeric",
              })}.`;
            }
          } else {
            // Best-effort: a failed follow-up write must never read as a failed
            // send. The email is gone either way and the rep needs to know that.
            note += " (Couldn't save the follow-up details — set them above.)";
          }
        } catch {
          note += " (Couldn't save the follow-up details — set them above.)";
        }
      }

      setStatus(note);
      setDraft(null);
      router.refresh();
    } catch (err) {
      // NOT "Send failed." The route durably inserts the queued interaction row
      // BEFORE it finishes its own work, so a later throw — or a response lost
      // on the way back — reaches us here having already committed a send that
      // the VPS consumer will drain. Telling the rep it failed is what produces
      // the duplicate: they press the button again and the owner gets two
      // identical emails. Say what we actually know, and point at the record
      // that settles it. Codex flagged this on review; a real fix is an
      // idempotency key on the route, which is a change to a shared endpoint
      // and belongs in its own PR.
      const detail = err instanceof Error ? err.message : "unknown error";
      setUnconfirmed(true);
      setStatus(
        `Couldn't confirm the send (${detail}). It may already have been queued and ` +
          "may still go out. Check the timeline below: if nothing was sent, use " +
          "“Send anyway”.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="rounded-xl border border-bg-border bg-bg-elev/25">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-accent" aria-hidden />
          <span className="text-sm font-semibold text-fg">Send a quick email</span>
          <span className="text-xs text-fg-muted">
            Built from the details above. Records the touch.
          </span>
        </span>
        <span className="text-xs text-fg-dim">{open ? "Hide" : "Open"}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-bg-border p-4">
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                title={t.hint}
                onClick={() => {
                  setTemplate(t.id);
                  setDraft(null);
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                  template === t.id
                    ? "border-accent/70 bg-accent/10 text-fg"
                    : "border-bg-border text-fg-muted hover:text-fg"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <label className="block text-xs text-fg-muted">
            To
            <input
              type="email"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setTouched(true);
              }}
              placeholder="name@company.com"
              aria-invalid={touched && to.trim().length > 0 && !toValid}
              className={`${INPUT} mt-1.5`}
            />
            {touched && to.trim().length > 0 && !toValid && (
              <span className="mt-1 block text-[11px] text-red-400">
                That address doesn&apos;t look right — check for a typo.
              </span>
            )}
            {toValid && isNewAddress && (
              <span className="mt-1 block text-[11px] text-fg-dim">
                {lead.email
                  ? "Different from the address on file — it'll be saved to this lead after it sends."
                  : "New address — it'll be saved to this lead so the next person isn't stuck."}
              </span>
            )}
            {!lead.email && !to.trim() && (
              <span className="mt-1 block text-[11px] text-fg-dim">
                No address on this lead yet. Type the one they gave you on the call.
              </span>
            )}
          </label>

          <label className="block text-xs text-fg-muted">
            Subject
            <input
              value={subject}
              onChange={(e) => setDraft({ subject: e.target.value, body })}
              className={`${INPUT} mt-1.5`}
            />
          </label>

          <label className="block text-xs text-fg-muted">
            Message
            <textarea
              value={body}
              onChange={(e) => setDraft({ subject, body: e.target.value })}
              rows={14}
              className={`${INPUT} mt-1.5 font-sans leading-relaxed`}
            />
            <span className="mt-1 block text-[11px] text-fg-dim">
              Your signature and the OASIS footer are added automatically when it sends.
            </span>
          </label>

          {hasBookedMeeting && (
            <p className="rounded-lg border border-bg-border bg-bg-deep/60 px-3 py-2 text-[11px] text-fg-dim">
              A meeting is already booked with this lead, so the self-scheduling link is left out
              — sending one now would let them book a second, conflicting time.
            </p>
          )}

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-bg-border pt-3">
            <label className="text-xs text-fg-muted">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={scheduleNext}
                  onChange={(e) => setScheduleNext(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                <CalendarClock className="h-3.5 w-3.5" aria-hidden />
                Set the next follow-up
              </span>
              <input
                type="datetime-local"
                value={nextAt}
                disabled={!scheduleNext}
                onChange={(e) => setNextAt(e.target.value)}
                className={`${INPUT} mt-1.5 disabled:opacity-40`}
              />
            </label>

            {unconfirmed ? (
              // The retry is a SECOND, deliberate action. See `unconfirmed`.
              <button
                type="button"
                onClick={() => {
                  setUnconfirmed(false);
                  setStatus(null);
                }}
                className="btn-secondary inline-flex items-center gap-2 !px-4 !py-2 text-xs"
              >
                <Send className="h-3.5 w-3.5" aria-hidden />
                Send anyway
              </button>
            ) : (
              <button
                type="button"
                disabled={sending || !toValid || !subject.trim() || !body.trim()}
                onClick={send}
                className="btn-primary inline-flex items-center gap-2 !px-4 !py-2 text-xs disabled:opacity-40"
              >
                <Send className="h-3.5 w-3.5" aria-hidden />
                {sending ? "Sending…" : "Send email"}
              </button>
            )}
          </div>

          {status && <p className="text-xs text-fg-muted">{status}</p>}
        </div>
      )}
    </section>
  );
}
