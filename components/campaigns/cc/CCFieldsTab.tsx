"use client";

/**
 * CCFieldsTab — manage Constant Contact custom fields: create (label + type),
 * delete (inline confirm). No rename in this UI — CC custom fields aren't
 * renamed here. Data: /api/campaigns/constant-contact/custom-fields
 * (+ /custom-fields/{id} for delete). Table chrome lives in CCCrudTable.
 */

import { useCallback, useEffect, useState } from "react";
import { CCCrudTable, type CCCrudColumn } from "./CCCrudTable";

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

  const columns: CCCrudColumn<Row>[] = [
    {
      key: "label",
      header: "Label",
      render: (r) => <span className="truncate text-fg">{r.label || "(untitled)"}</span>,
    },
    {
      key: "type",
      header: "Type",
      render: (r) => <span className="text-fg-muted">{r.type || "—"}</span>,
    },
  ];

  return (
    <CCCrudTable<Row>
      loading={loading}
      error={error}
      notice={notice}
      rows={rows}
      columns={columns}
      emptyMessage="No custom fields yet. Add one above to get started."
      onRefresh={() => void load()}
      renderCreate={
        <>
          <div className="w-64">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="New field label…"
              className="input"
            />
          </div>
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as FieldType)}
            className="select w-auto"
          >
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !newLabel.trim()}
            className="btn-primary whitespace-nowrap"
          >
            {creating ? "Adding…" : "Add field"}
          </button>
        </>
      }
      actions={{
        getId: (r) => r.id,
        onDelete: (r) => void handleDelete(r.id),
        deleting,
        confirmId,
        setConfirmId,
      }}
    />
  );
}
