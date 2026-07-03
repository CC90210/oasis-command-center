"use client";

/**
 * CCTagsTab — manage Constant Contact tags: create, rename inline,
 * delete (inline confirm). Data: /api/campaigns/constant-contact/tags
 * (+ /tags/{id} for rename/delete).
 */

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState } from "@/components/Card";

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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New tag name…"
          className="text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5 w-64"
        />
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creating || !newName.trim()}
          className="rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create tag"}
        </button>
        <button type="button" onClick={() => void load()} className="text-[11px] text-fg-dim underline hover:text-fg-muted ml-auto">Refresh</button>
      </div>

      {notice && (
        <div className={`text-[12px] ${notice.kind === "ok" ? "text-fg-muted" : "text-status-warm"}`}>{notice.text}</div>
      )}

      {loading ? (
        <Card noPadding><div className="p-6 text-sm text-fg-dim italic">Loading tags…</div></Card>
      ) : error ? (
        <Card><div className="text-sm text-status-warm">{error}</div></Card>
      ) : rows.length === 0 ? (
        <Card noPadding><EmptyState message="No tags yet. Create one above to get started." /></Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-fg-dim border-b border-bg-border">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium text-right">Contacts</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/30">
                    <td className="px-4 py-2.5 text-fg max-w-[320px]">
                      {editingId === r.id ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5 w-full"
                          autoFocus
                        />
                      ) : (
                        <span className="truncate">{r.name || "(untitled)"}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{r.count == null ? "—" : r.count}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {editingId === r.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleRename(r.id)}
                              disabled={saving || !editName.trim()}
                              className="rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50"
                            >
                              {saving ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              disabled={saving}
                              className="rounded-md border border-bg-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </>
                        ) : confirmId === r.id ? (
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
                          <>
                            <button
                              type="button"
                              onClick={() => startEdit(r)}
                              className="rounded-md border border-bg-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg"
                              aria-label="Edit tag name"
                              title="Edit"
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmId(r.id)}
                              className="rounded-md border border-bg-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg"
                            >
                              Delete
                            </button>
                          </>
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
