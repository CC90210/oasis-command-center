"use client";

/**
 * LeadDetailDrawer — right-side slide-in drawer for the SunBiz Leads
 * and Applications pages. Mounts when the catch-all tenant page sees
 * `?lead=<uuid>` or `?application=<uuid>` in the URL.
 *
 * Five tabs (Activity / Lenders / Bank / Notes / Documents) and three
 * footer actions (Send Email / Send SMS / Send via Text Torrent). Opens
 * without navigating away from the list so the operator keeps the
 * pipeline view as their reference frame.
 *
 * Loads the aggregated lead detail from /api/leads/[id]/detail in one
 * round trip; tabs render off that single payload. The Activity tab is
 * the existing LeadTimelinePanel (its own /api/leads/[id]/timeline
 * fetch).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { X, FileText, ImageIcon } from "lucide-react";
import { LeadTimelinePanel } from "./LeadTimelinePanel";

type DocRow = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  doc_type: string;
  uploaded_at: string;
};

type DetailPayload = {
  record: {
    id: string;
    entity: "lead" | "application";
    data: Record<string, unknown>;
  };
  documents: DocRow[];
  application: { id: string; data: Record<string, unknown> } | null;
};

type TabKey = "activity" | "lenders" | "bank" | "notes" | "documents";

const TABS: { key: TabKey; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "lenders", label: "Lenders" },
  { key: "bank", label: "Bank" },
  { key: "notes", label: "Notes" },
  { key: "documents", label: "Documents" },
];

export function LeadDetailDrawer({
  tenantSlug,
  recordId,
  entity,
}: {
  tenantSlug: string;
  recordId: string;
  entity: "lead" | "application";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("activity");
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    const next = new URLSearchParams(searchParams?.toString() || "");
    next.delete("lead");
    next.delete("application");
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }, [router, searchParams]);

  // Esc to close + body scroll lock + focus the close button on mount
  // (Codex pass-2 finding from the prior session: drawers without these
  // three a11y affordances trap keyboard users and shift scroll context
  // behind the modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [close]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    const url = `/api/leads/${recordId}/detail${entity === "application" ? "?entity=application" : ""}`;
    fetch(url, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j.ok) {
          setError(j.error || "load_failed");
          return;
        }
        setData(j as DetailPayload);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [recordId, entity]);

  const title = data
    ? resolveTitle(data.record.data)
    : entity === "application"
      ? "Application"
      : "Lead";
  const subtitle = data ? resolveSubtitle(data.record.data) : recordId.slice(0, 8);

  const editHref =
    entity === "application"
      ? `/t/${tenantSlug}/applications/${recordId}`
      : `/t/${tenantSlug}/leads/${recordId}`;

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} detail`}
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={close}
        className="flex-1 bg-black/60 backdrop-blur-sm cursor-default"
      />
      <aside className="relative w-full sm:w-[480px] h-full bg-bg-elev border-l border-bg-border shadow-[-12px_0_32px_-8px_rgba(0,0,0,0.6)] flex flex-col">
        <header className="flex items-start gap-3 px-4 py-3 border-b border-bg-border">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-fg truncate">{title}</h2>
            <div className="text-[11px] text-fg-dim truncate">{subtitle}</div>
          </div>
          <Link
            href={editHref}
            className="text-[11px] text-fg-muted hover:text-fg underline underline-offset-2 mt-0.5"
          >
            Edit full record
          </Link>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={close}
            aria-label="Close"
            className="p-1 rounded-md text-fg-muted hover:text-fg hover:bg-bg-elev"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <nav className="flex gap-1 px-4 pt-3 border-b border-bg-border overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`text-[11px] uppercase tracking-wider px-2.5 py-1.5 rounded-t-md border-b-2 ${
                activeTab === t.key
                  ? "border-accent text-fg"
                  : "border-transparent text-fg-muted hover:text-fg"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-y-auto px-4 py-4 text-sm">
          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
              Failed to load: {error}
            </div>
          )}
          {!error && !data && (
            <div className="text-xs text-fg-dim italic py-6 text-center">Loading…</div>
          )}
          {data && activeTab === "activity" && <LeadTimelinePanel leadId={recordId} />}
          {data && activeTab === "lenders" && <LendersTab application={data.application} />}
          {data && activeTab === "bank" && <BankTab record={data.record.data} />}
          {data && activeTab === "notes" && <NotesTab leadId={recordId} />}
          {data && activeTab === "documents" && <DocumentsTab docs={data.documents} />}
        </div>

        <DrawerFooter
          recordId={recordId}
          entity={entity}
          recordData={data?.record.data || {}}
        />
      </aside>
    </div>
  );
}

function resolveTitle(d: Record<string, unknown>): string {
  return (
    str(d.business_name) ||
    str(d.name) ||
    str(d.contact_name) ||
    str(d.title) ||
    "Untitled"
  );
}

function resolveSubtitle(d: Record<string, unknown>): string {
  const parts: string[] = [];
  if (str(d.contact_name) && str(d.business_name)) parts.push(str(d.contact_name)!);
  if (str(d.email)) parts.push(str(d.email)!);
  if (str(d.phone)) parts.push(str(d.phone)!);
  return parts.join(" · ") || "—";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function LendersTab({
  application,
}: {
  application: { id: string; data: Record<string, unknown> } | null;
}) {
  if (!application) {
    return (
      <div className="text-xs text-fg-dim italic py-6 text-center">
        No application linked to this lead yet. Lender shop-out results show up
        here once an application is created and submitted to underwriting.
      </div>
    );
  }
  const results = application.data.shop_out_results;
  const list = Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
  if (list.length === 0) {
    return (
      <div className="text-xs text-fg-dim italic py-6 text-center">
        Application {application.id.slice(0, 8)} hasn&apos;t been shopped out yet.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-bg-border">
      {list.map((r, i) => (
        <li key={i} className="py-2.5 text-sm">
          <div className="text-fg font-medium">{str(r.lender_name) || str(r.lender_id) || "Lender"}</div>
          <div className="text-[11px] text-fg-dim">
            {str(r.status) || "pending"}
            {str(r.amount) ? ` · ${str(r.amount)}` : ""}
            {str(r.factor_rate) ? ` · factor ${str(r.factor_rate)}` : ""}
          </div>
        </li>
      ))}
    </ul>
  );
}

function BankTab({ record }: { record: Record<string, unknown> }) {
  const fields: { key: string; label: string }[] = [
    { key: "bank_name", label: "Bank" },
    { key: "monthly_revenue", label: "Monthly revenue" },
    { key: "avg_daily_balance", label: "Avg daily balance" },
    { key: "nsf_count", label: "NSFs" },
    { key: "deposits_per_month", label: "Deposits / month" },
    { key: "time_in_business", label: "Time in business" },
  ];
  const present = fields.filter((f) => record[f.key] != null && record[f.key] !== "");
  if (present.length === 0) {
    return (
      <div className="text-xs text-fg-dim italic py-6 text-center">
        No banking info yet. Fields like monthly revenue + bank name fill in
        from the application form or from uploaded bank statements.
      </div>
    );
  }
  return (
    <dl className="space-y-2">
      {present.map((f) => (
        <div key={f.key} className="flex items-baseline justify-between gap-3">
          <dt className="text-[11px] uppercase tracking-wider text-fg-dim">{f.label}</dt>
          <dd className="text-fg text-sm font-medium text-right">{String(record[f.key])}</dd>
        </div>
      ))}
    </dl>
  );
}

type NoteRow = {
  id: string;
  content_preview: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

function NotesTab({ leadId }: { leadId: string }) {
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/notes`, { credentials: "include" });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || "load_failed");
        setNotes([]);
        return;
      }
      setNotes((j.notes || []) as NoteRow[]);
    } catch (e) {
      setError(String((e as Error).message || e));
      setNotes([]);
    }
  }, [leadId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async () => {
    if (!draft.trim()) return;
    setPending(true);
    setError(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/notes`, {
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
      await reload();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a note about this lead…"
          rows={3}
          maxLength={4000}
          className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg resize-none"
        />
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-fg-dim">
            {error ? <span className="text-red-400">{error}</span> : `${draft.length}/4000`}
          </div>
          <button
            type="button"
            disabled={pending || !draft.trim()}
            onClick={save}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
      <div className="border-t border-bg-border pt-3">
        {notes === null ? (
          <div className="text-xs text-fg-dim italic">Loading…</div>
        ) : notes.length === 0 ? (
          <div className="text-xs text-fg-dim italic py-3 text-center">
            No notes yet. Your first one will land at the top.
          </div>
        ) : (
          <ul className="space-y-2.5">
            {notes.map((n) => {
              const author =
                n.metadata && typeof n.metadata === "object"
                  ? (n.metadata as Record<string, unknown>).author_email
                  : null;
              return (
                <li key={n.id} className="rounded-md bg-bg-deep/60 border border-bg-border p-2.5">
                  <div className="text-[13px] text-fg whitespace-pre-wrap leading-relaxed">
                    {n.content_preview}
                  </div>
                  <div className="text-[10.5px] text-fg-dim mt-1.5">
                    {typeof author === "string" ? `${author} · ` : ""}
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function DocumentsTab({ docs }: { docs: DocRow[] }) {
  if (docs.length === 0) {
    return (
      <div className="text-xs text-fg-dim italic py-6 text-center">
        No documents yet. Files uploaded through the application form land here.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-bg-border">
      {docs.map((d) => {
        const isImage = (d.mime_type || "").startsWith("image/");
        return (
          <li key={d.id} className="flex items-center gap-3 py-2.5 text-sm">
            <div className="shrink-0 text-fg-dim">
              {isImage ? <ImageIcon className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-fg truncate">{d.filename}</div>
              <div className="text-[11px] text-fg-dim">
                {docTypeLabel(d.doc_type)} · {humanSize(d.size_bytes)} ·{" "}
                {new Date(d.uploaded_at).toLocaleDateString()}
              </div>
            </div>
            <DocDownloadButton id={d.id} filename={d.filename} />
          </li>
        );
      })}
    </ul>
  );
}

function DocDownloadButton({ id, filename }: { id: string; filename: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const r = await fetch(`/api/lead-documents/${id}`, { credentials: "include" });
          const j = await r.json();
          if (j.ok && j.url) {
            const a = document.createElement("a");
            a.href = j.url;
            a.download = filename;
            a.target = "_blank";
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
        } finally {
          setPending(false);
        }
      }}
      className="text-[11px] uppercase tracking-wider px-2 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg disabled:opacity-50"
    >
      {pending ? "…" : "View"}
    </button>
  );
}

function humanSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function docTypeLabel(t: string): string {
  switch (t) {
    case "bank_statements_3mo":
      return "Bank statements (3 mo)";
    case "drivers_license":
      return "Driver's license";
    case "proof_of_ownership":
      return "Proof of ownership";
    case "void_cheque":
      return "Void cheque";
    case "business_license":
      return "Business license";
    case "tax_returns":
      return "Tax returns";
    case "unclassified":
      return "Other";
    default:
      return t.replace(/_/g, " ");
  }
}

/* -------------------------------------------------------------------------- */
/* Footer composers                                                            */
/* -------------------------------------------------------------------------- */

