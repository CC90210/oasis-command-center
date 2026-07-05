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
import { Loader2, FlaskConical, Rocket, Save } from "lucide-react";
import { EmptyState } from "@/components/Card";

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

type MeterZone = "engaged" | "warm" | "hot";

/** Green in sweet spot, amber approaching/over, red badly over/empty. */
function meterZone(length: number, sweetMin: number, sweetMax: number, hardMax: number): MeterZone {
  if (length === 0) return "warm";
  if (length > hardMax) return "hot";
  if (length >= sweetMin && length <= sweetMax) return "engaged";
  return "warm";
}

/** Thin length bar (not a "42/50" counter) with an optional tick at a hard cutoff. */
function LengthMeter({
  length,
  sweetMin,
  sweetMax,
  hardMax,
  tickAt,
  caption,
}: {
  length: number;
  sweetMin: number;
  sweetMax: number;
  hardMax: number;
  tickAt?: number;
  caption: string;
}) {
  const zone = meterZone(length, sweetMin, sweetMax, hardMax);
  const fill = zone === "engaged" ? "bg-status-engaged" : zone === "hot" ? "bg-status-hot" : "bg-status-warm";
  const pct = Math.max(length > 0 ? 2 : 0, Math.min(100, (length / hardMax) * 100));
  const tickPct = tickAt ? Math.min(100, (tickAt / hardMax) * 100) : null;
  return (
    <div className="space-y-1">
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-bg-elev">
        <div className={`absolute inset-y-0 left-0 rounded-full transition-all duration-150 ${fill}`} style={{ width: `${pct}%` }} />
        {tickPct != null && <div className="absolute inset-y-0 w-px bg-fg-dim/60" style={{ left: `${tickPct}%` }} aria-hidden="true" />}
      </div>
      <div className="text-[10px] text-fg-dim">{caption}</div>
    </div>
  );
}

