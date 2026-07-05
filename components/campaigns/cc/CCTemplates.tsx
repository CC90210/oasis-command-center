"use client";

/**
 * CCTemplates — saved reusable email templates gallery + editor, plus a
 * read-only view of the code-owned SunBiz + cold-outreach libraries with a
 * "duplicate to saved" action. Talks to /api/campaigns/constant-contact/templates[/id].
 */

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState, Tag } from "@/components/Card";
import { Loader2, Plus, Trash2, Copy, Pencil } from "lucide-react";

type Template = { source: "sunbiz" | "cold" | "custom"; id: string; label: string; category: string; subject: string; preheader?: string; html: string };

type TemplatesData = { sunbiz: Template[]; cold: Template[]; custom: Template[] };

type EditorState = {
  id: string | null; // null = new
  name: string;
  subject: string;
  preheader: string;
  html: string;
};

/** Content-shaped shimmer standing in for one TemplateCard while data loads. */
function SkeletonCard({ delay = 0 }: { delay?: number }) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel/40 overflow-hidden">
      <div className="h-28 bg-bg-elev animate-pulse-slow" style={{ animationDelay: `${delay}ms` }} />
      <div className="p-3 space-y-2">
        <div className="h-3 w-2/3 rounded bg-bg-elev animate-pulse-slow" style={{ animationDelay: `${delay}ms` }} />
        <div className="h-2.5 w-1/2 rounded bg-bg-elev/60 animate-pulse-slow" style={{ animationDelay: `${delay}ms` }} />
      </div>
    </div>
  );
}

function SkeletonGrid({ count = 3 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} delay={i * 60} />
      ))}
    </div>
  );
}

/** One repeated card primitive for both Saved and Library templates: iframe
 *  thumbnail + name + subject + category tag, with a hover overlay exposing
 *  whichever quick action(s) apply (Edit for saved, Duplicate for library). */
function TemplateCard({
  t,
  onEdit,
  onDuplicate,
  duplicating = false,
}: {
  t: Template;
  onEdit?: () => void;
  onDuplicate?: () => void;
  duplicating?: boolean;
}) {
  const interactive = Boolean(onEdit);
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onEdit : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onEdit?.(); }
            }
          : undefined
      }
      className={`group relative rounded-xl border border-bg-border bg-bg-panel/40 overflow-hidden transition-colors duration-150 hover:border-accent/40 hover:bg-bg-elev/40 ${interactive ? "cursor-pointer" : ""}`}
    >
      <div className="relative h-28 overflow-hidden border-b border-bg-border/60 bg-white">
        <iframe
          srcDoc={t.html || "<html></html>"}
          title={`${t.label} preview`}
          className="pointer-events-none w-[400%] h-[400%] origin-top-left scale-[0.25]"
        />
        {(onEdit || onDuplicate) && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-bg-deep/80 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            {onEdit && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                className="btn-secondary inline-flex items-center gap-1 !px-2 !py-1 !text-[11px]"
              >
                <Pencil className="h-3 w-3" /> Edit
              </button>
            )}
            {onDuplicate && (
              <button
                type="button"
                disabled={duplicating}
                onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
                className="btn-secondary inline-flex items-center gap-1 !px-2 !py-1 !text-[11px]"
              >
                {duplicating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />} Duplicate
              </button>
            )}
          </div>
        )}
      </div>
      <div className="p-3 space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[12px] font-semibold text-fg truncate">{t.label}</div>
          <Tag tone="neutral">{t.category || t.source}</Tag>
        </div>
        <div className="text-[11px] text-fg-muted truncate">{t.subject || "(no subject)"}</div>
      </div>
    </div>
  );
}