type ComposerMode = "email" | "sms" | "torrent" | null;

function DrawerFooter({
  recordId,
  entity,
  recordData,
}: {
  recordId: string;
  entity: "lead" | "application";
  recordData: Record<string, unknown>;
}) {
  const [mode, setMode] = useState<ComposerMode>(null);
  return (
    <div className="border-t border-bg-border bg-bg-elev/40">
      {mode === null ? (
        <div className="flex items-stretch gap-2 p-3">
          <button
            type="button"
            onClick={() => setMode("email")}
            className="flex-1 text-[12px] font-semibold px-3 py-2 rounded-md bg-bg-elev border border-bg-border text-fg hover:bg-bg-elev/80"
          >
            Send Email
          </button>
          <button
            type="button"
            onClick={() => setMode("sms")}
            className="flex-1 text-[12px] font-semibold px-3 py-2 rounded-md bg-bg-elev border border-bg-border text-fg hover:bg-bg-elev/80"
          >
            Send SMS
          </button>
          <button
            type="button"
            onClick={() => setMode("torrent")}
            className="flex-1 text-[12px] font-semibold px-3 py-2 rounded-md bg-accent/15 border border-accent/40 text-accent hover:bg-accent/25"
          >
            Text Torrent
          </button>
        </div>
      ) : mode === "email" ? (
        <EmailComposer
          recordId={recordId}
          entity={entity}
          toEmail={str(recordData.email)}
          onClose={() => setMode(null)}
        />
      ) : mode === "sms" ? (
        <SmsComposer
          toPhone={str(recordData.phone)}
          onClose={() => setMode(null)}
        />
      ) : (
        <TextTorrentPicker
          leadId={entity === "lead" ? recordId : null}
          onClose={() => setMode(null)}
        />
      )}
    </div>
  );
}

