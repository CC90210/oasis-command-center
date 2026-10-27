"use client";

/**
 * ApprovalCard — one proposed outward action, and the only three things a
 * person does with it: Approve · Send back (a note is required) · Comment.
 * Design doc 01 §(c) "Feed and approvals": the same card renders in the Feed,
 * on Today (Needs you) and in each department's Overview panel.
 *
 * WHAT IT SHOWS. The requesting department, the kind of action, the revision
 * ("v2" after a send-back), when it was asked for, and a FULL preview of what
 * will go out (for an email: To, Cc, Subject and the whole body). Nothing is
 * summarised away before someone approves it.
 *
 * AFTER APPROVE IT SHOWS THE REAL RESULT. The approve call returns the row as
 * the executor left it, and the card renders that — "Sent ✓ 10:42 AM",
 * "Dry run ✓ — nothing was sent", "Queued to publish ✓", "Failed: the
 * recipient has opted out". It never shows success it was not told about
 * (components/os/approvals/outcome.ts).
 *
 * The approve call carries the payload_hash the card was rendered with, so a
 * stale card cannot approve words that changed underneath it (409 from the
 * server, shown here as a sentence).
 *
 * Visual rules: hairline border, no gradients or glows, accent only on the one
 * primary action.
 */

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { formatOperatorDate, operatorDateKey } from "@/lib/dates";
import { AI_ENGINE_LABELS } from "@/lib/ai-audit/authorize-payload";
import { formatMoney } from "@/lib/ai-audit/catalogue";
import { AUDIT_LINK_PLACEHOLDER } from "@/lib/ai-audit/proposal";
import { BUSINESS_TYPE_LABELS } from "@/lib/ai-audit/rules";
import { PUBLISH_CHANNELS } from "@/lib/founders/publish-targets";
import type { ApprovalView } from "@/lib/os/approvals/rules";
import { describeOutcome, newerApproval, requesterLabel, type OutcomeTone } from "@/components/os/approvals/outcome";

type Busy = null | "approve" | "send_back" | "comment";

const TONE_CLASS: Record<OutcomeTone, string> = {
  ok: "text-status-engaged",
  info: "text-fg-muted",
  warn: "text-status-warm",
  fail: "text-status-hot",
};

