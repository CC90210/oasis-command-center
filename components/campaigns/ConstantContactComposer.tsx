"use client";

/**
 * ConstantContactComposer — the Email Blast composer shown once Constant Contact
 * is connected. Pick an audience (a SunBiz lead segment or an existing CC list),
 * a template (our library or cold-outreach), a confirmed sender, and a schedule;
 * send a test to yourself, then launch. All sends run through the shared blast
 * core (suppression + blast-safety + dry-run gate). Data + actions:
 * /api/campaigns/constant-contact.
 */

import { useEffect, useState } from "react";
import { Loader2, FlaskConical, Rocket } from "lucide-react";

type ComposerData = {
  senders: { email: string; confirmed: boolean }[];
  cc_lists: { id: string; name: string; count: number }[];
  stages: { key: string; label: string }[];
  templates: {
    categories: { category: string; label: string }[];
    sunbiz: { id: string; category: string; label: string; subject: string }[];
    cold: { id: string; label: string; subject: string }[];
  };
};

export function ConstantContactComposer() {
  const [data, setData] = useState<ComposerData | null>(null);
  const [loading, setLoading] = useState(true);

  const [audienceType, setAudienceType] = useState<"segment" | "cc_list">("segment");
  const [stage, setStage] = useState("");
  const [ccListId, setCcListId] = useState("");
  const [templateSource, setTemplateSource] = useState<"sunbiz" | "cold">("sunbiz");
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [scheduledDate, setScheduledDate] = useState("");

  const [busy, setBusy] = useState<"" | "test" | "launch">("");
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

  useEffect(() => {
    fetch("/api/campaigns/constant-contact", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: ComposerData & { ok?: boolean }) => {
        if (j.ok) {
          setData(j);
          const preferred = j.senders.find((s) => s.confirmed) || j.senders[0];
          if (preferred) setFromEmail(preferred.email);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function pickTemplate(source: "sunbiz" | "cold", id: string) {
    setTemplateSource(source);
    setTemplateId(id);
    const t = (source === "sunbiz" ? data?.templates.sunbiz : data?.templates.cold)?.find((x) => x.id === id);
    if (t) setSubject(t.subject);
  }

  const canSend =
    !!templateId && !!subject.trim() && !!fromEmail && (audienceType === "segment" ? !!stage : !!ccListId);

  async function submit(action: "test" | "launch") {
    setBusy(action);
    setNotice(null);
    try {
      const r = await fetch("/api/campaigns/constant-contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          audience: audienceType === "segment" ? { type: "segment", stage } : { type: "cc_list", list_id: ccListId },
          template: { source: templateSource, id: templateId },
          subject,
          from_email: fromEmail,
          scheduled_date: scheduleMode === "later" && scheduledDate ? new Date(scheduledDate).toISOString() : "now",
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setNotice({ kind: "err", text: `${j.message || j.error || "failed"}${j.lender_hits ? ": " + j.lender_hits.join(", ") : ""}` });
        return;
      }
      if (j.dry_run) setNotice({ kind: "info", text: `Dry run — would send to ${j.would_send?.recipients ?? "?"} recipient(s). Live sending is off (set LIVE_SEND_EMAIL=1 to enable).` });
      else if (j.tested) setNotice({ kind: "ok", text: `Test sent to ${fromEmail}. Check your inbox.` });
      else setNotice({ kind: "ok", text: `Blast launched to ${j.recipients ?? ""} recipient(s).` });
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setBusy("");
      setConfirming(false);
    }
  }

  if (loading) return <div className="text-xs text-fg-dim italic py-4">Loading composer…</div>;
  if (!data) return <div className="text-xs text-status-warm py-4">Couldn&apos;t load composer data. Reload.</div>;

  const noConfirmedSender = data.senders.length > 0 && !data.senders.some((s) => s.confirmed);
  const inputCls = "w-full text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5";
  const labelCls = "text-[11px] uppercase tracking-wide text-fg-dim";

  return (
    <div className="rounded-md border border-bg-border bg-bg-deep/20 p-3 space-y-3">
      <div className="text-[12px] font-semibold text-fg">New email blast</div>

      {/* 1. Audience */}
      <div className="space-y-1">
        <div className={labelCls}>Audience</div>
        <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[11px]">
          {(["segment", "cc_list"] as const).map((t, i) => (
            <button
              key={t}
              type="button"
              onClick={() => setAudienceType(t)}
              className={`px-2.5 py-1 ${i > 0 ? "border-l border-bg-border" : ""} ${audienceType === t ? "bg-bg-elev text-fg" : "text-fg-muted"}`}
            >
              {t === "segment" ? "SunBiz lead segment" : "Constant Contact list"}
            </button>
          ))}
        </div>
        {audienceType === "segment" ? (
          <select value={stage} onChange={(e) => setStage(e.target.value)} className={inputCls}>
            <option value="">Pick a stage…</option>
            {data.stages.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        ) : (
          <select value={ccListId} onChange={(e) => setCcListId(e.target.value)} className={inputCls}>
            <option value="">Pick a Constant Contact list…</option>
            {data.cc_lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({l.count})</option>
            ))}
          </select>
        )}
      </div>

      {/* 2. Template */}
      <div className="space-y-1">
        <div className={labelCls}>Template</div>
        <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[11px]">
          {(["sunbiz", "cold"] as const).map((t, i) => (
            <button
              key={t}
              type="button"
              onClick={() => setTemplateSource(t)}
              className={`px-2.5 py-1 ${i > 0 ? "border-l border-bg-border" : ""} ${templateSource === t ? "bg-bg-elev text-fg" : "text-fg-muted"}`}
            >
              {t === "sunbiz" ? "SunBiz library" : "Cold-outreach HTML"}
            </button>
          ))}
        </div>
        <select value={templateId} onChange={(e) => pickTemplate(templateSource, e.target.value)} className={inputCls}>
          <option value="">Pick a template…</option>
          {templateSource === "sunbiz"
            ? data.templates.categories.map((cat) => {
                const items = data.templates.sunbiz.filter((t) => t.category === cat.category);
                if (!items.length) return null;
                return (
                  <optgroup key={cat.category} label={cat.label}>
                    {items.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </optgroup>
                );
              })
            : data.templates.cold.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      {/* Subject */}
      <div className="space-y-1">
        <div className={labelCls}>Subject</div>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} placeholder="Subject line" />
      </div>

      {/* 3. Sender + schedule */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className={labelCls}>From</div>
          <select value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} className={inputCls}>
            {data.senders.length === 0 && <option value="">No senders</option>}
            {data.senders.map((s) => (
              <option key={s.email} value={s.email}>{s.email}{s.confirmed ? "" : " (unconfirmed)"}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <div className={labelCls}>Schedule</div>
          <div className="flex gap-1">
            <select value={scheduleMode} onChange={(e) => setScheduleMode(e.target.value as "now" | "later")} className={inputCls}>
              <option value="now">Send now</option>
              <option value="later">Later</option>
            </select>
            {scheduleMode === "later" && (
              <input type="datetime-local" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} className={inputCls} />
            )}
          </div>
        </div>
      </div>

      {noConfirmedSender && (
        <div className="text-[11px] text-status-warm">This account has no confirmed sender email — confirm one in Constant Contact before a real send.</div>
      )}
      {notice && (
        <div className={`text-[12px] rounded-md border px-2.5 py-1.5 ${notice.kind === "ok" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : notice.kind === "info" ? "border-status-warm/40 bg-status-warm/5 text-status-warm" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>
          {notice.text}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => submit("test")}
          disabled={!canSend || !!busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-bg-border px-3 py-1.5 text-[12px] font-semibold text-fg-muted hover:text-fg disabled:opacity-50"
        >
          {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
          Send test to me
        </button>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!canSend || !!busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50"
          >
            <Rocket className="h-3.5 w-3.5" /> Launch blast
          </button>
        ) : (
          <div className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[12px]">
            <span>Launch to the whole audience?</span>
            <button type="button" onClick={() => submit("launch")} disabled={!!busy} className="font-semibold text-accent">
              {busy === "launch" ? "Launching…" : "Confirm"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="text-fg-dim">Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