function ComposerSkeleton() {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4" aria-busy="true" aria-live="polite">
      <div className="h-4 w-32 rounded-md bg-bg-elev animate-pulse-slow" />
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-2.5 w-20 rounded bg-bg-elev/70 animate-pulse-slow" style={{ animationDelay: `${i * 60}ms` }} />
              <div className="h-8 w-full rounded-md bg-bg-elev animate-pulse-slow" style={{ animationDelay: `${i * 60}ms` }} />
            </div>
          ))}
        </div>
        <div className="h-[520px] rounded-xl bg-bg-elev/60 animate-pulse-slow" />
      </div>
    </div>
  );
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
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
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
          from_name: fromName,
          reply_to: fromEmail,
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

  if (loading) return <ComposerSkeleton />;
  if (!data) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4">
        <EmptyState message="Couldn't load composer data. Reload the page to try again." />
      </div>
    );
  }

  const noConfirmedSender = data.senders.length > 0 && !data.senders.some((s) => s.confirmed);

  const noticeCls = notice
    ? notice.kind === "ok"
      ? "border-status-engaged/30 bg-status-engaged/5 text-status-engaged"
      : notice.kind === "info"
        ? "border-status-warm/40 bg-status-warm/5 text-status-warm"
        : "border-status-hot/40 bg-status-hot/10 text-status-hot"
    : "";

  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4 space-y-4">
      <div className="text-[12px] font-semibold text-fg">New email blast</div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: fields */}
        <div className="min-w-0 space-y-4">
          {/* 1. Audience */}
          <div className="space-y-1">
            <div className="label">Audience</div>
            <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[11px]">
              {(["segment", "cc_list"] as const).map((t, i) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAudienceType(t)}
                  className={`px-2.5 py-1 transition-colors duration-150 ${i > 0 ? "border-l border-bg-border" : ""} ${audienceType === t ? "bg-bg-elev text-fg" : "text-fg-muted hover:bg-bg-elev/40 hover:text-fg"}`}
                >
                  {t === "segment" ? "SunBiz lead segment" : "Constant Contact list"}
                </button>
              ))}
            </div>
            {audienceType === "segment" ? (
              <select value={stage} onChange={(e) => setStage(e.target.value)} className="select">
                <option value="">Pick a stage…</option>
                {data.stages.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            ) : (
              <select value={ccListId} onChange={(e) => setCcListId(e.target.value)} className="select">
                <option value="">Pick a Constant Contact list…</option>
                {data.cc_lists.map((l) => (
                  <option key={l.id} value={l.id}>{l.name} ({l.count})</option>
                ))}
              </select>
            )}
          </div>

          {/* 2. Template */}
          <div className="space-y-1">
            <div className="label">Template</div>
            <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[11px]">
              {(["sunbiz", "cold", "custom"] as const).map((t, i) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTemplateSource(t)}
                  className={`px-2.5 py-1 transition-colors duration-150 ${i > 0 ? "border-l border-bg-border" : ""} ${templateSource === t ? "bg-bg-elev text-fg" : "text-fg-muted hover:bg-bg-elev/40 hover:text-fg"}`}
                >
                  {t === "sunbiz" ? "SunBiz library" : t === "cold" ? "Cold-outreach" : "Saved"}
                </button>
              ))}
            </div>
            <select value={templateId} onChange={(e) => pickTemplate(templateSource, e.target.value)} className="select">
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

          {/* Subject + preheader with sweet-spot meters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <div className="label">Subject</div>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="input" placeholder="Subject line" />
              <LengthMeter
                length={subject.length}
                sweetMin={28}
                sweetMax={50}
                hardMax={78}
                tickAt={40}
                caption="Sweet spot 28-50 · mobile cuts near 40"
              />
            </div>
            <div className="space-y-1.5">
              <div className="label">Preheader (preview text)</div>
              <input value={preheader} onChange={(e) => setPreheader(e.target.value)} className="input" placeholder="Shown next to subject in the inbox" />
              <LengthMeter
                length={preheader.length}
                sweetMin={65}
                sweetMax={85}
                hardMax={140}
                caption="Aim for about 75 characters"
              />
            </div>
          </div>

          {/* Body editor (live preview lives in the sticky panel on the right) */}
          <div className="space-y-1">
            <div className="label">Body</div>
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              placeholder="HTML body…"
              className="textarea h-64 font-mono text-[12px] resize-y"
            />
          </div>

          {/* 3. Sender + schedule */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <div className="label">From</div>
              <select value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} className="select">
                {data.senders.length === 0 && <option value="">No senders</option>}
                {data.senders.map((s) => (
                  <option key={s.email} value={s.email}>{s.email}{s.confirmed ? "" : " (unconfirmed)"}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <div className="label">From name</div>
              <input value={fromName} onChange={(e) => setFromName(e.target.value)} className="input" placeholder="Display name" />
            </div>
            <div className="space-y-1">
              <div className="label">Schedule</div>
              <select value={scheduleMode} onChange={(e) => setScheduleMode(e.target.value as "now" | "later")} className="select">
                <option value="now">Send now</option>
                <option value="later">Schedule</option>
              </select>
            </div>
          </div>

          {scheduleMode === "later" && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <div className="label">Date</div>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input" />
              </div>
              <div className="space-y-1">
                <div className="label">Time</div>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="input" />
              </div>
              <div className="space-y-1">
                <div className="label">Timezone</div>
                <select value={tz} onChange={(e) => setTz(e.target.value)} className="select">
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
          <div className="space-y-2">
            <label className="flex items-center gap-1.5 text-[12px] text-fg-muted">
              <input type="checkbox" checked={abEnabled} onChange={(e) => setAbEnabled(e.target.checked)} />
              A/B test the subject line
            </label>
            {abEnabled && (
              <div className="space-y-3 rounded-xl border border-bg-border bg-bg-panel/40 p-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="label">Variant A — subject</div>
                    <div className="input truncate text-fg-muted">{subject || "—"}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="label">Variant B — alternative</div>
                    <input value={altSubject} onChange={(e) => setAltSubject(e.target.value)} className="input" placeholder="Alternative subject line" />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <div className="label flex items-center justify-between">
                      <span>Test size</span>
                      <span className="tabular-nums text-fg">{abSize}%</span>
                    </div>
                    <input
                      type="range"
                      min={5}
                      max={50}
                      value={abSize}
                      onChange={(e) => setAbSize(Number(e.target.value))}
                      className="w-full accent-accent"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="label">Winner decided after</div>
                    <select value={abWait} onChange={(e) => setAbWait(Number(e.target.value))} className="select">
                      {AB_WAIT_OPTIONS.map((h) => <option key={h} value={h}>{h} hours</option>)}
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Save as template */}
          <div className="space-y-1.5">
            {!showSaveTemplate ? (
              <button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={() => setShowSaveTemplate(true)}>
                <Save className="h-3.5 w-3.5" /> Save as template
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={saveTemplateName}
                  onChange={(e) => setSaveTemplateName(e.target.value)}
                  placeholder="Template name"
                  className="input flex-1 min-w-[160px]"
                />
                <button type="button" className="btn-primary" disabled={savingTemplate || !saveTemplateName.trim()} onClick={() => void saveAsTemplate()}>
                  {savingTemplate ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : "Save"}
                </button>
                <button type="button" className="btn-secondary" onClick={() => { setShowSaveTemplate(false); setSaveTemplateName(""); }}>Cancel</button>
              </div>
            )}
          </div>
        </div>

        {/* Right: sticky live preview */}
        <div className="lg:sticky lg:top-4 h-fit">
          <div className="rounded-t-xl border border-b-0 border-bg-border bg-bg-panel/60 px-4 py-3">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-fg-dim">
              <span className="h-1.5 w-1.5 rounded-full bg-accent/70" aria-hidden="true" />
              Inbox preview
            </div>
            <div className="truncate text-[12px] font-medium text-fg-muted">{fromName || fromEmail || "Sender"}</div>
            <div className="mt-0.5 truncate text-[13px]">
              <span className="font-semibold text-fg">{subject || "(no subject)"}</span>
              {preheader && <span className="text-fg-dim"> — {preheader}</span>}
            </div>
          </div>
          <iframe srcDoc={bodyHtml} title="Email body preview" className="h-[520px] w-full rounded-b-xl border border-t-0 border-bg-border bg-white" />
        </div>
      </div>

      {noConfirmedSender && (
        <div className="text-[11px] text-status-warm">This account has no confirmed sender email — confirm one in Constant Contact before a real send.</div>
      )}
      {notice && (
        <div className={`text-[12px] rounded-md border px-2.5 py-1.5 ${noticeCls}`}>
          {notice.text}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void submit("test")}
          disabled={!canSend || !!busy}
          className="btn-secondary inline-flex items-center gap-1.5"
        >
          {busy === "test" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
          Send test to me
        </button>
        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={!canSend || !!busy}
            className="btn-primary inline-flex items-center gap-1.5"
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
