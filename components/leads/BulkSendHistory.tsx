"use client";

/**
 * BulkSendHistory — "Recent sends": the durable receipt for bulk email.
 *
 * Before this (Adon, 2026-08-20) the bulk path kept no operator-visible record
 * at all. The only feedback was a transient line that a router refresh wiped,
 * so the question "did that batch actually go out?" had no answer inside the
 * product. That is why a working pipeline was reported as broken: the operator
 * had nothing to check, and absence of evidence read as evidence of absence.
 *
 * Reads GET /api/leads/bulk/batches, which is tenant-scoped and shows a
 * non-admin only their own sends.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  History,
  Loader2,
  X,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  PencilLine,
} from "lucide-react";

type Counts = {
  queued: number;
  sending: number;
  sent: number;
  failed: number;
  suppressed: number;
  expired: number;
};

type Batch = {
  batch_id: string;
  subject: string;
  custom_message: boolean;
  template_id: string | null;
  requested_by_email: string | null;
  entity_type: string;
  started_at: string | null;
  last_activity_at: string | null;
  total: number;
  counts: Counts;
  in_flight: boolean;
};

type Row = {
  to_email: string | null;
  status: keyof Counts;
  sent_at: string | null;
  send_error: string | null;
  needs_operator_review: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Local time, because the operator is reconciling against their own inbox. */
function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

export function BulkSendHistory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, Row[]>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/leads/bulk/batches");
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        batches?: Batch[];
        truncated?: boolean;
        error?: string;
      };
      if (!r.ok || !body.ok) {
        setError(body.error || "Couldn't load recent sends.");
        return;
      }
      setBatches(body.batches || []);
      setTruncated(body.truncated === true);
      setError(null);
    } catch (e) {
      setError((e as Error).message || "network error");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setBatches(null);
    setExpanded(null);
    void load();
  }, [open, load]);

  const toggle = useCallback(
    async (batchId: string) => {
      if (expanded === batchId) {
        setExpanded(null);
        return;
      }
      setExpanded(batchId);
      if (rows[batchId]) return;
      // Rows queued before batch tagging shipped are grouped under a synthetic
      // "legacy:<timestamp>" key, which the API rejects as a non-UUID. Show the
      // rollup we already have rather than firing a request that 400s.
      if (!UUID_RE.test(batchId)) {
        setRows((cur) => ({ ...cur, [batchId]: [] }));
        return;
      }
      try {
        const r = await fetch(`/api/leads/bulk/batches?batch_id=${encodeURIComponent(batchId)}`);
        const body = (await r.json().catch(() => ({}))) as { ok?: boolean; rows?: Row[] };
        if (body?.ok) setRows((cur) => ({ ...cur, [batchId]: body.rows || [] }));
      } catch {
        /* the row list is a detail view; the rollup above is still accurate */
      }
    },
    [expanded, rows],
  );

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div className="mt-10 w-full max-w-2xl rounded-xl border border-bg-border bg-bg-elev shadow-2xl">
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <h2 className="inline-flex items-center gap-2 text-[13px] font-semibold text-fg">
            <History className="h-4 w-4 text-accent" />
            Recent sends
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-fg-dim hover:bg-bg-deep hover:text-fg"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-4 py-3">
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!batches && !error && (
            <div className="inline-flex items-center gap-2 py-4 text-[12px] text-fg-dim">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          )}

          {truncated && (
            <p className="mb-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-100">
              Showing the most recent sends only. Older ones are past this view.
            </p>
          )}

          {batches?.length === 0 && (
            <p className="py-6 text-center text-[12px] text-fg-dim">
              No bulk emails sent yet.
            </p>
          )}

          <div className="space-y-1.5">
            {(batches || []).map((b) => {
              const isOpen = expanded === b.batch_id;
              const problems = b.counts.failed + b.counts.expired;
              return (
                <div key={b.batch_id} className="rounded-lg border border-bg-border bg-bg-deep">
                  <button
                    type="button"
                    onClick={() => toggle(b.batch_id)}
                    className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
                  >
                    {isOpen ? (
                      <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-dim" />
                    ) : (
                      <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-dim" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-semibold text-fg">{b.subject}</span>
                        {b.custom_message && (
                          <PencilLine className="h-3 w-3 shrink-0 text-fg-dim" aria-label="Written by hand" />
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-muted">
                        <span>{when(b.started_at)}</span>
                        <span className="text-fg-dim">·</span>
                        <span>
                          {b.total} {b.entity_type}
                          {b.total === 1 ? "" : "s"}
                        </span>
                        {b.requested_by_email && (
                          <>
                            <span className="text-fg-dim">·</span>
                            <span className="truncate">{b.requested_by_email}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      {b.in_flight ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-accent">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {b.counts.sent}/{b.total}
                        </span>
                      ) : problems > 0 ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-amber-300">
                          <AlertTriangle className="h-3 w-3" />
                          {b.counts.sent}/{b.total} sent
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" />
                          {b.counts.sent} sent
                        </span>
                      )}
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-bg-border px-3 py-2">
                      {!rows[b.batch_id] ? (
                        <div className="inline-flex items-center gap-2 py-1 text-[11px] text-fg-dim">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Loading recipients…
                        </div>
                      ) : (
                        <ul className="space-y-1">
                          {rows[b.batch_id].length === 0 && (
                            <li className="text-[11.5px] text-fg-dim">
                              This send predates per-recipient tracking. The totals above are
                              accurate.
                            </li>
                          )}
                          {rows[b.batch_id].map((r, i) => (
                            <li
                              key={`${r.to_email}-${i}`}
                              className="flex items-baseline justify-between gap-3 text-[11.5px]"
                            >
                              <span className="truncate text-fg-muted">{r.to_email}</span>
                              <span
                                className={`shrink-0 ${
                                  r.status === "sent"
                                    ? "text-emerald-300"
                                    : r.status === "suppressed"
                                      ? "text-amber-300"
                                      : r.status === "failed" || r.status === "expired"
                                        ? "text-red-300"
                                        : "text-fg-dim"
                                }`}
                                title={r.send_error || undefined}
                              >
                                {r.status === "sent"
                                  ? `sent ${when(r.sent_at)}`
                                  : r.status === "suppressed"
                                    ? "unsubscribed, skipped"
                                    : r.status === "expired"
                                      ? "expired unsent"
                                      : r.status === "failed"
                                        ? r.needs_operator_review
                                          ? "needs review"
                                          : "failed"
                                        : r.status}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
