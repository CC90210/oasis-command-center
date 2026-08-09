"use client";

/**
 * CallSheet — the right pane of the Calls tab. Everything a rep needs to run
 * one scheduled call: the lead's header info, the pre-call note, the MCA/
 * underwriting summary, and the FULL notes history — then the actions to
 * place the call, log a note taken during the call, log the outcome,
 * reschedule, or cancel.
 *
 * Deliberately reuses existing endpoints rather than inventing new ones:
 *   - /api/leads/[id]/detail  — lead header + record.data (MCAProfilePanel
 *     reads straight off record.data, same shape as the pipeline detail page).
 *   - /api/leads/[id]/notes   — GET/POST. A note added here lands in the same
 *     lead_interactions feed the lead drawer's Notes tab reads, so it shows
 *     up in both places automatically.
 *   - /api/leads/[id]/call    — POST. Same Kixie alley-oop call the lead
 *     drawer's "Call" button uses.
 *   - /api/call-appointments/[id] — PATCH. Outcome / reschedule / cancel.
 */

import { useCallback, useEffect, useState } from "react";
import { Phone, Loader2, CalendarClock, Ban, Check, XCircle, ExternalLink } from "lucide-react";
import { MCAProfilePanel } from "@/components/leads/MCAProfilePanel";
import { ClairReportPanel } from "@/components/leads/ClairReportPanel";
import { clairEnabledForTenantSlug } from "@/lib/clair/tenant-access";
import type { DetailPayload } from "@/components/leads/LeadFileBody";

export type AppointmentRow = {
  id: string;
  lead_id: string;
  entity_type: string;
  scheduled_for: string;
  assigned_to: string | null;
  status: "scheduled" | "completed" | "no_answer" | "cancelled" | "rescheduled";
  pre_call_note: string | null;
  outcome_note: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  lead: {
    business_name: string | null;
    contact_name: string | null;
    phone: string | null;
    stage: string | null;
  } | null;
};