function EmailComposer({
  recordId,
  entity,
  toEmail,
  onClose,
}: {
  recordId: string;
  entity: "lead" | "application";
  toEmail: string | null;
  onClose: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!toEmail) {
    return (
      <ComposerShell title="Email" onClose={onClose}>
        <div className="text-xs text-fg-dim italic">No email on this {entity}.</div>
      </ComposerShell>
    );
  }
  // POSTs to /api/leads/[id]/email which queues the send via
  // lead_interactions(status=queued) + emits the dashboard-queued event
  // for send_gateway.py to pick up. The drawer is fully decoupled from
  // SMTP credentials — the daemon side does the actual delivery.
  return (
    <ComposerShell title={`Email · ${toEmail}`} onClose={onClose}>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        maxLength={200}
        className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Message"
        rows={5}
        maxLength={32000}
        className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg resize-none"
      />
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-fg-dim">
          {status ? status : `${body.length}/32000 · queues for send_gateway`}
        </div>
        <button
          type="button"
          disabled={pending || !subject.trim() || !body.trim()}
          onClick={async () => {
            setPending(true);
            setStatus(null);
            try {
              const r = await fetch(`/api/leads/${recordId}/email`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                  to_email: toEmail,
                  subject,
                  body,
                }),
              });
              const j = await r.json().catch(() => ({}));
              if (r.ok && j.ok) {
                setStatus("Queued");
                setSubject("");
                setBody("");
              } else {
                setStatus(j.error || `Failed (${r.status})`);
              }
            } catch (e) {
              setStatus(String((e as Error).message || e));
            } finally {
              setPending(false);
            }
          }}
          className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
        >
          {pending ? "Queueing…" : "Queue send"}
        </button>
      </div>
    </ComposerShell>
  );
}

