"use client";

/**
 * BulkEmailDialog — the bulk-email send flow, rebuilt around what the operator
 * can SEE (Adon, 2026-08-20).
 *
 * The old flow was a bare template dropdown plus a one-line confirm. It queued
 * rows correctly and the mail genuinely went out, but the operator got a
 * transient "N queued" that a router refresh wiped, then nothing for up to five
 * minutes while a cron drained the queue. There was no history, no progress,
 * and skipped records vanished into an anonymous counter. A healthy pipeline
 * was therefore indistinguishable from a dead button, and was reported as
 * "not sending at all" for weeks.
 *
 * Three things this fixes, in the order the operator meets them:
 *   1. PREFLIGHT  — before confirming, the exact count that can be emailed and
 *      the reason the rest cannot ("57 no email address on file"). SunBiz leads
 *      are phone-first, so a batch losing most of its recipients is normal and
 *      must be stated, not hidden.
 *   2. WRITE YOUR OWN — a real compose box. Previously the only option was a
 *      library template, so anything the library didn't cover could not be sent
 *      to a batch at all.
 *   3. LIVE STATUS — the dialog stays open and polls the batch until every
 *      recipient reaches a terminal state, so "sent" is something the operator
 *      watches happen rather than something they have to take on faith.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Mail,
  Loader2,
  X,
  CheckCircle2,
  AlertTriangle,
  PencilLine,
  LayoutTemplate,
  Eye,
} from "lucide-react";
import {
  SUNBIZ_BULK_SAFE_TEMPLATES,
  SUNBIZ_TEMPLATE_CATEGORIES,
  renderSunbizTemplate,
} from "@/lib/sunbiz-templates-library";
import {
  MERGE_FIELDS,
  MAX_SUBJECT,
  MAX_BODY,
  validateCustomMessage,
  renderCustomMessage,
} from "@/lib/bulk-email/compose";

type EntityName = "lead" | "application";

type Preflight = {
  counts: {
    selected: number;
    eligible: number;
    not_found: number;
    no_access: number;
    no_email: number;
    unreadable: number;
  };
  summary: string;
  sample: Array<{ id: string; to_email: string; first_name: string; business_name: string }>;
};

type BatchStatus = {
  batch_id: string;
  total: number;
  counts: { queued: number; sending: number; sent: number; failed: number; suppressed: number; expired: number };
  in_flight: boolean;
};

type Phase = "compose" | "sending" | "done";

const POLL_MS = 2500;
/** Stop polling eventually so a wedged batch doesn't spin forever. */
const POLL_CEILING_MS = 5 * 60_000;

