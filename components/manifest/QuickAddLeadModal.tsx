"use client";

/**
 * QuickAddLeadModal — 3-field quick-add for the SunBiz lead board. Lets a rep
 * manually log a merchant they already sent an application to (via TextTorrent
 * or email) straight into a pipeline stage (default "Sent Application"), so the
 * deal enters the funnel + follow-up. POSTs to /api/leads/quick-add, which
 * create-or-advances (deduped) and is rep-accessible (canWriteCrm). On success
 * it router.refresh()es so the lead appears in its section.
 */

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";

/** Operator-facing copy per send outcome. Deliberately never says "sent"
 *  unless the server verified a send. */
const EMAIL_STATUS_COPY: Record<string, string> = {
  sent: "Application emailed.",
  queued: "Lead saved. The application email is queued.",
  disabled: "Lead saved. Instant send is off, so the drip will pick it up.",
  duplicate: "Already queued or emailed. Not sending it again.",
  failed: "Lead saved, but the application email failed to send.",
  skipped_no_email: "Lead saved. No email address on file, so nothing was sent.",
  skipped_suppressed: "Lead saved. That address is unsubscribed, so nothing was sent.",
  skipped_paused: "Lead saved. Drips are paused for this lead, so nothing was sent.",
  skipped_other: "Lead saved. The application email was skipped. Check the lead's drip log.",
  held_circuit_open: "Lead saved. Sending is halted right now, so nothing was sent.",
  held_no_app_link: "Lead saved. No application link could be created, so nothing was sent.",
  held_blocked_by_guard: "Lead saved. The compliance guard blocked this email, so nothing was sent.",
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Pipeline stage key to add at. Default "sent_application". */
  stage?: string;
  /** Display label for the stage. */
  stageLabel?: string;
};

export function QuickAddLeadModal({
  open,
  onClose,
  stage = "sent_application",
  stageLabel = "Sent Application",
}: Props) {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  function reset() {
    setBusinessName("");
    setContactName("");
    setPhone("");
    setEmail("");
    setError(null);
  }
  function close() {
    if (pending) return;
    reset();
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const name = businessName.trim();
    if (!name) {
      setError("Business name is required.");
      return;
    }
    if (!phone.trim() && !email.trim()) {
      setError("Add a phone or email so the lead can be reached.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/leads/quick-add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business_name: name,
          contact_name: contactName.trim(),
          phone: phone.trim(),
          email: email.trim(),
          stage,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; message?: string;
        existing?: boolean; advanced?: boolean;
        email?: { status?: string; reason?: string; to?: string };
      };
      if (!res.ok || !json.ok) {
        setError(json.message || json.error || `Couldn't add lead (${res.status}).`);
        return;
      }
      // Surface the real application-email outcome instead of closing silently.
      // `status` is undefined whenever the server omitted `email` (no instant
      // send ran for this stage) — show no email note at all in that case,
      // rather than falling back to a fake "queued".
      const status = json.email?.status;
      const to = json.email?.to;
      // A verified send with a known recipient names it: this is the one and
      // only place the operator sees which address the mail went to, so a
      // stale address on a phone-matched lead (never overwritten by policy) is
      // visible instead of silently invisible under a truthful-but-vague
      // "Application emailed." Without a recipient, fall back to the plain copy.
      const note = status
        ? status === "sent"
          ? to ? `Application emailed to ${to}.` : EMAIL_STATUS_COPY.sent
          : EMAIL_STATUS_COPY[status] || "Lead saved."
        : "";
      if (json.existing) {
        const merge = json.advanced
          ? `That merchant already had a lead, moved it to ${stageLabel}.`
          : `That merchant is already at ${stageLabel}.`;
        alert(note ? `${merge}\n\n${note}` : merge);
      } else if (status && (status !== "sent" || to)) {
        // Suppressed only for a NEW lead with a verified send but no known
        // recipient (unchanged prior behavior). A 'sent' WITH a recipient is
        // shown even for a new lead — seeing the address once is the point.
        alert(note);
      }
      reset();
      onClose();
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={close}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-bg-border bg-bg-deep p-5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-bold text-fg">Add lead to {stageLabel}</h2>
          <button type="button" onClick={close} className="text-fg-dim hover:text-fg" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-[11px] leading-relaxed text-fg-dim">
          For a merchant you already sent an application to (TextTorrent or email). Adds them at {stageLabel}
          {" "}so they enter the follow-up.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-fg-dim">
              Business name *
            </span>
            <input
              autoFocus
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="ACME Trucking LLC"
              className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-fg-dim">
              Contact name
            </span>
            <input
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Merchant / owner name"
              className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-fg-dim">Phone</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 123-4567"
              inputMode="tel"
              className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-fg-dim">Email</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@business.com"
              inputMode="email"
              className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg"
            />
          </label>
          {error && <div className="text-[11px] text-rose-400">{error}</div>}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={close}
              disabled={pending}
              className="rounded-md border border-bg-border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-muted hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-bg-deep hover:bg-accent/90 disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Add lead
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
