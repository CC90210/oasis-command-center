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
        className="flex-1 bg-black/50 cursor-default"
      />
      <aside className="relative w-full sm:w-[480px] h-full bg-bg-deep border-l border-bg-border flex flex-col">
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
          {data && activeTab === "notes" && <NotesTabStub />}
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

function NotesTabStub() {
  return (
    <div className="text-xs text-fg-dim italic py-6 text-center">
      Notes are coming soon. For now, log lead notes in the Activity timeline
      via SMS / email — they show up there with full context.
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
  entity,
  toEmail,
  onClose,
}: {
  recordId: string;
  entity: "lead" | "application";
  toEmail: string | null;
  onClose: () => void;
}) {
  if (!toEmail) {
    return (
      <ComposerShell title="Email" onClose={onClose}>
        <div className="text-xs text-fg-dim italic">No email on this {entity}.</div>
      </ComposerShell>
    );
  }
  // Direct in-drawer send is shipping next — outbound email today goes
  // through the chat agent so it can choose the right persona + log
  // properly through send_gateway. Pre-fills via `mailto:` as a
  // bridge so the operator isn't blocked.
  return (
    <ComposerShell title={`Email · ${toEmail}`} onClose={onClose}>
      <div className="text-[11px] text-fg-dim leading-relaxed">
        Direct in-drawer send is shipping next. Outbound email today goes
        through the chat agent — ask it to draft and send, and it&apos;ll log
        the thread under this {entity}.
      </div>
      <div className="flex items-center justify-end">
        <a
          href={`mailto:${toEmail}`}
          className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-bg-elev border border-bg-border text-fg"
        >
          Open in mail client
        </a>
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

function TextTorrentPicker({
  leadId,
  onClose,
}: {
  leadId: string | null;
  onClose: () => void;
}) {
  if (!leadId) {
    return (
      <ComposerShell title="Text Torrent" onClose={onClose}>
        <div className="text-xs text-fg-dim italic">
          Open this drawer on a lead to enroll in a sequence.
        </div>
      </ComposerShell>
    );
  }
  // Manual enrollment endpoint is shipping next. Sequences today fire
  // on stage transitions via the BRAVO_RECORD_STATUS_CHANGED event the
  // drip engine listens for. Linking out to /sequences keeps the
  // operator unblocked.
  return (
    <ComposerShell title="Text Torrent" onClose={onClose}>
      <div className="text-[11px] text-fg-dim leading-relaxed">
        Manual enroll is shipping next. Sequences today fire on lead-stage
        changes — change this lead&apos;s stage to trigger the matching
        cadence, or open the sequences page to manage them directly.
      </div>
      <div className="flex items-center justify-end">
        <Link
          href="/sequences"
          className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-bg-elev border border-bg-border text-fg"
        >
          Open sequences
        </Link>
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
