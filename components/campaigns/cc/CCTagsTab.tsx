"use client";

/**
 * CCTagsTab — manage Constant Contact tags: create, rename inline,
 * delete (inline confirm). Data: /api/campaigns/constant-contact/tags
 * (+ /tags/{id} for rename/delete). Table chrome lives in CCCrudTable.
 */

import { useCallback, useEffect, useState } from "react";
import { Tag } from "@/components/Card";
import { CCCrudTable, type CCCrudColumn } from "./CCCrudTable";

type Row = {
  id: string;
  name: string;
  count: number | null;
};

type RawTag = {
  tag_id?: string;
  name?: string;
  contacts_count?: number;
};

function normalize(raw: RawTag[]): Row[] {
  return raw.map((t) => ({
    id: String(t.tag_id ?? ""),
    name: t.name ?? "",
    count: t.contacts_count ?? null,
  }));
}

export function CCTagsTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/constant-contact/tags", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data?.message || data?.error || "Couldn't load tags.");
        return;
      }
      const raw = (data.tags || []) as RawTag[];
      setRows(normalize(raw));
    } catch {
      setError("Network error loading tags.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setNotice(null);
    try {
      const res = await fetch("/api/campaigns/constant-contact/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice({ kind: "err", text: data?.message || data?.error || "Couldn't create tag." });
        return;
      }
      setNewName("");
      setNotice({ kind: "ok", text: "Tag created." });
      await load();
    } catch {
      setNotice({ kind: "err", text: "Network error creating tag." });
    } finally {
      setCreating(false);
    }
  }, [newName, load]);

  const startEdit = useCallback((row: Row) => {
    setEditingId(row.id);
    setEditName(row.name);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditName("");
  }, []);

  const handleRename = useCallback(async (id: string) => {
    const name = editName.trim();
    if (!name) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/campaigns/constant-contact/tags/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice({ kind: "err", text: data?.message || data?.error || "Couldn't rename tag." });
        return;
      }
      setEditingId(null);
      setEditName("");
      setNotice({ kind: "ok", text: "Tag renamed." });
      await load();
    } catch {
      setNotice({ kind: "err", text: "Network error renaming tag." });
    } finally {
      setSaving(false);
    }
  }, [editName, load]);

  const handleDelete = useCallback(async (id: string) => {
    setDeleting(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/campaigns/constant-contact/tags/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice({ kind: "err", text: data?.message || data?.error || "Couldn't delete tag." });
        return;
      }
      setConfirmId(null);
      setNotice({ kind: "ok", text: "Tag deleted." });
      await load();
    } catch {
      setNotice({ kind: "err", text: "Network error deleting tag." });
    } finally {
      setDeleting(false);
    }
  }, [load]);

  const columns: CCCrudColumn<Row>[] = [
    {
      key: "name",
      header: "Name",
      render: (r) =>
        editingId === r.id ? (
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="input"
            autoFocus
          />
        ) : (
          <span className="truncate text-fg">{r.name || "(untitled)"}</span>
        ),
    },
    {
      key: "count",
      header: "Contacts",
      align: "right",
      render: (r) => (r.count == null ? <span className="text-fg-dim">—</span> : <Tag tone="accent">{r.count.toLocaleString()}</Tag>),
    },
  ];

  return (
    <CCCrudTable<Row>
      loading={loading}
      error={error}
      notice={notice}
      rows={rows}
      columns={columns}
      emptyMessage="No tags yet. Create one above to get started."
      onRefresh={() => void load()}
      renderCreate={
        <>
          <div className="w-64">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New tag name…"
              className="input"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating || !newName.trim()}
            className="btn-primary whitespace-nowrap"
          >
            {creating ? "Creating…" : "Create tag"}
          </button>
        </>
      }
      actions={{
        getId: (r) => r.id,
        onEditStart: startEdit,
        editingId,
        editValue: editName,
        onEditSave: (r) => void handleRename(r.id),
        onEditCancel: cancelEdit,
        saving,
        onDelete: (r) => void handleDelete(r.id),
        deleting,
        confirmId,
        setConfirmId,
      }}
    />
  );
}
