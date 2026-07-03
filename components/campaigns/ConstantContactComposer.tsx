"use client";

/**
 * ConstantContactComposer — the Email Blast composer shown once Constant Contact
 * is connected. Pick an audience (a SunBiz lead segment or an existing CC list),
 * a template (our SunBiz library, cold-outreach library, or a saved custom
 * template), edit the subject/preheader/body inline with a live preview, pick a
 * confirmed sender, schedule precisely (date + time + timezone), optionally A/B
 * test the subject line, and save the current draft as a reusable template.
 * Send a test to yourself, then launch. All sends run through the shared blast
 * core (suppression + blast-safety + dry-run gate). Data + actions:
 * /api/campaigns/constant-contact (+ /templates to save).
 */

import { useEffect, useState } from "react";
import { Loader2, FlaskConical, Rocket, Eye, Pencil, Save } from "lucide-react";

type Template = { source: "sunbiz" | "cold" | "custom"; id: string; label: string; category: string; subject: string; preheader?: string; html: string };

type ComposerData = {
  senders: { email: string; confirmed: boolean }[];
  cc_lists: { id: string; name: string; count: number }[];
  stages: { key: string; label: string }[];
  templates: {
    categories: { category: string; label: string }[];
    sunbiz: Template[];
    cold: Template[];
    custom: Template[];
  };
};

const input = "w-full text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5";
const btnSec = "rounded-md border border-bg-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50";
const btnPri = "rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50";
const label = "text-[11px] uppercase tracking-wide text-fg-dim";

const TZ_OPTIONS: { value: string; label: string }[] = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "UTC", label: "UTC" },
];

const AB_WAIT_OPTIONS = [6, 12, 24, 48] as const;

/** Convert a wall-clock date+time in an IANA timezone to a UTC ISO string. */
function zonedToUtcISO(dateStr: string, timeStr: string, tz: string): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  const asUTC = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(asUTC))
    .reduce((a: Record<string, string>, p) => { a[p.type] = p.value; return a; }, {});
  const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour === "24" ? "0" : parts.hour), Number(parts.minute));
  return new Date(asUTC - (shown - asUTC)).toISOString();
}