export function BulkEmailDialog({
  open,
  onClose,
  selectedIds,
  entityName,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  selectedIds: string[];
  entityName: EntityName;
  /** Fired once a batch reaches a terminal state, so the board can refresh. */
  onSent?: () => void;
}) {
  const [mode, setMode] = useState<"template" | "custom">("template");
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [showPreview, setShowPreview] = useState(true);

  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("compose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<BatchStatus | null>(null);
  const pollStarted = useRef(0);

  const noun = entityName === "application" ? "application" : "lead";

  // ---- preflight: run on open, and whenever the selection changes ----------
  useEffect(() => {
    if (!open || selectedIds.length === 0) return;
    let cancelled = false;
    setPreflight(null);
    setPreflightError(null);
    fetch("/api/leads/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "email_preflight", ids: selectedIds, entity: entityName }),
    })
      .then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok || !body?.ok) {
          setPreflightError(body?.message || body?.error || "Couldn't check the selection.");
          return;
        }
        setPreflight(body as Preflight);
      })
      .catch((e) => {
        if (!cancelled) setPreflightError((e as Error).message || "network error");
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedIds, entityName]);

  // Reset everything when the dialog closes so a second send never inherits
  // the first one's copy or status.
  useEffect(() => {
    if (open) return;
    setPhase("compose");
    setStatus(null);
    setError(null);
    setBusy(false);
    setPreflight(null);
  }, [open]);

  const eligible = preflight?.counts.eligible ?? 0;
  const sample = preflight?.sample?.[0];

  const activeTemplate = useMemo(
    () => SUNBIZ_BULK_SAFE_TEMPLATES.find((t) => t.id === templateId) || null,
    [templateId],
  );

  const customCheck = useMemo(
    () => (mode === "custom" ? validateCustomMessage({ subject, body: bodyText }) : null),
    [mode, subject, bodyText],
  );

  /** The exact copy one real recipient will receive, rendered by the SAME
   *  functions the server uses. A preview that can drift from the send is
   *  worse than none, because it manufactures false confidence. */
  const preview = useMemo(() => {
    const vars = {
      firstName: sample?.first_name || "",
      businessName: sample?.business_name || "",
    };
    if (mode === "template") {
      if (!activeTemplate) return null;
      return renderSunbizTemplate(activeTemplate, vars);
    }
    if (!customCheck?.ok) return null;
    return renderCustomMessage(customCheck.value, vars);
  }, [mode, activeTemplate, customCheck, sample]);

  const canSend =
    !busy &&
    eligible > 0 &&
    (mode === "template" ? !!activeTemplate : !!customCheck?.ok);

  // ---- send ---------------------------------------------------------------
  const send = useCallback(async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        op: "email",
        ids: selectedIds,
        entity: entityName,
      };
      if (mode === "template") payload.template_id = templateId;
      else payload.custom = { subject, body: bodyText };

      const r = await fetch("/api/leads/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        batch_id?: string;
        updated?: number;
        error?: string;
        message?: string;
      };
      if (!r.ok || !body.ok) {
        setError(body.message || body.error || "Couldn't queue the send.");
        setBusy(false);
        return;
      }
      if (!body.batch_id || !body.updated) {
        setError("Nothing was queued.");
        setBusy(false);
        return;
      }
      pollStarted.current = Date.now();
      setStatus({
        batch_id: body.batch_id,
        total: body.updated,
        counts: { queued: body.updated, sending: 0, sent: 0, failed: 0, suppressed: 0, expired: 0 },
        in_flight: true,
      });
      setPhase("sending");
    } catch (e) {
      setError((e as Error).message || "network error");
    } finally {
      setBusy(false);
    }
  }, [canSend, selectedIds, entityName, mode, templateId, subject, bodyText]);

  // ---- poll the batch until every recipient reaches a terminal state -------
  useEffect(() => {
    if (phase !== "sending" || !status?.batch_id) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/leads/bulk/batches?batch_id=${encodeURIComponent(status.batch_id)}`);
        const body = (await r.json().catch(() => ({}))) as { ok?: boolean; batch?: BatchStatus | null };
        if (cancelled || !body?.ok || !body.batch) return;
        setStatus(body.batch);
        if (!body.batch.in_flight) {
          setPhase("done");
          onSent?.();
        }
      } catch {
        /* transient; the next tick retries */
      }
    };
    void tick();
    const id = setInterval(() => {
      if (Date.now() - pollStarted.current > POLL_CEILING_MS) {
        setPhase("done");
        onSent?.();
        return;
      }
      void tick();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, status?.batch_id, onSent]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const sent = status?.counts.sent ?? 0;
  const failed = (status?.counts.failed ?? 0) + (status?.counts.expired ?? 0);
  const suppressed = status?.counts.suppressed ?? 0;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm">
      <div className="mt-10 w-full max-w-2xl rounded-xl border border-bg-border bg-bg-elev shadow-2xl">
        {/* header */}
        <div className="flex items-center justify-between border-b border-bg-border px-4 py-3">
          <h2 className="inline-flex items-center gap-2 text-[13px] font-semibold text-fg">
            <Mail className="h-4 w-4 text-accent" />
            Email {selectedIds.length} selected {noun}
            {selectedIds.length === 1 ? "" : "s"}
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

        <div className="space-y-4 px-4 py-4">
          {/* ---------- preflight ---------- */}
          {phase === "compose" && (
            <PreflightBanner
              preflight={preflight}
              error={preflightError}
              noun={noun}
            />
          )}

          {/* ---------- compose ---------- */}
          {phase === "compose" && (
            <>
              <div className="flex items-center gap-1 rounded-lg border border-bg-border bg-bg-deep p-1">
                <ModeTab
                  active={mode === "template"}
                  onClick={() => setMode("template")}
                  icon={<LayoutTemplate className="h-3.5 w-3.5" />}
                  label="Use a template"
                />
                <ModeTab
                  active={mode === "custom"}
                  onClick={() => setMode("custom")}
                  icon={<PencilLine className="h-3.5 w-3.5" />}
                  label="Write your own"
                />
              </div>

              {mode === "template" ? (
                <label className="block space-y-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                    Template
                  </span>
                  <select
                    value={templateId}
                    onChange={(e) => setTemplateId(e.target.value)}
                    className="w-full rounded-md border border-bg-border bg-bg-deep px-2.5 py-2 text-[13px] text-fg focus:border-accent focus:outline-none"
                  >
                    <option value="">Pick a template…</option>
                    {SUNBIZ_TEMPLATE_CATEGORIES.map((cat) => {
                      const items = SUNBIZ_BULK_SAFE_TEMPLATES.filter((t) => t.category === cat.category);
                      if (items.length === 0) return null;
                      return (
                        <optgroup key={cat.category} label={cat.label}>
                          {items.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.label}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                  <span className="block text-[11px] text-fg-dim">
                    Only outreach-safe templates appear here. Stage-specific ones (offers, funded,
                    renewals) are one-to-one only, so a batch can never make a claim that isn&apos;t
                    true for every {noun} in it.
                  </span>
                </label>
              ) : (
                <CustomComposer
                  subject={subject}
                  bodyText={bodyText}
                  onSubject={setSubject}
                  onBody={setBodyText}
                  problem={customCheck && !customCheck.ok ? customCheck.message : null}
                />
              )}

              {/* ---------- preview ---------- */}
              <div className="rounded-lg border border-bg-border bg-bg-deep">
                <button
                  type="button"
                  onClick={() => setShowPreview((v) => !v)}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted hover:text-fg"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Preview
                  {sample && (
                    <span className="ml-auto font-normal normal-case tracking-normal text-fg-dim">
                      as {sample.to_email} will receive it
                    </span>
                  )}
                </button>
                {showPreview && (
                  <div className="border-t border-bg-border px-3 py-2.5">
                    {preview ? (
                      <>
                        <div className="text-[12px] font-semibold text-fg">{preview.subject}</div>
                        <pre className="mt-1.5 max-h-56 overflow-y-auto whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-fg-muted">
                          {preview.body}
                        </pre>
                        <div className="mt-2 border-t border-bg-border pt-2 text-[10.5px] text-fg-dim">
                          A legal footer and a one-click unsubscribe link are added automatically at
                          send time.
                        </div>
                      </>
                    ) : (
                      <div className="py-2 text-[12px] text-fg-dim">
                        {mode === "template"
                          ? "Pick a template to see exactly what goes out."
                          : "Write a subject and message to see exactly what goes out."}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ---------- live status ---------- */}
          {phase !== "compose" && status && (
            <SendProgress
              status={status}
              phase={phase}
              sent={sent}
              failed={failed}
              suppressed={suppressed}
              noun={noun}
            />
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 border-t border-bg-border px-4 py-3">
          {phase === "compose" ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-[12px] text-fg-dim hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSend}
                onClick={send}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-deep hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {eligible > 0
                  ? `Send to ${eligible} ${noun}${eligible === 1 ? "" : "s"}`
                  : "Nothing to send"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg-deep hover:bg-accent/90"
            >
              {phase === "done" ? "Done" : "Close (keeps sending)"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors ${
        active ? "bg-accent/15 text-accent" : "text-fg-muted hover:text-fg"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * The count an operator sees BEFORE confirming, with the reason for every
 * record that will not receive the email. This is the single most important
 * element in the dialog: "3 queued" out of a 60-lead selection reads as a
 * broken button, while "57 have no email address on file" is a data problem
 * the operator can act on.
 */
function PreflightBanner({
  preflight,
  error,
  noun,
}: {
  preflight: Preflight | null;
  error: string | null;
  noun: string;
}) {
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }
  if (!preflight) {
    return (
      <div className="inline-flex items-center gap-2 rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-[12px] text-fg-dim">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking which {noun}s can be emailed…
      </div>
    );
  }

  const { counts } = preflight;
  const allBlocked = counts.eligible === 0;
  const someBlocked = counts.selected - counts.eligible > 0;

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 text-[12px] ${
        allBlocked
          ? "border-red-400/40 bg-red-500/10 text-red-200"
          : someBlocked
            ? "border-amber-400/40 bg-amber-500/10 text-amber-100"
            : "border-emerald-400/40 bg-emerald-500/10 text-emerald-100"
      }`}
    >
      <div className="flex items-start gap-2">
        {allBlocked || someBlocked ? (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <div className="space-y-1">
          <div className="font-semibold">{preflight.summary}</div>
          {counts.no_email > 0 && (
            <div className="opacity-90">
              {counts.no_email} of them {counts.no_email === 1 ? "has" : "have"} a phone number but
              no email address, so {counts.no_email === 1 ? "it" : "they"} cannot be emailed. Text
              {counts.no_email === 1 ? " it" : " them"} instead, or add an address to the record.
            </div>
          )}
          {counts.unreadable > 0 && (
            <div className="opacity-90">
              {counts.unreadable} could not be read just now. Those are left alone, not sent to.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CustomComposer({
  subject,
  bodyText,
  onSubject,
  onBody,
  problem,
}: {
  subject: string;
  bodyText: string;
  onSubject: (v: string) => void;
  onBody: (v: string) => void;
  problem: string | null;
}) {
  const insert = (token: string) => onBody(`${bodyText}${bodyText.endsWith(" ") || !bodyText ? "" : " "}${token}`);
  return (
    <div className="space-y-3">
      <label className="block space-y-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          Subject
        </span>
        <input
          value={subject}
          onChange={(e) => onSubject(e.target.value)}
          maxLength={MAX_SUBJECT + 50}
          placeholder="Quick question about {{business_name}}"
          className="w-full rounded-md border border-bg-border bg-bg-deep px-2.5 py-2 text-[13px] text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none"
        />
      </label>

      <label className="block space-y-1.5">
        <span className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          Message
          <span className="font-normal normal-case tracking-normal text-fg-dim">
            {bodyText.length}/{MAX_BODY}
          </span>
        </span>
        <textarea
          value={bodyText}
          onChange={(e) => onBody(e.target.value)}
          rows={8}
          placeholder={"Hi {{first_name}},\n\n…"}
          className="w-full resize-y rounded-md border border-bg-border bg-bg-deep px-2.5 py-2 text-[13px] leading-relaxed text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none"
        />
      </label>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-fg-dim">Insert:</span>
        {MERGE_FIELDS.map((f) => (
          <button
            key={f.token}
            type="button"
            onClick={() => insert(f.token)}
            title={`Fills in each recipient's ${f.label.toLowerCase()} (example: ${f.sample})`}
            className="rounded-md border border-bg-border bg-bg-deep px-2 py-0.5 text-[11px] text-fg-muted hover:border-accent/50 hover:text-fg"
          >
            {f.label}
          </button>
        ))}
      </div>

      {problem && (
        <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] text-amber-100">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{problem}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Live send progress. The whole point is that "sent" is observed, not assumed:
 * the operator watches the counter move instead of clicking into silence and
 * being asked to trust that a cron will run.
 */
function SendProgress({
  status,
  phase,
  sent,
  failed,
  suppressed,
  noun,
}: {
  status: BatchStatus;
  phase: Phase;
  sent: number;
  failed: number;
  suppressed: number;
  noun: string;
}) {
  const done = phase === "done";
  const pct = status.total > 0 ? Math.round(((sent + failed + suppressed) / status.total) * 100) : 0;
  return (
    <div className="space-y-2.5 rounded-lg border border-bg-border bg-bg-deep px-3 py-3">
      <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
        {done ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        )}
        {done
          ? `${sent} of ${status.total} sent`
          : `Sending… ${sent} of ${status.total} ${noun}${status.total === 1 ? "" : "s"}`}
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-elev">
        <div
          className={`h-full rounded-full transition-all duration-500 ${done ? "bg-emerald-400" : "bg-accent"}`}
          style={{ width: `${Math.max(pct, 4)}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-fg-muted">
        <span className="text-emerald-300">{sent} sent</span>
        {suppressed > 0 && <span className="text-amber-300">{suppressed} unsubscribed, skipped</span>}
        {failed > 0 && <span className="text-red-300">{failed} failed</span>}
        {status.counts.queued + status.counts.sending > 0 && (
          <span>{status.counts.queued + status.counts.sending} still going</span>
        )}
      </div>

      {!done && (
        <p className="text-[11px] text-fg-dim">
          You can close this. The send keeps running, and you can check it any time under Recent
          sends.
        </p>
      )}
      {done && failed > 0 && (
        <p className="text-[11px] text-fg-dim">
          Open Recent sends to see which addresses failed.
        </p>
      )}
    </div>
  );
}
