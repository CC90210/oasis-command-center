"use client";

/**
 * The actions on a business document: Copy, Download, Open source (founders),
 * Ask <department>, and for founders on a stored document Draft it, Edit and
 * Mark current. Every write is a founder's own click; Mark current asks for a
 * second click to confirm. After a write the page reloads from the server, so
 * what shows is what was saved, never an optimistic guess. (router.refresh()
 * was not enough: the local walk saved an edit and marked it current 1.4 s
 * later, the database held version 3 and Current, and the page kept showing
 * version 2 and Draft, because the second refresh was folded into the first
 * one still in flight. A reload always reads the saved state.)
 */

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, Download, ExternalLink, MessageSquare, PenLine, ShieldCheck, Sparkles } from "lucide-react";
import { copyText } from "@/lib/clipboard";

export type DocActionsProps = {
  slug: string;
  body: string | null;
  founder: boolean;
  openHref: string | null;
  ask: { href: string; label: string } | null;
  canDraft: boolean;
  /** A stored text exists and may be edited. */
  editable: boolean;
  /** The stored document is a draft a founder may mark current. */
  markable: boolean;
  version: number | null;
  placeholderCount: number;
};

const BTN =
  "inline-flex items-center gap-1.5 rounded-md border border-hairline px-2.5 py-1.5 text-xs font-medium text-fg-muted hover:text-fg hover:border-bg-border-strong transition-colors disabled:opacity-50";

async function post(url: string, method: "POST" | "PUT", body: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data: { ok?: boolean; message?: string; error?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return { ok: false, message: `The server answered ${res.status} with no details.` };
  }
  if (res.ok && data.ok) return { ok: true, message: "" };
  return { ok: false, message: data.message || data.error || `The server answered ${res.status}.` };
}

export function DocActions(props: DocActionsProps) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<null | "draft" | "save" | "mark">(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(props.body ?? "");
  const [confirmMark, setConfirmMark] = useState(false);
  const base = `/api/playbook/docs/${encodeURIComponent(props.slug)}`;

  async function onCopy() {
    if (props.body && (await copyText(props.body))) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  async function run(kind: "draft" | "save" | "mark", url: string, method: "POST" | "PUT", body: Record<string, unknown>) {
    setBusy(kind);
    setError(null);
    try {
      const r = await post(url, method, body);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setEditing(false);
      setConfirmMark(false);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request did not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {props.body !== null && (
          <>
            <button type="button" className={BTN} onClick={onCopy}>
              {copied ? <Check className="h-3.5 w-3.5 text-status-engaged" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
            <a className={BTN} href={`${base}/download`}>
              <Download className="h-3.5 w-3.5" /> Download .md
            </a>
          </>
        )}
        {props.founder && props.openHref && (
          <Link className={BTN} href={props.openHref} prefetch={false}>
            <ExternalLink className="h-3.5 w-3.5" /> Open source
          </Link>
        )}
        {props.ask && (
          <Link className={BTN} href={props.ask.href} prefetch={false}>
            <MessageSquare className="h-3.5 w-3.5" /> Ask {props.ask.label}
          </Link>
        )}
        {props.canDraft && (
          <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={busy !== null} onClick={() => run("draft", `${base}/draft`, "POST", {})}>
            <Sparkles className="h-3.5 w-3.5" /> {busy === "draft" ? "Drafting..." : "Draft it"}
          </button>
        )}
        {props.founder && props.editable && !editing && (
          <button type="button" className={BTN} onClick={() => { setDraftText(props.body ?? ""); setEditing(true); }}>
            <PenLine className="h-3.5 w-3.5" /> Edit
          </button>
        )}
        {props.founder && props.markable && !editing && (
          confirmMark ? (
            <span className="inline-flex items-center gap-2 text-xs text-fg">
              Mark this version current?
              <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => run("mark", `${base}/mark-current`, "POST", { expected_version: props.version })}>
                {busy === "mark" ? "Saving..." : "Yes, mark current"}
              </button>
              <button type="button" className={BTN} onClick={() => setConfirmMark(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className={BTN} onClick={() => setConfirmMark(true)} title={props.placeholderCount > 0 ? "Answer every CC to confirm placeholder first" : undefined}>
              <ShieldCheck className="h-3.5 w-3.5" /> Mark current
            </button>
          )
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-sm text-fg">
          {error}
        </p>
      )}

      {editing && (
        <div className="space-y-2">
          <label htmlFor="doc-body" className="text-xs font-medium text-fg-muted">
            Markdown. Replace each [[CC to confirm: ...]] with the answer; saving returns the document to Draft.
          </label>
          <textarea
            id="doc-body"
            className="w-full min-h-[24rem] rounded-md border border-hairline bg-bg-elev px-3 py-2 font-mono text-xs text-fg"
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
          />
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => run("save", base, "PUT", { body_md: draftText, expected_version: props.version })}>
              {busy === "save" ? "Saving..." : "Save"}
            </button>
            <button type="button" className={BTN} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