export function ConstantContactComposer() {
  const [data, setData] = useState<ComposerData | null>(null);
  const [loading, setLoading] = useState(true);

  const [audienceType, setAudienceType] = useState<"segment" | "cc_list">("segment");
  const [stage, setStage] = useState("");
  const [ccListId, setCcListId] = useState("");
  const [templateSource, setTemplateSource] = useState<"sunbiz" | "cold" | "custom">("sunbiz");
  const [templateId, setTemplateId] = useState("");
  const [subject, setSubject] = useState("");
  const [preheader, setPreheader] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [bodyView, setBodyView] = useState<"edit" | "preview">("edit");
  const [fromEmail, setFromEmail] = useState("");
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [tz, setTz] = useState("America/New_York");

  const [abEnabled, setAbEnabled] = useState(false);
  const [altSubject, setAltSubject] = useState("");
  const [abSize, setAbSize] = useState(20);
  const [abWait, setAbWait] = useState<number>(24);

  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [saveTemplateName, setSaveTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);

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

  function templatesFor(source: "sunbiz" | "cold" | "custom"): Template[] {
    if (!data) return [];
    return data.templates[source] || [];
  }

  function pickTemplate(source: "sunbiz" | "cold" | "custom", id: string) {
    setTemplateSource(source);
    setTemplateId(id);
    const t = templatesFor(source).find((x) => x.id === id);
    if (t) {
      setSubject(t.subject);
      setBodyHtml(t.html);
      setPreheader(t.preheader || "");
    }
  }

  const canSend =
    (!!templateId || !!bodyHtml.trim()) && !!subject.trim() && !!fromEmail && (audienceType === "segment" ? !!stage : !!ccListId);

  const scheduledIso = scheduleMode === "later" && date && time ? zonedToUtcISO(date, time, tz) : null;
  const tzLabel = TZ_OPTIONS.find((t) => t.value === tz)?.label || tz;

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
          template: templateId ? { source: templateSource, id: templateId } : undefined,
          subject,
          html: bodyHtml,
          preheader,
          from_email: fromEmail,
          scheduled_date: scheduleMode === "later" && date && time ? zonedToUtcISO(date, time, tz) : "now",
          ab_test: action === "launch" && abEnabled && altSubject.trim()
            ? { alternative_subject: altSubject, test_size: abSize, winner_wait_duration: abWait }
            : undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setNotice({ kind: "err", text: `${j.message || j.error || "failed"}${j.lender_hits ? ": " + j.lender_hits.join(", ") : ""}` });
        return;
      }
      if (j.dry_run) setNotice({ kind: "info", text: `Dry run — would send to ${j.would_send?.recipients ?? "?"}; live sending off for Constant Contact.` });
      else if (j.tested) setNotice({ kind: "ok", text: `Test sent to ${fromEmail}.` });
      else setNotice({ kind: "ok", text: `Blast launched to ${j.recipients ?? ""} recipient(s).` });
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setBusy("");
      setConfirming(false);
    }
  }

  async function saveAsTemplate() {
    const name = saveTemplateName.trim();
    if (!name) return;
    setSavingTemplate(true);
    setNotice(null);
    try {
      const r = await fetch("/api/campaigns/constant-contact/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, category: "custom", subject, preheader, html: bodyHtml }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) { setNotice({ kind: "err", text: j.message || j.error || "Couldn't save template." }); return; }
      setNotice({ kind: "ok", text: `Saved as template "${name}".` });
      setShowSaveTemplate(false);
      setSaveTemplateName("");
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setSavingTemplate(false);
    }
  }

  if (loading) return <div className="text-xs text-fg-dim italic py-4">Loading composer…</div>;
  if (!data) return <div className="text-xs text-status-warm py-4">Couldn&apos;t load composer data. Reload.</div>;

  const noConfirmedSender = data.senders.length > 0 && !data.senders.some((s) => s.confirmed);

  return (
    <div className="rounded-md border border-bg-border bg-bg-deep/20 p-3 space-y-3">
      <div className="text-[12px] font-semibold text-fg">New email blast</div>

      {/* 1. Audience */}
      <div className="space-y-1">
        <div className={label}>Audience</div>
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
          <select value={stage} onChange={(e) => setStage(e.target.value)} className={input}>
            <option value="">Pick a stage…</option>
            {data.stages.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        ) : (
          <select value={ccListId} onChange={(e) => setCcListId(e.target.value)} className={input}>
            <option value="">Pick a Constant Contact list…</option>
            {data.cc_lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({l.count})</option>
            ))}
          </select>
        )}
      </div>

      {/* 2. Template */}
      <div className="space-y-1">
        <div className={label}>Template</div>
        <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[11px]">
          {(["sunbiz", "cold", "custom"] as const).map((t, i) => (
            <button
              key={t}
              type="button"
              onClick={() => setTemplateSource(t)}
              className={`px-2.5 py-1 ${i > 0 ? "border-l border-bg-border" : ""} ${templateSource === t ? "bg-bg-elev text-fg" : "text-fg-muted"}`}
            >
              {t === "sunbiz" ? "SunBiz library" : t === "cold" ? "Cold-outreach" : "Saved"}
            </button>
          ))}
        </div>
        <select value={templateId} onChange={(e) => pickTemplate(templateSource, e.target.value)} className={input}>
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
            : templatesFor(templateSource).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </div>

      {/* Subject + preheader */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className={label}>Subject</div>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className={input} placeholder="Subject line" />
        </div>
        <div className="space-y-1">
          <div className={label}>Preheader (preview text)</div>
          <input value={preheader} onChange={(e) => setPreheader(e.target.value)} className={input} placeholder="Shown next to subject in the inbox" />
        </div>
      </div>

      {/* Body editor + live preview */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div className={label}>Body</div>
          <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[11px]">
            <button
              type="button"
              onClick={() => setBodyView("edit")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 ${bodyView === "edit" ? "bg-bg-elev text-fg" : "text-fg-muted"}`}
            >
              <Pencil className="h-3 w-3" /> Edit
            </button>
            <button
              type="button"
              onClick={() => setBodyView("preview")}
              className={`inline-flex items-center gap-1 px-2.5 py-1 border-l border-bg-border ${bodyView === "preview" ? "bg-bg-elev text-fg" : "text-fg-muted"}`}
            >
              <Eye className="h-3 w-3" /> Preview
            </button>
          </div>
        </div>
        {bodyView === "edit" ? (
          <textarea
            value={bodyHtml}
            onChange={(e) => setBodyHtml(e.target.value)}
            placeholder="HTML body…"
            className={`${input} h-64 font-mono resize-y`}
          />
        ) : (
          <iframe srcDoc={bodyHtml} title="preview" className="w-full h-64 rounded-md border border-bg-border bg-white" />
        )}
      </div>

      {/* 3. Sender + schedule */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="space-y-1">
          <div className={label}>From</div>
          <select value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} className={input}>
            {data.senders.length === 0 && <option value="">No senders</option>}
            {data.senders.map((s) => (
              <option key={s.email} value={s.email}>{s.email}{s.confirmed ? "" : " (unconfirmed)"}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <div className={label}>Schedule</div>
          <select value={scheduleMode} onChange={(e) => setScheduleMode(e.target.value as "now" | "later")} className={input}>
            <option value="now">Send now</option>
            <option value="later">Schedule</option>
          </select>
        </div>
      </div>

      {scheduleMode === "later" && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="space-y-1">
            <div className={label}>Date</div>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} />
          </div>
          <div className="space-y-1">
            <div className={label}>Time</div>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={input} />
          </div>
          <div className="space-y-1">
            <div className={label}>Timezone</div>
            <select value={tz} onChange={(e) => setTz(e.target.value)} className={input}>
              {TZ_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {date && time && scheduledIso && (
            <div className="sm:col-span-3 text-[11px] text-fg-dim">
              Sends {date} at {time} {tzLabel}
            </div>
          )}
        </div>
      )}

      {/* A/B subject test */}
      <div className="space-y-1.5">
        <label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
          <input type="checkbox" checked={abEnabled} onChange={(e) => setAbEnabled(e.target.checked)} />
          A/B test the subject line
        </label>
        {abEnabled && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-1 sm:col-span-1">
              <div className={label}>Alternative subject</div>
              <input value={altSubject} onChange={(e) => setAltSubject(e.target.value)} className={input} placeholder="Alternative subject line" />
            </div>
            <div className="space-y-1">
              <div className={label}>Test size %</div>
              <input
                type="number"
                min={5}
                max={50}
                value={abSize}
                onChange={(e) => setAbSize(Math.max(5, Math.min(50, Number(e.target.value) || 20)))}
                className={input}
              />
            </div>
            <div className="space-y-1">
              <div className={label}>Winner decided after</div>
              <select value={abWait} onChange={(e) => setAbWait(Number(e.target.value))} className={input}>
                {AB_WAIT_OPTIONS.map((h) => <option key={h} value={h}>{h} hours</option>)}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Save as template */}
      <div className="space-y-1.5">
        {!showSaveTemplate ? (
          <button type="button" className={btnSec} onClick={() => setShowSaveTemplate(true)}>
            <Save className="inline h-3.5 w-3.5 mr-1" /> Save as template
          </button>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={saveTemplateName}
              onChange={(e) => setSaveTemplateName(e.target.value)}
              placeholder="Template name"
              className={`${input} flex-1 min-w-[160px]`}
            />
            <button type="button" className={btnPri} disabled={savingTemplate || !saveTemplateName.trim()} onClick={() => void saveAsTemplate()}>
              {savingTemplate ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : "Save"}
            </button>
            <button type="button" className={btnSec} onClick={() => { setShowSaveTemplate(false); setSaveTemplateName(""); }}>Cancel</button>
          </div>
        )}
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
          onClick={() => void submit("test")}
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
            <button type="button" onClick={() => void submit("launch")} disabled={!!busy} className="font-semibold text-accent">
              {busy === "launch" ? "Launching…" : "Confirm"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="text-fg-dim">Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
