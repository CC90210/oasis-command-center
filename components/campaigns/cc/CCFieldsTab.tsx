"use client";

/**
 * CCFieldsTab — manage Constant Contact custom fields: create (label + type),
 * delete (inline confirm). No rename in this UI — CC custom fields aren't
 * renamed here. Data: /api/campaigns/constant-contact/custom-fields
 * (+ /custom-fields/{id} for delete).
 */

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState } from "@/components/Card";

type FieldType = "string" | "date";

type Row = {
  id: string;
  label: string;
  type: string;
};

type RawField = {
  custom_field_id?: string;
  label?: string;
  type?: string;
  name?: string;
};

function normalize(raw: RawField[]): Row[] {
  return raw.map((c) => ({
    id: String(c.custom_field_id ?? ""),
    label: c.label ?? "",
    type: c.type ?? "",
  }));
}

const TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: "string", label: "Text" },
  { value: "date", label: "Date" },
];

export function CCFieldsTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState<FieldType>("string");
  const [creating, setCreating] = useState(false);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/constant-contact/custom-fields", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data?.message || data?.error || "Couldn't load custom fields.");
        return;
      }
      const raw = (data.custom_fields || []) as RawField[];
      setRows(normalize(raw));
    } catch {
      setError("Network error loading custom fields.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = useCallback(async () => {
    const label = newLabel.trim();
    if (!label) return;
    setCreating(true);
    setNotice(null);
    try {
      const res = await fetch("/api/campaigns/constant-contact/custom-fields", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, type: newType }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice({ kind: "err", text: data?.message || data?.error || "Couldn't add field." });
        return;
      }
      setNewLabel("");
      setNewType("string");
      setNotice({ kind: "ok", text: "Field added." });
      await load();
    } catch {
      setNotice({ kind: "err", text: "Network error adding field." });
    } finally {
      setCreating(false);
    }
  }, [newLabel, newType, load]);

  const handleDelete = useCallback(async (id: string) => {
    setDeleting(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/campaigns/constant-contact/custom-fields/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice({ kind: "err", text: data?.message || data?.error || "Couldn't delete field." });
        return;
      }
      setConfirmId(null);
      setNotice({ kind: "ok", text: "Field deleted." });
      await load();
    } catch {
      setNotice({ kind: "err", text: "Network error deleting field." });
    } finally {
      setDeleting(false);
    }
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="New field label…"
          className="text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5 w-64"
        />
        <select
          value={newType}
          onChange={(e) => setNewType(e.target.value as FieldType)}
          className="text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5"
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !newLabel.trim()}
          className="rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50"
        >
          {creating ? "Adding…" : "Add field"}
        </button>
        <button type="button" onClick={() => void load()} className="text-[11px] text-fg-dim underline hover:text-fg-muted ml-auto">Refresh</button>
      </div>

      {notice && (
        <div className={`text-[12px] ${notice.kind === "ok" ? "text-fg-muted" : "text-status-warm"}`}>{notice.text}</div>
      )}

      {loading ? (
        <Card noPadding><div className="p-6 text-sm text-fg-dim italic">Loading custom fields…</div></Card>
      ) : error ? (
        <Card><div className="text-sm text-status-warm">{error}</div></Card>
      ) : rows.length === 0 ? (
        <Card noPadding><EmptyState message="No custom fields yet. Add one above to get started." /></Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-fg-dim border-b border-bg-border">
                  <th className="px-4 py-2.5 font-medium">Label</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/30">
                    <td className="px-4 py-2.5 text-fg max-w-[320px] truncate">{r.label || "(untitled)"}</td>
                    <td className="px-4 py-2.5 text-fg-muted">{r.type || "—"}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {confirmId === r.id ? (
                          <>
                            <span className="text-[12px] text-status-warm mr-1">Delete?</span>
                            <button
                              type="button"
                              onClick={() => void handleDelete(r.id)}
                              disabled={deleting}
                              className="rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50"
                            >
                              {deleting ? "Deleting…" : "Confirm"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmId(null)}
                              disabled={deleting}
                              className="rounded-md border border-bg-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmId(r.id)}
                            className="rounded-md border border-bg-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
