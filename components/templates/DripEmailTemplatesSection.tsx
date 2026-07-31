"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Eye, Loader2, Plus, Save, Sparkles, X } from "lucide-react";
import { Card, EmptyState, Tag } from "@/components/Card";

type DripTemplate = {
  id: string;
  label: string;
  category: string;
  subject: string;
  preheader: string;
  html: string;
};

const STYLES = ["Jordan direct", "Warm advisor", "Urgent document chase", "Concise follow-up", "Premium branded HTML"];

function agentHref(prompt: string) {
  return `/agent?agent=solara&prompt=${encodeURIComponent(prompt)}`;
}

export default function DripEmailTemplatesSection() {
  const [items, setItems] = useState<DripTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState<DripTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [stage, setStage] = useState("sent_application");
  const [style, setStyle] = useState(STYLES[0]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [html, setHtml] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/drip-templates", { cache: "no-store" });
      const json = await res.json();
      setItems(json.templates || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const createPrompt = useMemo(
    () =>
      [
        "Create a SunBiz merchant-cash-advance drip email template in Jordan's voice.",
        `Pipeline stage: ${stage}. Style: ${style}.`,
        "Jordan's voice is direct, human, commercially aware, and helpful without sounding automated or overpromising.",
        "Return: template name, subject, plain-text fallback, and responsive email-safe HTML.",
        "Preserve merge fields such as {{lead.first_name}}, {{lead.business_name}}, {{lead.application_url}}, and {{lead.rep_name}} where relevant.",
        "Application-stage messages must include {{lead.application_url}}. Do not send anything.",
        "After drafting, instruct the operator to paste/save the approved asset in Templates > Drip Templates.",
      ].join("\n"),
    [stage, style],
  );

  async function save() {
    if (!name.trim() || !subject.trim() || !body.trim()) {
      setNotice("Name, subject, and plain-text body are required.");
      return;
    }
    setSaving(true);
    setNotice("");
    try {
      const res = await fetch("/api/drip-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          category: `drip:${stage}:${style.toLowerCase().replaceAll(" ", "_")}`,
          subject,
          preheader: body,
          html,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "save_failed");
      setEditing(false);
      setName(""); setSubject(""); setBody(""); setHtml("");
      setNotice("Saved to the Drip Templates library.");
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "save_failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card
        title="Email drip sequence templates"
        subtitle="Reusable Jordan-style copy and HTML. Saved templates appear directly inside every sequence email-step editor."
        action={
          <div className="flex gap-2">
            <Link href={agentHref(createPrompt)} className="btn-secondary inline-flex items-center gap-1.5 text-xs">
              <Sparkles className="h-3.5 w-3.5" /> Create with Solara
            </Link>
            <button type="button" onClick={() => setEditing(true)} className="btn-primary inline-flex items-center gap-1.5 text-xs">
              <Plus className="h-3.5 w-3.5" /> New drip template
            </button>
          </div>
        }
      >
        {notice && <div className="mb-3 rounded-md border border-bg-border bg-bg-deep px-3 py-2 text-xs text-fg-muted">{notice}</div>}
        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>
        ) : items.length === 0 ? (
          <EmptyState message="No saved drip templates yet. Create one here or ask Solara for a Jordan-style asset." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => {
              const [, itemStage, itemStyle] = item.category.split(":");
              return (
                <article key={item.id} className="rounded-lg border border-bg-border bg-bg-deep/40 p-4">
                  <div className="flex flex-wrap gap-1.5">
                    <Tag tone="accent">{itemStage?.replaceAll("_", " ") || "drip"}</Tag>
                    <Tag tone="warm">{itemStyle?.replaceAll("_", " ") || "custom"}</Tag>
                    {item.html && <Tag tone="engaged">HTML</Tag>}
                  </div>
                  <h3 className="mt-3 text-sm font-bold text-fg">{item.label}</h3>
                  <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{item.subject}</p>
                  <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[11px] text-fg-dim">{item.preheader}</p>
                  <button type="button" onClick={() => setPreview(item)} className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-accent">
                    <Eye className="h-3.5 w-3.5" /> Preview
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </Card>

      {editing && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-bg-border bg-bg-panel p-5">
            <div className="flex items-center justify-between"><h2 className="font-bold text-fg">New drip template</h2><button onClick={() => setEditing(false)}><X className="h-4 w-4" /></button></div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="text-xs text-fg-muted">Name<input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label className="text-xs text-fg-muted">Pipeline stage<input className="input mt-1 w-full" value={stage} onChange={(e) => setStage(e.target.value)} /></label>
              <label className="text-xs text-fg-muted">Style<select className="select mt-1 w-full" value={style} onChange={(e) => setStyle(e.target.value)}>{STYLES.map((x) => <option key={x}>{x}</option>)}</select></label>
              <label className="text-xs text-fg-muted">Subject<input className="input mt-1 w-full" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
            </div>
            <label className="mt-3 block text-xs text-fg-muted">Plain-text fallback<textarea rows={7} className="textarea mt-1 w-full font-mono" value={body} onChange={(e) => setBody(e.target.value)} /></label>
            <label className="mt-3 block text-xs text-fg-muted">Optional HTML<textarea rows={12} className="textarea mt-1 w-full font-mono" value={html} onChange={(e) => setHtml(e.target.value)} /></label>
            <div className="mt-4 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setEditing(false)}>Cancel</button><button className="btn-primary inline-flex items-center gap-1.5" disabled={saving} onClick={save}><Save className="h-3.5 w-3.5" /> Save template</button></div>
          </div>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4" onClick={() => setPreview(null)}>
          <div className="max-h-[92vh] w-full max-w-4xl overflow-y-auto rounded-xl border border-bg-border bg-bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between"><div><h2 className="font-bold text-fg">{preview.label}</h2><p className="text-xs text-fg-muted">{preview.subject}</p></div><button onClick={() => setPreview(null)}><X className="h-4 w-4" /></button></div>
            {preview.html ? <iframe sandbox="" title="Drip template preview" srcDoc={preview.html} className="mt-4 h-[480px] w-full rounded-lg bg-white" /> : <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-bg-deep p-4 text-xs text-fg">{preview.preheader}</pre>}
          </div>
        </div>
      )}
    </div>
  );
}
