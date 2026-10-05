"use client";

/**
 * Statement import: choose the account and file, preview what will be added
 * (duplicates of rows already imported are marked and will be skipped), then
 * commit. The server re-parses the file on commit — preview rows are display
 * only.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatCents } from "@/lib/founders-finances/money";
import { inputClass, labelClass, primaryButton, quietButton } from "./ui";

type PreviewRow = {
  postedDate: string;
  description: string;
  amountCents: number;
  duplicate: boolean;
  suggestedCategoryName: string | null;
};
type Preview = { format: string; currency: string; errors: string[]; notes: string[]; total: number; duplicates: number; rows: PreviewRow[] };

export function ImportPanel({ entity, accounts }: { entity: string; accounts: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [dateOrder, setDateOrder] = useState("");
  const [currency, setCurrency] = useState("CAD");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(mode: "preview" | "commit") {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("entity", entity);
    fd.set("account_id", accountId);
    fd.set("currency", currency);
    if (dateOrder) fd.set("date_order", dateOrder);
    fd.set("mode", mode);
    try {
      const res = await fetch("/api/founders/finances/import", { method: "POST", body: fd });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !json?.ok) {
        setMsg({ ok: false, text: (json?.message as string) || (json?.error as string) || `Failed (${res.status})` });
        return;
      }
      if (mode === "preview") setPreview(json.preview as Preview);
      else {
        const r = json.result as { inserted: number; duplicates: number; posted: number };
        setMsg({ ok: true, text: `Imported ${r.inserted} new, skipped ${r.duplicates} already imported, auto-categorised ${r.posted}.` });
        setPreview(null);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div>
          <label className={labelClass}>Into account</label>
          <select className={inputClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Statement (CSV, OFX, QFX)</label>
          <input
            type="file"
            accept=".csv,.ofx,.qfx,text/csv"
            className="block w-full text-xs text-fg-muted file:mr-2 file:rounded-md file:border file:border-bg-border file:bg-bg-elev file:px-2 file:py-1 file:text-xs file:text-fg"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setPreview(null);
            }}
          />
        </div>
        <div>
          <label className={labelClass}>Dates are written</label>
          <select className={inputClass} value={dateOrder} onChange={(e) => setDateOrder(e.target.value)}>
            <option value="">Detect</option>
            <option value="mdy">Month/Day/Year</option>
            <option value="dmy">Day/Month/Year</option>
            <option value="ymd">Year-Month-Day</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Currency (CSV)</label>
          <select className={inputClass} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="CAD">CAD</option>
            <option value="USD">USD</option>
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={quietButton} disabled={!file || busy} onClick={() => send("preview")}>
          Preview
        </button>
        <button type="button" className={primaryButton} disabled={!file || busy || !preview || preview.total === preview.duplicates} onClick={() => send("commit")}>
          {preview ? `Import ${preview.total - preview.duplicates} new` : "Import"}
        </button>
        {msg && <span className={`text-xs ${msg.ok ? "text-status-engaged" : "text-status-hot"}`}>{msg.text}</span>}
      </div>
      {preview && (
        <div className="space-y-2">
          <p className="text-xs text-fg-muted">
            {preview.format.toUpperCase()} · {preview.currency} · {preview.total} rows · {preview.duplicates} already imported
            {preview.errors.length > 0 && <span className="text-status-warm"> · {preview.errors.length} unreadable</span>}
          </p>
          {preview.notes.map((n) => (
            <p key={n} className="text-xs text-status-warm">
              {n}
            </p>
          ))}
          {preview.errors.slice(0, 5).map((e) => (
            <p key={e} className="text-xs text-status-warm">
              {e}
            </p>
          ))}
          <div className="max-h-72 overflow-auto rounded-md border border-bg-border">
            <table className="w-full text-xs">
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i} className={r.duplicate ? "text-fg-dim line-through" : "text-fg"}>
                    <td className="px-2 py-1 tabular-nums">{r.postedDate}</td>
                    <td className="px-2 py-1">{r.description}</td>
                    <td className="px-2 py-1 text-fg-muted">{r.duplicate ? "already imported" : r.suggestedCategoryName || ""}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCents(r.amountCents, preview.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