function SmsComposer({
  toPhone,
  onClose,
}: {
  toPhone: string | null;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!toPhone) {
    return (
      <ComposerShell title="SMS" onClose={onClose}>
        <div className="text-xs text-fg-dim italic">No phone on this record.</div>
      </ComposerShell>
    );
  }
  return (
    <ComposerShell title={`SMS · ${toPhone}`} onClose={onClose}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Message"
        rows={3}
        maxLength={1600}
        className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg resize-none"
      />
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-fg-dim">
          {status || `${body.length}/1600`}
        </div>
        <button
          type="button"
          disabled={pending || !body}
          onClick={async () => {
            setPending(true);
            setStatus(null);
            try {
              const r = await fetch("/api/sms/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ to: toPhone, body }),
              });
              const j = await r.json().catch(() => ({}));
              if (r.ok && j.ok !== false) {
                setStatus("Sent");
                setBody("");
              } else {
                setStatus(j.error || `Failed (${r.status})`);
              }
            } catch (e) {
              setStatus(String((e as Error).message || e));
            } finally {
              setPending(false);
            }
          }}
          className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
    </ComposerShell>
  );
}

type SequenceOption = { id: string; name: string; enabled: boolean };

function TextTorrentPicker({
  leadId,
  onClose,
}: {
  leadId: string | null;
  onClose: () => void;
}) {
  const [sequences, setSequences] = useState<SequenceOption[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/sequences", { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        const list = Array.isArray(j.sequences) ? j.sequences : [];
        setSequences(
          list
            .map((s: Record<string, unknown>) => ({
              id: String(s.id ?? ""),
              name: String(s.name ?? "Untitled sequence"),
              enabled: s.enabled !== false,
            }))
            .filter((s: SequenceOption) => s.id && s.enabled),
        );
      })
      .catch(() => {
        if (alive) setSequences([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!leadId) {
    return (
      <ComposerShell title="Text Torrent" onClose={onClose}>
        <div className="text-xs text-fg-dim italic">
          Open this drawer on a lead to enroll in a sequence.
        </div>
      </ComposerShell>
    );
  }

  return (
    <ComposerShell title="Text Torrent · enroll" onClose={onClose}>
      {sequences === null ? (
        <div className="text-xs text-fg-dim italic">Loading sequences…</div>
      ) : sequences.length === 0 ? (
        <div className="text-xs text-fg-dim italic leading-relaxed">
          No enabled sequences. Build one at{" "}
          <Link href="/sequences" className="underline text-fg-muted hover:text-fg">
            /sequences
          </Link>{" "}
          and toggle it on first.
        </div>
      ) : (
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg"
        >
          <option value="">Choose a sequence…</option>
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-fg-dim">{status}</div>
        <button
          type="button"
          disabled={pending || !selected}
          onClick={async () => {
            setPending(true);
            setStatus(null);
            try {
              const r = await fetch(`/api/sequences/${selected}/enroll`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ lead_id: leadId }),
              });
              const j = await r.json().catch(() => ({}));
              if (r.ok && j.ok) {
                setStatus(
                  j.scheduled_for
                    ? `Enrolled — fires ${new Date(j.scheduled_for).toLocaleString()}`
                    : "Enrolled",
                );
              } else if (r.status === 409 && j.error === "already_enrolled") {
                setStatus("Already enrolled (one-per-lead)");
              } else {
                setStatus(j.error || `Failed (${r.status})`);
              }
            } catch (e) {
              setStatus(String((e as Error).message || e));
            } finally {
              setPending(false);
            }
          }}
          className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
        >
          {pending ? "Enrolling…" : "Enroll"}
        </button>
      </div>
    </ComposerShell>
  );
}

function ComposerShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-fg-muted">{title}</div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-fg-dim hover:text-fg"
        >
          Cancel
        </button>
      </div>
      {children}
    </div>
  );
}