type NoteRow = {
  id: string;
  content_preview: string | null;
  agent_source: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function fmtWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function CallSheet({
  appointment,
  tenantSlug,
  onChanged,
}: {
  appointment: AppointmentRow;
  tenantSlug: string;
  onChanged: () => void | Promise<void>;
}) {
  const entity = appointment.entity_type === "application" ? "application" : "lead";
  const entityQ = entity === "application" ? "?entity=application" : "";

  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteRow[] | null>(null);

  const loadDetail = useCallback(async () => {
    setDetailError(null);
    try {
      const r = await fetch(`/api/leads/${appointment.lead_id}/detail${entityQ}`, {
        credentials: "include",
        cache: "no-store",
      });
      const j = await r.json();
      if (!j.ok) {
        setDetailError(j.error || "load_failed");
        return;
      }
      setDetail(j as DetailPayload);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "network_error");
    }
  }, [appointment.lead_id, entityQ]);

  const loadNotes = useCallback(async () => {
    try {
      const r = await fetch(`/api/leads/${appointment.lead_id}/notes${entityQ}`, { credentials: "include" });
      const j = await r.json();
      setNotes(j.ok ? (j.notes as NoteRow[]) : []);
    } catch {
      setNotes([]);
    }
  }, [appointment.lead_id, entityQ]);

  useEffect(() => {
    setDetail(null);
    setNotes(null);
    void loadDetail();
    void loadNotes();
  }, [loadDetail, loadNotes]);

  const record = detail?.record;
  const data = (record?.data || {}) as Record<string, unknown>;
  const businessName =
    str(data.business_name) || str(data.name) || appointment.lead?.business_name || "Lead";
  const contactName = str(data.contact_name) || appointment.lead?.contact_name || null;
  const phone = str(data.phone) || appointment.lead?.phone || null;
  const email = str(data.email);
  const stage =
    str(data[entity === "application" ? "status" : "stage"]) || appointment.lead?.stage || null;
  const leadHref = `/t/${tenantSlug}/${entity === "application" ? "applications" : "leads"}?${entity}=${appointment.lead_id}`;

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <div className="shrink-0 border-b border-bg-border px-5 py-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-dim/80">
            {entity === "application" ? "Application" : "Merchant"} · Call sheet
          </div>
          <a
            href={leadHref}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-violet-300 hover:underline"
          >
            Open lead <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <h2 className="truncate text-lg font-bold text-fg">{businessName}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg-muted">
          {contactName ? <span>{contactName}</span> : null}
          {phone ? (
            <a href={`tel:${phone}`} className="font-mono text-violet-300 hover:underline">
              {phone}
            </a>
          ) : null}
          {email ? <span className="truncate">{email}</span> : null}
          {stage ? (
            <span className="rounded-full bg-bg-elev px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-fg-muted">
              {stage}
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 text-[11px] text-fg-dim">
          Scheduled for {fmtWhen(appointment.scheduled_for)}
        </div>
      </div>

      {/* scrolling body */}
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {detailError ? <div className="text-[12px] text-red-300">{detailError}</div> : null}

        {appointment.pre_call_note ? (
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-violet-300">
              Pre-call note
            </div>
            <div className="whitespace-pre-wrap text-[13px] text-fg">{appointment.pre_call_note}</div>
          </div>
        ) : null}

        {appointment.outcome_note ? (
          <div className="rounded-lg border border-bg-border bg-bg-elev/50 px-3 py-2.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-dim">
              Last outcome note
            </div>
            <div className="whitespace-pre-wrap text-[13px] text-fg">{appointment.outcome_note}</div>
          </div>
        ) : null}

        {record ? <MCAProfilePanel data={record.data} /> : null}
        {record && clairEnabledForTenantSlug(tenantSlug) ? (
          <ClairReportPanel leadId={record.id} leadData={record.data} />
        ) : null}

        <NotesSection leadId={appointment.lead_id} entityQ={entityQ} notes={notes} onAdded={loadNotes} />
      </div>

      <CallSheetActions appointment={appointment} phone={phone} onChanged={onChanged} />
    </div>
  );
}

function NotesSection({
  leadId,
  entityQ,
  notes,
  onAdded,
}: {
  leadId: string;
  entityQ: string;
  notes: NoteRow[] | null;
  onAdded: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!draft.trim()) return;
    setPending(true);
    setError(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/notes${entityQ}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: draft }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `failed_${r.status}`);
        return;
      }
      setDraft("");
      await onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "network_error");
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-fg-dim">
        Notes {notes ? `(${notes.length})` : ""}
      </div>
      <div className="space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Note taken on this call…"
          rows={2}
          maxLength={4000}
          className="w-full resize-none rounded-md border border-bg-border bg-bg-deep px-2 py-1.5 text-xs text-fg"
        />
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-fg-dim">
            {error ? <span className="text-red-400">{error}</span> : `${draft.length}/4000`}
          </div>
          <button
            type="button"
            disabled={pending || !draft.trim()}
            onClick={save}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-deep disabled:opacity-50"
          >
            {pending ? "Saving…" : "Add note"}
          </button>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {notes === null ? (
          <div className="text-xs italic text-fg-dim">Loading…</div>
        ) : notes.length === 0 ? (
          <div className="py-2 text-center text-xs italic text-fg-dim">No notes on this lead yet.</div>
        ) : (
          notes.map((n) => {
            const author =
              n.metadata && typeof n.metadata === "object"
                ? (n.metadata as Record<string, unknown>).author_email
                : null;
            return (
              <div key={n.id} className="rounded-md border border-bg-border bg-bg-deep/60 p-2.5">
                <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">
                  {n.content_preview}
                </div>
                <div className="mt-1.5 text-[10.5px] text-fg-dim">
                  {typeof author === "string" ? `${author} · ` : ""}
                  {new Date(n.created_at).toLocaleString()}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function CallSheetActions({
  appointment,
  phone,
  onChanged,
}: {
  appointment: AppointmentRow;
  phone: string | null;
  onChanged: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [outcomeMode, setOutcomeMode] = useState<"completed" | "no_answer" | null>(null);
  const [outcomeNote, setOutcomeNote] = useState("");
  const [rescheduleMode, setRescheduleMode] = useState(false);
  const [rescheduleAt, setRescheduleAt] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const resolved = appointment.status === "completed" || appointment.status === "cancelled";

  async function callNow() {
    setBusy("call");
    setError(null);
    setFlash(null);
    try {
      const r = await fetch(`/api/leads/${appointment.lead_id}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (!r.ok || !j.ok) {
        setError(j.message || j.error || `call_failed_${r.status}`);
        return;
      }
      setFlash(j.message || "Calling…");
      setTimeout(() => setFlash(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "call_failed");
    } finally {
      setBusy(null);
    }
  }

  async function patch(body: Record<string, unknown>) {
    setBusy("patch");
    setError(null);
    try {
      const r = await fetch(`/api/call-appointments/${appointment.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.message || j.error || `update_failed_${r.status}`);
        return false;
      }
      await onChanged();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "network_error");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function submitOutcome() {
    if (!outcomeMode) return;
    const ok = await patch({ status: outcomeMode, outcomeNote: outcomeNote.trim() || undefined });
    if (ok) {
      setOutcomeMode(null);
      setOutcomeNote("");
    }
  }

  async function submitReschedule() {
    if (!rescheduleAt) return;
    const d = new Date(rescheduleAt);
    if (Number.isNaN(d.getTime())) {
      setError("Pick a valid time.");
      return;
    }
    const ok = await patch({ scheduledFor: d.toISOString() });
    if (ok) {
      setRescheduleMode(false);
      setRescheduleAt("");
    }
  }

  async function submitCancel() {
    const ok = await patch({ status: "cancelled" });
    if (ok) setConfirmCancel(false);
  }

  return (
    <div className="shrink-0 space-y-2 border-t border-bg-border bg-bg-elev/40 p-3">
      {error ? <div className="text-[11.5px] text-red-300">{error}</div> : null}
      {flash ? <div className="text-[11.5px] text-emerald-300">{flash}</div> : null}

      {outcomeMode ? (
        <div className="space-y-2 rounded-lg border border-bg-border bg-bg-panel p-2.5">
          <div className="text-[11px] font-semibold text-fg">
            Log outcome — {outcomeMode === "completed" ? "Completed" : "No answer"}
          </div>
          <textarea
            value={outcomeNote}
            onChange={(e) => setOutcomeNote(e.target.value)}
            placeholder="What happened on the call? (optional)"
            rows={2}
            maxLength={4000}
            className="w-full resize-none rounded-md border border-bg-border bg-bg-deep px-2 py-1.5 text-xs text-fg"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOutcomeMode(null);
                setOutcomeNote("");
              }}
              className="rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold text-fg-muted hover:bg-bg-elev"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy === "patch"}
              onClick={() => void submitOutcome()}
              className="rounded-md bg-violet-600 px-3 py-1.5 text-[11.5px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              Save outcome
            </button>
          </div>
        </div>
      ) : null}

      {rescheduleMode ? (
        <div className="space-y-2 rounded-lg border border-bg-border bg-bg-panel p-2.5">
          <div className="text-[11px] font-semibold text-fg">Reschedule</div>
          <input
            type="datetime-local"
            value={rescheduleAt}
            onChange={(e) => setRescheduleAt(e.target.value)}
            className="w-full rounded-md border border-bg-border bg-bg-deep px-2 py-1.5 text-xs text-fg"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRescheduleMode(false)}
              className="rounded-md px-2.5 py-1.5 text-[11.5px] font-semibold text-fg-muted hover:bg-bg-elev"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy === "patch" || !rescheduleAt}
              onClick={() => void submitReschedule()}
              className="rounded-md bg-violet-600 px-3 py-1.5 text-[11.5px] font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              Save time
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-stretch gap-2">
        <button
          type="button"
          onClick={() => void callNow()}
          disabled={busy === "call" || !phone}
          title={phone ? `Call ${phone}` : "No phone on this record"}
          className="inline-flex flex-1 min-w-[110px] items-center justify-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-[12px] font-semibold text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
        >
          {busy === "call" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Phone className="h-3.5 w-3.5" />}
          Call now
        </button>
        <button
          type="button"
          onClick={() => {
            setOutcomeMode("completed");
            setRescheduleMode(false);
          }}
          disabled={resolved}
          className="inline-flex flex-1 min-w-[110px] items-center justify-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-[12px] font-semibold text-fg hover:bg-bg-elev/80 disabled:opacity-50"
        >
          <Check className="h-3.5 w-3.5" /> Completed
        </button>
        <button
          type="button"
          onClick={() => {
            setOutcomeMode("no_answer");
            setRescheduleMode(false);
          }}
          disabled={resolved}
          className="inline-flex flex-1 min-w-[110px] items-center justify-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-[12px] font-semibold text-fg hover:bg-bg-elev/80 disabled:opacity-50"
        >
          <XCircle className="h-3.5 w-3.5" /> No answer
        </button>
        <button
          type="button"
          onClick={() => {
            setRescheduleMode((s) => !s);
            setOutcomeMode(null);
          }}
          disabled={appointment.status === "cancelled"}
          className="inline-flex flex-1 min-w-[110px] items-center justify-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-[12px] font-semibold text-fg hover:bg-bg-elev/80 disabled:opacity-50"
        >
          <CalendarClock className="h-3.5 w-3.5" /> Reschedule
        </button>
        {confirmCancel ? (
          <button
            type="button"
            onClick={() => void submitCancel()}
            disabled={busy === "patch"}
            className="inline-flex flex-1 min-w-[110px] items-center justify-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/15 px-3 py-2 text-[12px] font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-50"
          >
            Confirm cancel?
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmCancel(true)}
            disabled={appointment.status === "cancelled"}
            className="inline-flex flex-1 min-w-[110px] items-center justify-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-[12px] font-semibold text-fg-muted hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
          >
            <Ban className="h-3.5 w-3.5" /> Cancel
          </button>
        )}
      </div>
    </div>
  );
}