export function CCTemplates() {
  const [data, setData] = useState<TemplatesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState("");

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bodyView, setBodyView] = useState<"edit" | "preview">("edit");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/constant-contact/templates", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j?.message || j?.error || "Couldn't load templates."); return; }
      setData({ sunbiz: j.sunbiz || [], cold: j.cold || [], custom: j.custom || [] });
    } catch {
      setError("Network error loading templates.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openNew() {
    setEditor({ id: null, name: "", subject: "", preheader: "", html: "" });
    setBodyView("edit");
    setConfirmDelete(false);
    setNotice(null);
  }

  function openExisting(t: Template) {
    setEditor({ id: t.id, name: t.label, subject: t.subject, preheader: t.preheader || "", html: t.html });
    setBodyView("edit");
    setConfirmDelete(false);
    setNotice(null);
  }

  async function saveEditor() {
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) return;
    setBusy("save");
    setNotice(null);
    try {
      const body = { name, category: "custom", subject: editor.subject, preheader: editor.preheader, html: editor.html };
      const url = editor.id
        ? `/api/campaigns/constant-contact/templates/${encodeURIComponent(editor.id)}`
        : "/api/campaigns/constant-contact/templates";
      const method = editor.id ? "PUT" : "POST";
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.ok) { setNotice({ kind: "err", text: j.message || j.error || "Couldn't save template." }); return; }
      setNotice({ kind: "ok", text: "Template saved." });
      setEditor(null);
      void load();
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setBusy("");
    }
  }

  async function deleteEditor() {
    if (!editor?.id) return;
    setBusy("delete");
    setNotice(null);
    try {
      const r = await fetch(`/api/campaigns/constant-contact/templates/${encodeURIComponent(editor.id)}`, { method: "DELETE" });
      const j = await r.json();
      if (!r.ok || !j.ok) { setNotice({ kind: "err", text: j.message || j.error || "Couldn't delete template." }); return; }
      setNotice({ kind: "ok", text: "Template deleted." });
      setEditor(null);
      setConfirmDelete(false);
      void load();
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setBusy("");
    }
  }

  async function duplicateToSaved(t: Template) {
    setBusy(`dup-${t.id}`);
    setNotice(null);
    try {
      const r = await fetch("/api/campaigns/constant-contact/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `${t.label} (copy)`, category: "custom", subject: t.subject, preheader: t.preheader || "", html: t.html }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setNotice({ kind: "err", text: j.message || j.error || "Couldn't duplicate template." }); return; }
      setNotice({ kind: "ok", text: `Duplicated "${t.label}" to Saved templates.` });
      void load();
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <Card title="Saved templates"><SkeletonGrid count={3} /></Card>
        <Card title="Library" subtitle="Read-only — duplicate to Saved templates to customize.">
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="h-3 w-24 rounded bg-bg-elev animate-pulse-slow" />
              <SkeletonGrid count={3} />
            </div>
            <div className="space-y-2">
              <div className="h-3 w-24 rounded bg-bg-elev animate-pulse-slow" />
              <SkeletonGrid count={3} />
            </div>
          </div>
        </Card>
      </div>
    );
  }
  if (error) {
    return <Card><div className="text-sm text-status-warm">{error}</div></Card>;
  }
  if (!data) return null;

  return (
    <div className="space-y-4">
      {notice && (
        <div className={`text-[12px] rounded-md border px-2.5 py-1.5 ${notice.kind === "ok" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>{notice.text}</div>
      )}

      <Card
        title="Saved templates"
        action={<button type="button" className="btn-primary inline-flex items-center gap-1" onClick={openNew}><Plus className="h-3.5 w-3.5" /> New template</button>}
      >
        {data.custom.length === 0 ? (
          <EmptyState message="No saved templates yet. Create one, or duplicate a library template below." />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.custom.map((t) => (
              <TemplateCard key={t.id} t={t} onEdit={() => openExisting(t)} />
            ))}
          </div>
        )}
      </Card>

      {editor && (
        <Card
          title={editor.id ? "Edit template" : "New template"}
          action={<button type="button" onClick={() => setEditor(null)} className="text-fg-dim hover:text-fg text-[12px]">Close</button>}
        >
          <div className="space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <div className="label">Name</div>
                <input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} className="input" placeholder="Template name" />
              </div>
              <div className="space-y-1">
                <div className="label">Subject</div>
                <input value={editor.subject} onChange={(e) => setEditor({ ...editor, subject: e.target.value })} className="input" placeholder="Subject line" />
              </div>
              <div className="space-y-1">
                <div className="label">Preheader</div>
                <input value={editor.preheader} onChange={(e) => setEditor({ ...editor, preheader: e.target.value })} className="input" placeholder="Preview text" />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="label">Body</div>
                <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[11px]">
                  <button type="button" onClick={() => setBodyView("edit")} className={`px-2.5 py-1 ${bodyView === "edit" ? "bg-bg-elev text-fg" : "text-fg-muted"}`}>Edit</button>
                  <button type="button" onClick={() => setBodyView("preview")} className={`px-2.5 py-1 border-l border-bg-border ${bodyView === "preview" ? "bg-bg-elev text-fg" : "text-fg-muted"}`}>Preview</button>
                </div>
              </div>
              {bodyView === "edit" ? (
                <textarea
                  value={editor.html}
                  onChange={(e) => setEditor({ ...editor, html: e.target.value })}
                  placeholder="HTML body…"
                  className="textarea h-64 font-mono resize-y"
                />
              ) : (
                <iframe srcDoc={editor.html} title="preview" className="w-full h-64 rounded-md border border-bg-border bg-white" />
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button type="button" className="btn-primary" disabled={busy === "save" || !editor.name.trim()} onClick={() => void saveEditor()}>
                {busy === "save" ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : "Save"}
              </button>
              {editor.id && !confirmDelete && (
                <button type="button" className="btn-danger inline-flex items-center gap-1" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              )}
              {editor.id && confirmDelete && (
                <div className="inline-flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[12px]">
                  <span>Delete this template?</span>
                  <button type="button" disabled={busy === "delete"} onClick={() => void deleteEditor()} className="font-semibold text-red-300">
                    {busy === "delete" ? "Deleting…" : "Confirm"}
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="text-fg-dim">Cancel</button>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card title="Library" subtitle="Read-only — duplicate to Saved templates to customize.">
        <div className="space-y-4">
          {(["sunbiz", "cold"] as const).map((source) => (
            <div key={source} className="space-y-2">
              <div className="label">{source === "sunbiz" ? "SunBiz library" : "Cold-outreach"}</div>
              {data[source].length === 0 ? (
                <div className="text-[12px] text-fg-dim">None.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {data[source].map((t) => (
                    <TemplateCard key={t.id} t={t} onDuplicate={() => void duplicateToSaved(t)} duplicating={busy === `dup-${t.id}`} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
