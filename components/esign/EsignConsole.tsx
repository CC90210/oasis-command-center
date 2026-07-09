"use client";

/**
 * EsignConsole — the "E-Sign" dashboard section (/t/<slug>/esign).
 *
 * Structure mirrors CampaignsClient (components/campaigns/CampaignsClient.tsx):
 * a collapsible "New request" create panel, a table of existing requests,
 * and (here) a detail drawer with the audit timeline + downloads instead of
 * a separate route-driven drawer — kept in-component since e-sign envelopes
 * don't have their own record page yet.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, EmptyState } from "@/components/Card";
import { Plus, Send, X, Trash2, Download, RefreshCcw, Ban, Loader2 } from "lucide-react";

type SignerSummary = { id: string; email: string; name: string; status: string; sign_order: number };
type EnvelopeSummary = {
  id: string;
  title: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  signers: SignerSummary[];
};
type EventRow = { id: string; event: string; actor: string | null; at: string; meta: Record<string, unknown> };

const STATUS_TONE: Record<string, string> = {
  draft: "text-fg-dim",
  sent: "text-status-warm",
  viewed: "text-status-warm",
  partially_signed: "text-status-warm",
  completed: "text-status-good",
  voided: "text-fg-dim",
  declined: "text-status-hot",
  expired: "text-status-hot",
};

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : s;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

export function EsignConsole({ tenantId }: { tenantSlug: string; tenantId: string | null }) {
  const [loading, setLoading] = useState(true);
  const [envelopes, setEnvelopes] = useState<EnvelopeSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [signers, setSigners] = useState<Array<{ email: string; name: string }>>([{ email: "", name: "" }]);
  const [file, setFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ envelope: EnvelopeSummary; signers: SignerSummary[]; events: EventRow[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/esign/envelopes");
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data?.error || "Couldn't load e-sign requests.");
        return;
      }
      setEnvelopes(data.envelopes || []);
    } catch {
      setError("Network error loading e-sign requests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setOpenId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await fetch(`/api/esign/envelopes/${id}`);
      const data = await res.json();
      if (res.ok && data.ok) {
        setDetail({ envelope: data.envelope, signers: data.signers, events: data.events });
      }
    } finally {
      setDetailLoading(false);
    }
  }, []);

  function addSignerRow() {
    setSigners((s) => [...s, { email: "", name: "" }]);
  }
  function removeSignerRow(idx: number) {
    setSigners((s) => (s.length > 1 ? s.filter((_, i) => i !== idx) : s));
  }
  function updateSignerRow(idx: number, field: "email" | "name", value: string) {
    setSigners((s) => s.map((row, i) => (i === idx ? { ...row, [field]: value } : row)));
  }

  async function createAndSend() {
    setCreateError(null);
    if (!title.trim()) {
      setCreateError("Title is required.");
      return;
    }
    if (!file) {
      setCreateError("Attach a PDF to send.");
      return;
    }
    const validSigners = signers
      .map((s) => ({ email: s.email.trim().toLowerCase(), name: s.name.trim() }))
      .filter((s) => s.email && s.name);
    if (validSigners.length === 0) {
      setCreateError("Add at least one signer (name + email).");
      return;
    }

    setCreating(true);
    try {
      const pdfBase64 = await fileToBase64(file);
      const createRes = await fetch("/api/esign/envelopes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          message: message.trim() || undefined,
          filename: file.name,
          pdfBase64,
          signers: validSigners.map((s, i) => ({ ...s, order: i + 1 })),
        }),
      });
      const createData = await createRes.json();
      if (!createRes.ok || !createData.ok) {
        setCreateError(createData?.error || "Couldn't create the envelope.");
        return;
      }
      const envelopeId = createData.envelope.id as string;
      const sendRes = await fetch(`/api/esign/envelopes/${envelopeId}/send`, { method: "POST" });
      const sendData = await sendRes.json();
      if (!sendRes.ok || !sendData.ok) {
        setCreateError("Envelope created, but sending the email failed. Retry from the detail view.");
      }

      setTitle("");
      setMessage("");
      setSigners([{ email: "", name: "" }]);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setShowForm(false);
      await load();
    } catch {
      setCreateError("Network error creating the envelope.");
    } finally {
      setCreating(false);
    }
  }

  async function remind(id: string) {
    setActionBusy(true);
    try {
      await fetch(`/api/esign/envelopes/${id}/remind`, { method: "POST" });
      await openDetail(id);
      await load();
    } finally {
      setActionBusy(false);
    }
  }

  async function voidEnvelope(id: string) {
    const reason = window.prompt("Reason for voiding this envelope?");
    if (!reason || !reason.trim()) return;
    setActionBusy(true);
    try {
      await fetch(`/api/esign/envelopes/${id}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      await openDetail(id);
      await load();
    } finally {
      setActionBusy(false);
    }
  }

  function downloadPdf(id: string, variant: "source" | "signed") {
    window.open(`/api/esign/envelopes/${id}/download?variant=${variant}`, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="space-y-4">
      <Card
        title="New signature request"
        subtitle="Upload a PDF, add signers, and send — or sign an existing document."
        action={
          <button
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-3 py-1.5 text-[12px] font-bold text-fg-muted hover:text-fg"
          >
            {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showForm ? "Cancel" : "New request"}
          </button>
        }
      >
        {!showForm ? (
          <p className="text-xs text-fg-dim">Click &quot;New request&quot; to send a contract for signature.</p>
        ) : (
          <div className="space-y-3">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title (e.g. Funding Agreement — ABC Corp)"
              className="w-full rounded-md border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg"
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="w-full text-xs text-fg-muted"
            />
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="Optional note to signers"
              className="w-full rounded-md border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg"
            />
            <div className="space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-fg-dim">Signers</div>
              {signers.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={s.name}
                    onChange={(e) => updateSignerRow(i, "name", e.target.value)}
                    placeholder="Full name"
                    className="w-1/3 rounded-md border border-bg-border bg-bg-deep px-2.5 py-1.5 text-sm text-fg"
                  />
                  <input
                    type="email"
                    value={s.email}
                    onChange={(e) => updateSignerRow(i, "email", e.target.value)}
                    placeholder="email@example.com"
                    className="flex-1 rounded-md border border-bg-border bg-bg-deep px-2.5 py-1.5 text-sm text-fg"
                  />
                  <button onClick={() => removeSignerRow(i)} className="text-fg-dim hover:text-status-hot">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button onClick={addSignerRow} className="text-[11px] font-bold text-fg-muted hover:text-fg">
                + Add another signer
              </button>
            </div>
            {createError && <p className="text-xs text-status-hot">{createError}</p>}
            <button
              onClick={createAndSend}
              disabled={creating}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-white disabled:opacity-40"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Create &amp; send
            </button>
          </div>
        )}
      </Card>

      <Card title="Requests" subtitle={tenantId ? undefined : "Preview mode — no live data"} noPadding>
        {loading ? (
          <div className="p-5 text-sm text-fg-dim">Loading…</div>
        ) : error ? (
          <div className="p-5 text-sm text-status-hot">{error}</div>
        ) : envelopes.length === 0 ? (
          <EmptyState message="No signature requests yet. Create one above to get started." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-bg-border text-[11px] uppercase tracking-[0.08em] text-fg-dim text-left">
                <th className="px-4 py-2.5">Title</th>
                <th className="px-4 py-2.5">Signers</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody>
              {envelopes.map((env) => (
                <tr
                  key={env.id}
                  onClick={() => openDetail(env.id)}
                  className="border-b border-bg-border/60 hover:bg-bg-elev/40 cursor-pointer"
                >
                  <td className="px-4 py-2.5 font-medium text-fg">{env.title}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {env.signers.map((s) => (
                        <span
                          key={s.id}
                          className={`rounded-full border border-bg-border px-2 py-0.5 text-[10px] font-bold ${STATUS_TONE[s.status] || "text-fg-muted"}`}
                        >
                          {s.name.split(" ")[0]}: {s.status}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className={`px-4 py-2.5 font-bold ${STATUS_TONE[env.status] || "text-fg-muted"}`}>{env.status}</td>
                  <td className="px-4 py-2.5 text-fg-dim">{fmtDate(env.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {openId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setOpenId(null)}>
          <div
            className="h-full w-full max-w-md overflow-y-auto bg-bg-panel border-l border-bg-border p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">Request detail</h2>
              <button onClick={() => setOpenId(null)} className="text-fg-dim hover:text-fg">
                <X className="h-4 w-4" />
              </button>
            </div>

            {detailLoading || !detail ? (
              <div className="text-sm text-fg-dim">Loading…</div>
            ) : (
              <>
                <div>
                  <div className="text-base font-bold text-fg">{detail.envelope.title}</div>
                  <div className={`text-xs font-bold mt-0.5 ${STATUS_TONE[detail.envelope.status] || "text-fg-muted"}`}>
                    {detail.envelope.status}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => downloadPdf(openId, "source")}
                    className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-3 py-1.5 text-[12px] font-bold text-fg-muted hover:text-fg"
                  >
                    <Download className="h-3.5 w-3.5" /> Source
                  </button>
                  {detail.envelope.status === "completed" && (
                    <button
                      onClick={() => downloadPdf(openId, "signed")}
                      className="inline-flex items-center gap-1.5 rounded-md border border-status-good/40 bg-status-good/10 px-3 py-1.5 text-[12px] font-bold text-status-good"
                    >
                      <Download className="h-3.5 w-3.5" /> Signed
                    </button>
                  )}
                  {["sent", "viewed", "partially_signed"].includes(detail.envelope.status) && (
                    <button
                      onClick={() => remind(openId)}
                      disabled={actionBusy}
                      className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-3 py-1.5 text-[12px] font-bold text-fg-muted hover:text-fg disabled:opacity-40"
                    >
                      <RefreshCcw className="h-3.5 w-3.5" /> Remind
                    </button>
                  )}
                  {!["voided", "completed"].includes(detail.envelope.status) && (
                    <button
                      onClick={() => voidEnvelope(openId)}
                      disabled={actionBusy}
                      className="inline-flex items-center gap-1.5 rounded-md border border-status-hot/40 bg-status-hot/10 px-3 py-1.5 text-[12px] font-bold text-status-hot disabled:opacity-40"
                    >
                      <Ban className="h-3.5 w-3.5" /> Void
                    </button>
                  )}
                </div>

                <div>
                  <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-fg-dim mb-1.5">Signers</div>
                  <div className="space-y-1.5">
                    {detail.signers.map((s) => (
                      <div key={s.id} className="flex items-center justify-between text-xs">
                        <span className="text-fg">{s.name} <span className="text-fg-dim">({s.email})</span></span>
                        <span className={`font-bold ${STATUS_TONE[s.status] || "text-fg-muted"}`}>{s.status}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-bold uppercase tracking-[0.1em] text-fg-dim mb-1.5">Audit timeline</div>
                  <div className="space-y-1.5 text-xs">
                    {detail.events.map((ev) => (
                      <div key={ev.id} className="flex items-start justify-between gap-2 border-b border-bg-border/50 pb-1.5">
                        <span className="text-fg-muted">{ev.event}</span>
                        <span className="text-fg-dim whitespace-nowrap">{fmtDate(ev.at)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