/** "10:42 AM" today, "Sep 27, 10:42 AM" otherwise — always in the operator's time zone. */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = operatorDateKey(new Date()) === operatorDateKey(d);
  return formatOperatorDate(
    today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
    d,
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function EmailPreview({ payload, clamp }: { payload: Record<string, unknown>; clamp: boolean }) {
  const cc = Array.isArray(payload.cc) ? payload.cc.map(String) : [];
  // Every recipient in full, wrapped, never cut to an ellipsis: an approver
  // who cannot read the whole address cannot tell who the email goes to.
  return (
    <div className="rounded-lg border border-hairline bg-bg-deep/40 px-3 py-2.5 text-[13px] leading-5">
      <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        <dt className="text-fg-dim">To</dt>
        <dd className="break-all text-fg">{str(payload.to)}</dd>
        {cc.length > 0 && (
          <>
            <dt className="text-fg-dim">Cc</dt>
            <dd className="break-all text-fg-muted">{cc.join(", ")}</dd>
          </>
        )}
        <dt className="text-fg-dim">Subject</dt>
        <dd className="font-medium text-fg">{str(payload.subject)}</dd>
      </dl>
      <p className={`mt-2 whitespace-pre-wrap break-words text-fg-muted ${clamp ? "line-clamp-4" : ""}`}>{str(payload.body)}</p>
    </div>
  );
}

function PostPreview({ payload }: { payload: Record<string, unknown> }) {
  const platforms = Array.isArray(payload.platforms) ? payload.platforms.map(String) : [];
  const labels = platforms.map((p) => PUBLISH_CHANNELS.find((c) => c.id === p)?.label ?? p);
  return (
    <div className="rounded-lg border border-hairline bg-bg-deep/40 px-3 py-2.5 text-[13px] leading-5">
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        <dt className="text-fg-dim">Channels</dt>
        <dd className="text-fg">{labels.join(", ")}</dd>
        <dt className="text-fg-dim">Asset</dt>
        <dd className="truncate font-mono text-xs leading-5 text-fg-muted">{str(payload.asset_id)}</dd>
        {str(payload.note) && (
          <>
            <dt className="text-fg-dim">Note</dt>
            <dd className="whitespace-pre-wrap text-fg-muted">{str(payload.note)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** A department's reply in a Slack thread: where it goes, and the exact words. */
function SlackPreview({ payload }: { payload: Record<string, unknown> }) {
  const channel = str(payload.channel_name) ? `#${str(payload.channel_name)}` : str(payload.channel_id);
  return (
    <div className="rounded-lg border border-hairline bg-bg-deep/40 px-3 py-2.5 text-[13px] leading-5">
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        <dt className="text-fg-dim">Slack</dt>
        <dd className="text-fg">{channel}, in the thread it was asked in</dd>
      </dl>
      <p className="mt-2 whitespace-pre-wrap break-words text-fg-muted">{str(payload.text)}</p>
    </div>
  );
}

const VERDICT_LABEL: Record<string, string> = { ship: "ready to send", revise: "needs edits", escalate: "a person should write this one" };

/**
 * An AI-drafted reply to a support ticket (reply_ticket): who it goes to, on
 * which ticket, what the draft critic thought of it, and the whole reply. On
 * approve it is posted on the ticket under the approver's name and emailed
 * from support@ in the client's own thread.
 */
function TicketReplyPreview({ payload, clamp }: { payload: Record<string, unknown>; clamp: boolean }) {
  const critic = payload.critic && typeof payload.critic === "object" ? (payload.critic as Record<string, unknown>) : null;
  const verdict = critic ? str(critic.verdict) : "";
  const score = critic && typeof critic.score === "number" ? critic.score : null;
  const issues = critic && Array.isArray(critic.issues) ? (critic.issues as Array<Record<string, unknown>>) : [];
  return (
    <div className="rounded-lg border border-hairline bg-bg-deep/40 px-3 py-2.5 text-[13px] leading-5">
      <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        <dt className="text-fg-dim">Ticket</dt>
        <dd className="text-fg">{str(payload.ticket_number)}</dd>
        <dt className="text-fg-dim">To</dt>
        <dd className="break-all text-fg">{str(payload.to)}</dd>
        <dt className="text-fg-dim">Subject</dt>
        <dd className="font-medium text-fg">{str(payload.subject)}</dd>
        {critic && (
          <>
            <dt className="text-fg-dim">Critic</dt>
            <dd className={verdict === "ship" ? "text-fg-muted" : "text-status-warm"}>
              {VERDICT_LABEL[verdict] ?? verdict}
              {score !== null ? ` (${score}/10)` : ""}
              {str(critic.notes) ? `: ${str(critic.notes)}` : ""}
            </dd>
          </>
        )}
      </dl>
      {issues.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs leading-4 text-status-warm">
          {issues.map((i, n) => (
            <li key={n}>{[str(i.reason), str(i.excerpt) ? `"${str(i.excerpt)}"` : ""].filter(Boolean).join(" ")}</li>
          ))}
        </ul>
      )}
      <p className={`mt-2 whitespace-pre-wrap break-words text-fg-muted ${clamp ? "line-clamp-4" : ""}`}>{str(payload.body)}</p>
    </div>
  );
}

/** The audit kinds: owner-only, each about one engagement on the AI audits board. */
const AI_AUDIT_KINDS: ReadonlySet<string> = new Set(["authorize_ai_audit", "deliver_ai_audit", "follow_up_ai_audit"]);

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** "12 facts", "1 fact". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** An email body with the client's link shown where it will go (the link is made only when it is sent). */
function BodyWithLink({ body, clamp }: { body: string; clamp: boolean }) {
  const parts = body.split(AUDIT_LINK_PLACEHOLDER);
  return (
    <p className={`mt-2 whitespace-pre-wrap break-words text-fg-muted ${clamp ? "line-clamp-4" : ""}`}>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 ? <span className="rounded border border-hairline px-1 text-[12px] text-fg">the client&apos;s private audit link</span> : null}
        </span>
      ))}
    </p>
  );
}

/** Where to read what the card is about, before deciding. */
function AuditLinks({ links }: { links: Array<{ href: string; label: string }> }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="font-medium text-fg underline underline-offset-2">
          {l.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * A Free AI Audit card in words: Gate 1 (what is authorized, which AI reads it,
 * what approving does), Gate 2 and the follow-ups (the whole email and, for
 * Gate 2, the amount). Every field still comes from the payload the approval is
 * bound to; the fingerprints say which versions it is locked to.
 */
function AiAuditPreview({ kind, payload, clamp }: { kind: string; payload: Record<string, unknown>; clamp: boolean }) {
  const id = encodeURIComponent(str(payload.engagement_id));
  const open = { href: `/ai-audits/${id}`, label: "Open the engagement" };
  const short = (v: unknown) => str(v).slice(0, 8);
  if (kind === "authorize_ai_audit") {
    const engine = str(payload.engine);
    const type = str(payload.business_type);
    const facts = num(payload.field_count) ?? 0;
    const gaps = num(payload.gap_count) ?? 0;
    const transcripts = num(payload.transcript_count) ?? 0;
    const notes = num(payload.note_count) ?? 0;
    const redactions = num(payload.redaction_count) ?? 0;
    const plan = Array.isArray(payload.plan) ? payload.plan.filter((l): l is string => typeof l === "string") : [];
    const call = [transcripts ? count(transcripts, "call transcript", "call transcripts") : "No call transcript", ...(notes ? [count(notes, "call note", "call notes")] : [])].join(", ");
    return (
      <div className="rounded-lg border border-hairline bg-bg-deep/40 px-3 py-2.5 text-[13px] leading-5">
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          <dt className="text-fg-dim">Business</dt>
          <dd className="text-fg">
            {str(payload.business_name)}
            <span className="text-fg-muted">, {(BUSINESS_TYPE_LABELS as Record<string, string>)[type] ?? "type not chosen yet"}</span>
          </dd>
          <dt className="text-fg-dim">Processed by</dt>
          <dd className="text-fg">{(AI_ENGINE_LABELS as Record<string, string>)[engine] ?? "an unknown engine"}</dd>
          <dt className="text-fg-dim">Profile</dt>
          <dd className="text-fg-muted">
            Version {num(payload.profile_version_no) ?? "?"}, {count(facts, "fact", "facts")}
            {gaps ? <span className="text-status-warm">, {count(gaps, "essential answer", "essential answers")} still missing</span> : null}
          </dd>
          <dt className="text-fg-dim">From the call</dt>
          <dd className="text-fg-muted">{call}</dd>
          {redactions ? (
            <>
              <dt className="text-fg-dim">Taken out</dt>
              <dd className="text-status-warm">{count(redactions, "possible password or account detail", "possible passwords or account details")}</dd>
            </>
          ) : null}
          {payload.founder_attested === true ? (
            <>
              <dt className="text-fg-dim">Consent</dt>
              <dd className="text-status-warm">Attested by a founder other than you</dd>
            </>
          ) : null}
        </dl>
        {plan.length ? (
          <>
            <p className="mt-2 text-xs font-medium text-fg-dim">If you approve</p>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-fg-muted">
              {plan.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </>
        ) : null}
        <AuditLinks
          links={[
            ...(transcripts ? [{ href: `/ai-audits/${id}?tab=call`, label: "Read the transcript lines" }] : []),
            { href: `/ai-audits/${id}?tab=profile`, label: "Check the profile" },
            open,
          ]}
        />
        <p className="mt-1.5 text-[11px] leading-4 text-fg-dim">
          Locked to profile version {num(payload.profile_version_no) ?? "?"} ({short(payload.profile_sha256)})
          {str(payload.transcripts_sha256) ? ` and its transcripts (${short(payload.transcripts_sha256)})` : ""}. A change files a new card.
        </p>
      </div>
    );
  }
  const currency = payload.currency === "USD" ? "USD" : "CAD";
  const total = num(payload.total_cents);
  const due = num(payload.due_now_cents);
  const reason = str(payload.reason);
  return (
    <div className="rounded-lg border border-hairline bg-bg-deep/40 px-3 py-2.5 text-[13px] leading-5">
      <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5">
        <dt className="text-fg-dim">To</dt>
        <dd className="break-all text-fg">{str(payload.to)}</dd>
        <dt className="text-fg-dim">Subject</dt>
        <dd className="font-medium text-fg">{str(payload.subject)}</dd>
        {kind === "deliver_ai_audit" && total !== null ? (
          <>
            <dt className="text-fg-dim">Price</dt>
            <dd className="tabular-nums text-fg">
              {formatMoney(total, currency)} {currency}
              {due !== null && due !== total ? <span className="text-fg-muted">, {formatMoney(due, currency)} due now</span> : null}
            </dd>
          </>
        ) : null}
        {kind === "follow_up_ai_audit" && reason ? (
          <>
            <dt className="text-fg-dim">Why</dt>
            <dd className="text-fg-muted">{reason === "not_opened" ? "They have not opened the audit." : "They opened the audit but have not paid."}</dd>
          </>
        ) : null}
      </dl>
      <BodyWithLink body={str(payload.body)} clamp={clamp} />
      <AuditLinks
        links={
          kind === "deliver_ai_audit"
            ? [
                { href: `/ai-audits/${id}/preview`, label: "Read it as the client will" },
                { href: `/api/ai-audit/${id}/pdf`, label: "Open the PDF" },
                open,
              ]
            : [open]
        }
      />
      {kind === "deliver_ai_audit" ? (
        <p className="mt-1.5 text-[11px] leading-4 text-fg-dim">
          Locked to the audit ({short(payload.audit_sha256)}), the proposal ({short(payload.proposal_sha256)}) and the PDF ({short(payload.pdf_sha256)}). A change files a new card.
        </p>
      ) : null}
    </div>
  );
}

/** A kind with no dedicated preview still shows everything it would act on. */
function GenericPreview({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload);
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-lg border border-hairline bg-bg-deep/40 px-3 py-2.5 text-[13px] leading-5">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate text-fg-dim">{k.replace(/_/g, " ")}</dt>
          <dd className="whitespace-pre-wrap break-words text-fg-muted">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ApprovalCard({
  approval: initial,
  density = "full",
}: {
  approval: ApprovalView;
  /** compact: the body is clamped until opened (Today, Overview panel). */
  density?: "full" | "compact";
}) {
  const [approval, setApproval] = useState<ApprovalView>(initial);
  const [mode, setMode] = useState<"idle" | "send_back" | "comment">("idle");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(density === "full");
  // A server render hands the card a fresh row (router.refresh): show it, the
  // newer of it and the row this card's own click returned (newerApproval).
  // Adjusted while rendering, React's pattern for state that follows a prop,
  // and only between clicks: a click in flight sets the row from its own
  // response. A half-written note (mode, text) is untouched.
  const [synced, setSynced] = useState<ApprovalView>(initial);
  if (initial !== synced && busy === null) {
    setSynced(initial);
    setApproval(newerApproval(approval, initial));
  }

  const outcome = describeOutcome(approval, when, Date.now());
  const pending = approval.status === "pending";
  const kind = approval.action_kind;
  const body = str(approval.payload.body);
  const clampable = density === "compact" && (kind === "send_email" || kind === "reply_ticket" || kind === "deliver_ai_audit" || kind === "follow_up_ai_audit") && body.length > 240;

  async function call(action: "approve" | "send-back" | "comment", payload: Record<string, unknown>, which: Busy) {
    if (busy) return;
    setBusy(which);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; approval?: ApprovalView; message?: string } | null;
      if (!res.ok || !json?.ok) {
        setError(json?.message || `The request failed (HTTP ${res.status}). Nothing changed.`);
        return;
      }
      if (json.approval) setApproval(json.approval);
      setMode("idle");
      setText("");
    } catch (err) {
      setError(
        `Could not reach the server (${err instanceof Error ? err.message : "network error"}). ` +
          (action === "approve" ? "Reload before trying again: it may have gone through." : "Nothing changed."),
      );
    } finally {
      setBusy(null);
    }
  }

  function submitNote(e: FormEvent) {
    e.preventDefault();
    const note = text.trim();
    if (mode === "send_back") {
      if (!note) {
        setError("Say what should change: the note goes back to whoever drafted it.");
        return;
      }
      void call("send-back", { note }, "send_back");
    } else if (mode === "comment") {
      if (!note) return;
      void call("comment", { body: note }, "comment");
    }
  }

  const deptLabel = approval.department_label ?? (AI_AUDIT_KINDS.has(kind) ? "Free AI Audit" : "Unattributed");

  return (
    <article
      aria-label={`${approval.action_label}: ${approval.title}`}
      className="rounded-xl border border-hairline bg-bg-panel px-4 py-3.5"
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-4 text-fg-dim">
        <span className="font-medium text-fg-muted">{deptLabel}</span>
        <span aria-hidden>·</span>
        <span>{approval.action_label}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">v{approval.revision}</span>
        <span aria-hidden>·</span>
        <span>{requesterLabel(approval.requested_by_type)}</span>
        <span aria-hidden>·</span>
        <time dateTime={approval.created_at} suppressHydrationWarning>
          {when(approval.created_at)}
        </time>
      </header>

      <h3 className="mt-1 text-sm font-semibold leading-5 text-fg">{approval.title}</h3>

      <div className="mt-2.5">
        {kind === "send_email" ? (
          <EmailPreview payload={approval.payload} clamp={clampable && !expanded} />
        ) : kind === "publish_post" ? (
          <PostPreview payload={approval.payload} />
        ) : kind === "send_slack_message" ? (
          <SlackPreview payload={approval.payload} />
        ) : kind === "reply_ticket" ? (
          <TicketReplyPreview payload={approval.payload} clamp={clampable && !expanded} />
        ) : AI_AUDIT_KINDS.has(kind) ? (
          <AiAuditPreview kind={kind} payload={approval.payload} clamp={clampable && !expanded} />
        ) : (
          <GenericPreview payload={approval.payload} />
        )}
        {clampable && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-xs font-medium text-fg-muted hover:text-fg"
            aria-expanded={expanded}
          >
            {expanded ? "Show less" : "Show the whole email"}
          </button>
        )}
      </div>

      {pending && !approval.executable && approval.readiness_note && (
        <p className="mt-2 text-xs leading-4 text-status-warm">{approval.readiness_note}</p>
      )}

      {approval.comments.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-hairline pt-2.5">
          {approval.comments.map((c) => (
            <li key={c.id} className="text-[13px] leading-5">
              <span className="font-medium text-fg">{c.author_name ?? "Teammate"}</span>{" "}
              <time className="text-xs text-fg-dim" dateTime={c.created_at} suppressHydrationWarning>
                {when(c.created_at)}
              </time>
              <p className="whitespace-pre-wrap break-words text-fg-muted">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      {outcome && (
        <div className="mt-3 border-t border-hairline pt-2.5" role="status" aria-live="polite">
          <p className={`text-[13px] font-medium leading-5 ${TONE_CLASS[outcome.tone]}`} suppressHydrationWarning>
            {outcome.text}
          </p>
          {outcome.detail && (
            <p className="mt-0.5 whitespace-pre-wrap text-xs leading-4 text-fg-dim" suppressHydrationWarning>
              {outcome.detail}
            </p>
          )}
        </div>
      )}

      {mode !== "idle" ? (
        <form onSubmit={submitNote} className="mt-3 space-y-2">
          <label htmlFor={`approval-note-${approval.id}`} className="block text-xs font-medium text-fg-muted">
            {mode === "send_back" ? "What should change? (required — it goes back to whoever drafted this)" : "Comment"}
          </label>
          <textarea
            id={`approval-note-${approval.id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={2000}
            required={mode === "send_back"}
            autoFocus
            className="block w-full resize-y rounded-lg border border-hairline bg-bg-deep/40 px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-dim focus:border-accent/60"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy !== null || (mode === "send_back" && !text.trim())}
              className="btn-secondary !px-3 !py-1.5 text-[13px] disabled:opacity-50"
            >
              {busy ? "Saving…" : mode === "send_back" ? "Send back" : "Comment"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setMode("idle");
                setText("");
                setError(null);
              }}
              className="px-2 text-[13px] text-fg-muted hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        (approval.can_decide || approval.can_comment || approval.can_resume) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {approval.can_resume && (
              // Approved but never started: the request that approved it died
              // before anything ran. Starting it is still exactly once.
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void call("approve", { payload_hash: approval.payload_hash }, "approve")}
                className="btn-secondary !px-3 !py-1.5 text-[13px]"
              >
                {busy === "approve" ? "Starting…" : "Carry it out now"}
              </button>
            )}
            {approval.can_decide && (
              <>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void call("approve", { payload_hash: approval.payload_hash }, "approve")}
                  className="btn-primary !px-3 !py-1.5 text-[13px]"
                >
                  {busy === "approve" ? "Approving…" : "Approve"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    setMode("send_back");
                    setError(null);
                  }}
                  className="btn-secondary !px-3 !py-1.5 text-[13px]"
                >
                  Send back
                </button>
              </>
            )}
            {approval.can_comment && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setMode("comment");
                  setError(null);
                }}
                className="px-2 text-[13px] font-medium text-fg-muted hover:text-fg disabled:opacity-50"
              >
                Comment
              </button>
            )}
          </div>
        )
      )}

      {error && (
        <p className="mt-2 text-xs leading-4 text-status-hot" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
