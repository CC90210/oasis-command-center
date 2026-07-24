"use client";

/**
 * SequenceBuilderClient — structured editor + token-reference helper
 * for /sequences/[id]/edit (Phase 4.4 of SunBiz CRM).
 *
 * Left pane: structured editors for trigger filter + steps (one card
 * per step, with channel, subject, body, delay). Right pane: token
 * reference showing every {{path}} the steps body uses.
 *
 * The internal data model still uses the serialized JSON strings as
 * source of truth (stepsJson / filterJson) — structured editors write
 * back via setStepsJson / setFilterJson on every change. This lets us
 * keep the same parseDripSteps / parseDripTriggerFilter validation
 * pipeline regardless of how the operator edited.
 *
 * 2026-05-19 turnkey pass: dropped the Simple / Advanced (raw JSON)
 * toggles entirely. Structured editing is the only surface.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2, Save, Trash2, Plus, X, MessageSquare, Mail, Sparkles, BookOpen } from "lucide-react";
import {
  parseDripSteps,
  parseDripTriggerFilter,
  DripDefinitionError,
  type DripStep,
  type DripTriggerFilter,
} from "@/lib/drips/types";
import { extractTokens } from "@/lib/drips/templates";
import {
  SUNBIZ_EMAIL_TEMPLATES,
  SUNBIZ_TEMPLATE_CATEGORIES,
} from "@/lib/sunbiz-templates-library";

type SequenceRecord = {
  id: string;
  name: string;
  description: string | null;
  trigger_event: string;
  trigger_filter: DripTriggerFilter;
  steps: DripStep[];
  enabled: boolean;
  one_per_lead: boolean;
  email_class?: string;
};

type Props = {
  initialSequence: SequenceRecord;
};

export function SequenceBuilderClient({ initialSequence }: Props) {
  const router = useRouter();

  const [name, setName] = useState(initialSequence.name);
  const [description, setDescription] = useState(initialSequence.description || "");
  const [enabled, setEnabled] = useState(initialSequence.enabled);
  const [onePerLead, setOnePerLead] = useState(initialSequence.one_per_lead);
  const [emailClass, setEmailClass] = useState(initialSequence.email_class || "commercial");
  const [triggerEvent, setTriggerEvent] = useState(initialSequence.trigger_event);
  // Serialized JSON strings remain the source of truth feeding the
  // `parsed` memo below. The structured StepsEditor + FilterEditor
  // sub-components write back through setStepsJson / setFilterJson
  // on every edit — same validation pipeline as before, no raw-JSON
  // textarea surface (2026-05-19 turnkey pass).
  const [stepsJson, setStepsJson] = useState(() =>
    JSON.stringify(initialSequence.steps, null, 2),
  );
  const [filterJson, setFilterJson] = useState(() =>
    JSON.stringify(initialSequence.trigger_filter, null, 2),
  );

  type ParseState = {
    steps: DripStep[] | null;
    filter: DripTriggerFilter | null;
    error: { path: string; reason: string } | null;
  };

  const parsed: ParseState = useMemo(() => {
    try {
      const steps = parseDripSteps(JSON.parse(stepsJson));
      const filter = parseDripTriggerFilter(JSON.parse(filterJson));
      return { steps, filter, error: null };
    } catch (err) {
      if (err instanceof DripDefinitionError) {
        return {
          steps: null,
          filter: null,
          error: { path: err.path, reason: err.reason },
        };
      }
      if (err instanceof SyntaxError) {
        return {
          steps: null,
          filter: null,
          error: { path: "$", reason: `invalid JSON: ${err.message}` },
        };
      }
      throw err;
    }
  }, [stepsJson, filterJson]);

  const referencedTokens = useMemo(() => {
    if (!parsed.steps) return [];
    const tokens = new Set<string>();
    for (const step of parsed.steps) {
      for (const t of extractTokens(step.body || "")) tokens.add(t);
      if (step.body_html) {
        for (const t of extractTokens(step.body_html)) tokens.add(t);
      }
      if (step.subject) {
        for (const t of extractTokens(step.subject)) tokens.add(t);
      }
    }
    return Array.from(tokens).sort();
  }, [parsed.steps]);

  // Hint resolution — common token roots the daemon will resolve:
  //   lead.*  → from tenant_records lead row's data jsonb
  //   event.* → from the triggering event's payload
  const tokenHint = (token: string): string => {
    if (token.startsWith("lead.")) {
      return "Resolves from the lead row in tenant_records.data.";
    }
    if (token.startsWith("event.")) {
      return "Resolves from the triggering event payload.";
    }
    return "Unknown root — will render as empty string unless added to context.";
  };

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<
    null | { kind: "ok" | "err"; text: string }
  >(null);
  // Set when the server rejected a save for removing merge fields — renders a
  // deliberate second-step "remove anyway" button (STOP-line removal has no
  // such override).
  const [tokenOverrideOffer, setTokenOverrideOffer] = useState<string[] | null>(null);

  async function save(allowTokenRemoval = false) {
    if (parsed.error) {
      setSaveMessage({
        kind: "err",
        text: `Fix the definition first — ${parsed.error.path}: ${parsed.error.reason}`,
      });
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    setTokenOverrideOffer(null);
    try {
      const res = await fetch(`/api/sequences/${initialSequence.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          trigger_event: triggerEvent,
          trigger_filter: parsed.filter,
          steps: parsed.steps,
          enabled,
          one_per_lead: onePerLead,
          email_class: emailClass,
          ...(allowTokenRemoval ? { allowTokenRemoval: true } : {}),
        }),
      });
      const data = (await res.json()) as {
        ok: boolean; error?: string; path?: string; reason?: string; message?: string; detail?: string[];
      };
      if (!data.ok) {
        if (data.error === "tokens_dropped") setTokenOverrideOffer(data.detail || []);
        setSaveMessage({
          kind: "err",
          text: data.message
            ? data.message
            : data.path && data.reason
              ? `Save failed — ${data.path}: ${data.reason}`
              : `Save failed: ${data.error || `http_${res.status}`}`,
        });
        return;
      }
      setSaveMessage({ kind: "ok", text: "Saved. Returning to sequences…" });
      // Bounce back to the list with a flash — consistent with the
      // forms editor pattern. Matches what Delete already does below.
      router.refresh();
      router.push("/sequences?saved=1");
    } catch (err) {
      setSaveMessage({
        kind: "err",
        text: `Network error: ${err instanceof Error ? err.message : "unknown"}`,
      });
    } finally {
      setSaving(false);
    }
  }

  async function destroy() {
    if (
      !confirm(
        `Delete sequence "${name}"? In-flight enrollments will be cancelled too. This can't be undone.`,
      )
    )
      return;
    const res = await fetch(`/api/sequences/${initialSequence.id}`, { method: "DELETE" });
    if (res.ok) {
      // router.push alone re-uses the RSC cache for /sequences and the
      // just-deleted row reappears (Next.js 15 router-cache behavior).
      // router.refresh() invalidates the cached server-component output
      // so the list re-fetches from Supabase.
      router.refresh();
      router.push("/sequences");
    } else {
      const data = await res.json().catch(() => ({}));
      setSaveMessage({
        kind: "err",
        text: `Delete failed: ${data.error || `http_${res.status}`}`,
      });
    }
  }

  // In-flight state snapshot — fetched once on mount so the operator
  // can see how many leads are currently enrolled. Live updates would
  // require SSE which is overkill for a Phase 4 ship.
  type StateRow = {
    id: string;
    lead_id: string;
    step_index: number;
    scheduled_for: string;
    status: string;
    last_error: string | null;
  };
  const [stateRows, setStateRows] = useState<StateRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/sequences/${initialSequence.id}/state`);
        const data = (await res.json()) as { ok: boolean; rows?: StateRow[] };
        if (alive && data.ok) setStateRows(data.rows || []);
      } catch {
        // Best-effort; not fatal.
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialSequence.id]);

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      {/* ── Left: editor ──────────────────────────────────────────── */}
      <div className="space-y-5">
        <section className="space-y-3 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">Basics</h3>
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-fg-dim mb-1">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg"
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-fg-dim mb-1">
              Description
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-fg cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded accent-accent"
            />
            <span>Enabled (new enrollments only — in-flight rows continue)</span>
          </label>
          <label className="flex items-center gap-2 text-sm text-fg cursor-pointer">
            <input
              type="checkbox"
              checked={onePerLead}
              onChange={(e) => setOnePerLead(e.target.checked)}
              className="rounded accent-accent"
            />
            <span>One enrollment per lead (idempotent re-triggers)</span>
          </label>
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-fg-dim mb-1">
              Email class
            </label>
            <select
              value={emailClass}
              onChange={(e) => setEmailClass(e.target.value)}
              className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg"
            >
              <option value="commercial">Commercial — unsubscribe footer shown (default)</option>
              <option value="transactional">Transactional — no unsubscribe footer</option>
            </select>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-dim">
              Commercial is right for follow-up/marketing drips. Only mark a sequence
              transactional when every email is about the lead&apos;s own in-flight
              application (misclassifying marketing as transactional is a CAN-SPAM risk).
            </p>
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">Trigger</h3>
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-fg-dim mb-1">
              Event type
            </label>
            <input
              value={triggerEvent}
              onChange={(e) => setTriggerEvent(e.target.value)}
              className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm font-mono text-fg"
              placeholder="BRAVO_RECORD_STATUS_CHANGED"
            />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-fg-dim mb-1">
              Filter
            </label>
            <FilterEditor
              filter={parsed.filter || {}}
              onChange={(next) => setFilterJson(JSON.stringify(next, null, 2))}
            />
          </div>
        </section>

        <section className="space-y-3 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">
            Steps
          </h3>
          <StepsEditor
            sequenceId={initialSequence.id}
            steps={parsed.steps || []}
            onChange={(next) => setStepsJson(JSON.stringify(next, null, 2))}
          />
        </section>

        <div className="flex items-center gap-3">
          <button
            onClick={() => save()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-accent text-bg-deep px-4 py-2 text-sm font-bold hover:bg-accent-bright disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </button>
          {tokenOverrideOffer && (
            <button
              onClick={() => save(true)}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg border border-status-warm/40 bg-status-warm/10 px-4 py-2 text-sm font-bold text-status-warm hover:bg-status-warm/20 disabled:opacity-50"
              title={`Confirms removing: ${tokenOverrideOffer.map((t) => `{{${t}}}`).join(", ")}`}
            >
              Remove merge fields anyway
            </button>
          )}
          <button
            onClick={destroy}
            className="inline-flex items-center gap-2 rounded-lg border border-rose-500/40 text-rose-400 px-4 py-2 text-sm font-bold hover:bg-rose-500/10"
          >
            <Trash2 className="w-4 h-4" />
            Delete
          </button>
          {saveMessage && (
            <div
              className={`flex items-center gap-2 text-sm ${
                saveMessage.kind === "ok" ? "text-status-engaged" : "text-rose-400"
              }`}
            >
              {saveMessage.kind === "ok" ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              {saveMessage.text}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: validation + state ─────────────────────────────── */}
      <div className="space-y-4">
        <section className="rounded-xl border border-bg-border bg-bg-elev/40 p-4 sticky top-4 space-y-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">
            Validation
          </h3>
          {parsed.error ? (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-400 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold">Definition invalid</div>
                <div className="text-xs mt-0.5 font-mono">
                  {parsed.error.path}: {parsed.error.reason}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-status-engaged/40 bg-status-engaged/5 p-3 text-sm text-status-engaged flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-bold">Definition OK.</div>
                <div className="text-xs mt-0.5 text-fg-muted">
                  {parsed.steps?.length} step{parsed.steps?.length === 1 ? "" : "s"} —{" "}
                  {parsed.steps?.filter((s) => s.channel === "sms").length} SMS,{" "}
                  {parsed.steps?.filter((s) => s.channel === "email").length} email
                </div>
              </div>
            </div>
          )}

          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-fg-dim mb-2">
              Variables referenced
            </div>
            {referencedTokens.length === 0 ? (
              <p className="text-xs text-fg-dim italic">
                No mustache variables in any step body. Drips with static copy
                still work, but they won&apos;t personalize.
              </p>
            ) : (
              <ul className="space-y-1.5 text-xs">
                {referencedTokens.map((t) => (
                  <li key={t} className="flex items-start gap-2">
                    <code className="font-mono text-accent shrink-0">{`{{${t}}}`}</code>
                    <span className="text-fg-muted text-[11px] leading-relaxed">
                      {tokenHint(t)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-bg-border bg-bg-elev/40 p-4 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">
            In-flight state
          </h3>
          {stateRows === null ? (
            <p className="text-xs text-fg-dim italic">Loading…</p>
          ) : stateRows.length === 0 ? (
            <p className="text-xs text-fg-dim italic">
              No enrollments yet. The first matching status-change event will
              create a row here.
            </p>
          ) : (
            <ul className="space-y-1 text-xs">
              {stateRows.slice(0, 10).map((r) => (
                <li key={r.id} className="flex items-center gap-2 font-mono">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      r.status === "scheduled"
                        ? "bg-status-engaged"
                        : r.status === "sent"
                          ? "bg-fg-muted"
                          : r.status === "failed"
                            ? "bg-rose-500"
                            : "bg-fg-dim"
                    }`}
                  />
                  <span className="text-fg-muted text-[10px] uppercase">{r.status}</span>
                  <span className="text-fg-dim">step {r.step_index}</span>
                  <span className="text-fg-dim truncate">lead:{r.lead_id.slice(0, 8)}…</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <VersionHistory
          sequenceId={initialSequence.id}
          onRestored={(steps) => {
            setStepsJson(JSON.stringify(steps, null, 2));
            setSaveMessage({ kind: "ok", text: "Version restored (already saved)." });
          }}
        />
      </div>
    </div>
  );
}

/**
 * VersionHistory — prior template snapshots for this sequence (written on
 * every steps-changing save). Restore applies the snapshot server-side
 * through the same guarded path as a manual edit, then syncs the editor.
 */
function VersionHistory({
  sequenceId,
  onRestored,
}: {
  sequenceId: string;
  onRestored: (steps: DripStep[]) => void;
}) {
  type VersionRow = { id: string; name: string; steps: DripStep[]; created_at: string };
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/sequences/${sequenceId}/versions`);
        const data = (await res.json()) as { ok: boolean; versions?: VersionRow[] };
        if (alive) setVersions(data.ok ? data.versions || [] : []);
      } catch {
        if (alive) setVersions([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sequenceId]);

  async function restore(versionId: string) {
    if (!confirm("Restore this template version? The current copy is snapshotted first, so this is reversible.")) return;
    setBusyId(versionId);
    setError(null);
    try {
      const res = await fetch(`/api/sequences/${sequenceId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId }),
      });
      const data = (await res.json()) as { ok: boolean; sequence?: { steps: DripStep[] }; message?: string; error?: string };
      if (!data.ok || !data.sequence) {
        setError(data.message || data.error || "restore failed");
        return;
      }
      onRestored(data.sequence.steps);
      const list = await fetch(`/api/sequences/${sequenceId}/versions`);
      const listData = (await list.json()) as { ok: boolean; versions?: VersionRow[] };
      if (listData.ok) setVersions(listData.versions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-xl border border-bg-border bg-bg-elev/40 p-4 space-y-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-fg-muted">
        Template history
      </h3>
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {versions === null ? (
        <p className="text-xs text-fg-dim italic">Loading…</p>
      ) : versions.length === 0 ? (
        <p className="text-xs text-fg-dim italic">
          No prior versions yet — a snapshot is kept every time the steps are saved.
        </p>
      ) : (
        <ul className="space-y-1.5 text-xs">
          {versions.slice(0, 10).map((v) => (
            <li key={v.id} className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-fg-dim shrink-0">
                {new Date(v.created_at).toLocaleString()}
              </span>
              <span className="text-fg-muted truncate">
                {v.steps.length} step{v.steps.length === 1 ? "" : "s"}
              </span>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => restore(v.id)}
                className="ml-auto shrink-0 rounded-md border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-bold text-accent hover:bg-accent/20 disabled:opacity-40"
              >
                {busyId === v.id ? "Restoring…" : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * StepsEditor — structured editor for a DripStep[]. Operator gets one
 * card per step with channel dropdown, delay number, optional subject
 * (email only), body textarea, and an optional from_label. Add / remove
 * / reorder via the card chrome.
 *
 * Source of truth is the parent's stepsJson string. On every change we
 * call onChange with the full updated array; parent re-serializes to
 * JSON and runs it through parseDripSteps, so validation behavior is
 * identical to the raw textarea path.
 */
function StepsEditor({
  sequenceId,
  steps,
  onChange,
}: {
  sequenceId: string;
  steps: DripStep[];
  onChange: (steps: DripStep[]) => void;
}) {
  function update(idx: number, patch: Partial<DripStep>) {
    const next = steps.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange(next);
  }
  function remove(idx: number) {
    onChange(steps.filter((_, i) => i !== idx));
  }
  function move(idx: number, delta: -1 | 1) {
    const target = idx + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  }
  function addStep(channel: "sms" | "email") {
    const last = steps[steps.length - 1];
    onChange([
      ...steps,
      {
        channel,
        delay_minutes: last ? Math.max(60, last.delay_minutes) : 0,
        ...(channel === "email" ? { subject: "" } : {}),
        body: "",
      },
    ]);
  }

  return (
    <div className="space-y-3">
      {steps.length === 0 && (
        <div className="text-xs text-fg-dim italic px-3 py-4 rounded-md border border-dashed border-bg-border">
          No steps yet. Add an SMS or email step below to start the drip.
        </div>
      )}
      {steps.map((step, idx) => (
        <div key={idx} className="rounded-lg border border-bg-border bg-bg-deep/40 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-bold text-fg-muted">Step {idx + 1}</span>
              {step.channel === "email" ? (
                <Mail className="h-3 w-3 text-accent" />
              ) : (
                <MessageSquare className="h-3 w-3 text-accent" />
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => move(idx, -1)}
                disabled={idx === 0}
                className="text-fg-dim hover:text-fg disabled:opacity-30 px-1"
                title="Move up"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(idx, 1)}
                disabled={idx === steps.length - 1}
                className="text-fg-dim hover:text-fg disabled:opacity-30 px-1"
                title="Move down"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => remove(idx)}
                className="text-fg-dim hover:text-rose-400 px-1"
                title="Remove step"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
                Channel
              </span>
              <select
                value={step.channel}
                onChange={(e) => {
                  const ch = e.target.value as "sms" | "email";
                  // Email needs a subject — supply a sensible default
                  // when switching to email so the operator isn't
                  // staring at a "subject required" error from validation.
                  update(idx, {
                    channel: ch,
                    ...(ch === "email" && !step.subject ? { subject: "Following up" } : {}),
                  });
                }}
                className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
              >
                <option value="sms">SMS (Twilio / TextTorrent)</option>
                <option value="email">Email (Gmail)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
                Delay after previous step (minutes)
              </span>
              <input
                type="number"
                value={step.delay_minutes}
                onChange={(e) =>
                  update(idx, { delay_minutes: Math.max(0, Number(e.target.value) || 0) })
                }
                min={0}
                className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
              />
            </label>
          </div>
          {step.channel === "email" && (
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
                Subject
              </span>
              <input
                type="text"
                value={step.subject || ""}
                onChange={(e) => update(idx, { subject: e.target.value })}
                placeholder="Following up on your application"
                className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
              />
            </label>
          )}
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
              Body
              <span className="ml-2 normal-case tracking-normal text-fg-dim/70">
                Mustache vars: {`{{lead.first_name}}`} {`{{lead.business_name}}`}
              </span>
            </span>
            <textarea
              value={step.body}
              onChange={(e) => update(idx, { body: e.target.value })}
              rows={step.channel === "email" ? 6 : 3}
              placeholder={
                step.channel === "sms"
                  ? "Hey {{lead.first_name}}, quick follow-up on the application — let me know if I can answer anything. — Solara"
                  : "Hi {{lead.first_name}},\n\nFollowing up on the application. Let me know if I can help."
              }
              className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg font-mono"
            />
          </label>
          {step.channel === "email" && (
            <EmailStepRotation
              sequenceId={sequenceId}
              stepIndex={idx}
              currentSubject={step.subject || ""}
              currentBody={step.body}
              currentHtml={step.body_html || ""}
              onApply={(patch) => update(idx, patch)}
            />
          )}
          {step.channel === "email" && (
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
                Optional custom HTML
                <span className="ml-2 normal-case tracking-normal text-fg-dim/70">
                  plain text above remains the fallback
                </span>
              </span>
              <textarea
                value={step.body_html || ""}
                onChange={(e) => update(idx, { body_html: e.target.value || undefined })}
                rows={8}
                placeholder="Paste approved email-safe HTML, or load one from Templates."
                className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg font-mono"
              />
            </label>
          )}
          {/* A/B variant pools — the executor picks ONE per lead at send time.
              Previously invisible + un-editable here, so merchants could get
              copy no screen showed (2026-07-22). One variant per line-block,
              separated by a line of three dashes. */}
          {step.channel === "email" &&
            ((step.body_variants?.length || 0) > 0 ||
              (step.subject_variants?.length || 0) > 0) && (
              <div className="rounded-md border border-status-warm/25 bg-status-warm/5 p-2 space-y-2">
                <div className="text-[10px] uppercase tracking-wider font-bold text-status-warm">
                  A/B variant pool — one is picked per lead at send time
                </div>
                {(step.subject_variants?.length || 0) > 0 && (
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
                      Subject variants (one per line)
                    </span>
                    <textarea
                      value={(step.subject_variants || []).join("\n")}
                      onChange={(e) =>
                        update(idx, {
                          subject_variants: e.target.value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      rows={Math.min(6, (step.subject_variants || []).length + 1)}
                      className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg font-mono"
                    />
                  </label>
                )}
                {(step.body_variants?.length || 0) > 0 && (
                  <label className="block">
                    <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
                      Body variants (separate variants with a line containing only ---)
                    </span>
                    <textarea
                      value={(step.body_variants || []).join("\n---\n")}
                      onChange={(e) =>
                        update(idx, {
                          body_variants: e.target.value
                            .split(/\n---\n/)
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      rows={8}
                      className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg font-mono"
                    />
                  </label>
                )}
                <p className="text-[10px] text-fg-dim">
                  Deleting all text removes the pool (the base subject/body then always sends).
                </p>
              </div>
            )}
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
              From label (optional)
            </span>
            <input
              type="text"
              value={step.from_label || ""}
              onChange={(e) => update(idx, { from_label: e.target.value || undefined })}
              placeholder="Your agent name (e.g. the agent's display name)"
              className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
            />
          </label>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => addStep("sms")}
          className="inline-flex items-center gap-1.5 text-xs rounded-md border border-bg-border bg-bg-elev hover:bg-bg-elev/80 px-3 py-1.5 text-fg-muted hover:text-fg"
        >
          <Plus className="h-3 w-3" /> SMS step
        </button>
        <button
          type="button"
          onClick={() => addStep("email")}
          className="inline-flex items-center gap-1.5 text-xs rounded-md border border-bg-border bg-bg-elev hover:bg-bg-elev/80 px-3 py-1.5 text-fg-muted hover:text-fg"
        >
          <Plus className="h-3 w-3" /> Email step
        </button>
      </div>
    </div>
  );
}

/**
 * Translate a saved-library template into the DRIP token dialect. The manual
 * library (lib/sunbiz-templates-library.ts) uses {{first_name}} /
 * {{business_name}} — the two fields the lead-drawer composer supplies. The
 * drip executor resolves {{lead.first_name}} / {{lead.business_name}} instead
 * (lib/drips/templates.ts). Rewrite the tokens so a pasted template still
 * personalizes when it fires. Copy that uses neither token is unchanged.
 */
function toDripDialect(s: string): string {
  return s
    .replace(/\{\{\s*first_name\s*\}\}/g, "{{lead.first_name}}")
    .replace(/\{\{\s*business_name\s*\}\}/g, "{{lead.business_name}}");
}

/**
 * EmailStepRotation — the "rotate this template" control on an email step
 * (Adon 2026-07-20). Three sources, all landing in the same subject+body:
 *   • AI suggest — POST /rotate-suggest returns a fresh compliant variation.
 *   • From saved — pick from the SunBiz template library (token-translated).
 *   • Type it in — the existing subject/body fields (nothing to add here).
 * Apply only fills the editor; the operator still Saves, which re-runs the
 * fail-closed positioning/lender guard on the PATCH path.
 */
function EmailStepRotation({
  sequenceId,
  stepIndex,
  currentSubject,
  currentBody,
  currentHtml,
  onApply,
}: {
  sequenceId: string;
  stepIndex: number;
  currentSubject: string;
  currentBody: string;
  currentHtml: string;
  onApply: (patch: { subject: string; body: string; body_html?: string }) => void;
}) {
  const [open, setOpen] = useState<null | "ai" | "library">(null);
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<{ subject: string; body: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<Array<{
    id: string; label: string; subject: string; preheader: string; html: string; category: string;
  }>>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/campaigns/constant-contact/templates", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (alive) {
          setSaved(
            (data.custom || []).filter((item: { category?: string }) =>
              String(item.category || "").startsWith("drip:"),
            ),
          );
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  async function runAi() {
    setLoading(true);
    setErr(null);
    setSuggestion(null);
    try {
      const res = await fetch(`/api/sequences/${sequenceId}/rotate-suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          step_index: stepIndex,
          instruction: instruction.trim() || undefined,
          current_subject: currentSubject,
          current_body: currentBody,
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        subject?: string;
        body?: string;
        message?: string;
        error?: string;
      };
      if (!data.ok || !data.subject || !data.body) {
        setErr(data.message || data.error || "Couldn't generate a suggestion.");
        return;
      }
      setSuggestion({ subject: data.subject, body: data.body });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "network error");
    } finally {
      setLoading(false);
    }
  }

  function applyTemplate(id: string) {
    const custom = saved.find((t) => t.id === id);
    if (custom) {
      onApply({
        subject: toDripDialect(custom.subject),
        body: toDripDialect(custom.preheader),
        body_html: custom.html ? toDripDialect(custom.html) : undefined,
      });
      setNote(`Loaded "${custom.label}" from Drip Templates. Review, then Save.`);
      setOpen(null);
      return;
    }
    const tpl = SUNBIZ_EMAIL_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    onApply({ subject: toDripDialect(tpl.subject), body: toDripDialect(tpl.body) });
    setNote(`Loaded "${tpl.label}". Edit the copy, then Save.`);
    setOpen(null);
  }

  async function saveCurrentTemplate() {
    const templateName = window.prompt("Template name", `Sequence email ${stepIndex + 1}`);
    if (!templateName?.trim()) return;
    setSavingTemplate(true);
    setErr(null);
    try {
      const res = await fetch("/api/campaigns/constant-contact/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: templateName.trim(),
          category: "drip:custom:jordan_direct",
          subject: currentSubject,
          preheader: currentBody,
          html: currentHtml,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "save_failed");
      setSaved((items) => [
        ...items,
        {
          id: data.id,
          label: templateName.trim(),
          category: "drip:custom:jordan_direct",
          subject: currentSubject,
          preheader: currentBody,
          html: currentHtml,
        },
      ]);
      setNote(`Saved "${templateName.trim()}" to Templates > Drip Templates.`);
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : "save_failed");
    } finally {
      setSavingTemplate(false);
    }
  }

  return (
    <div className="rounded-md border border-bg-border/70 bg-bg-elev/30 p-2 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-fg-dim">Rotate this email</span>
        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={() => {
              setNote(null);
              setOpen(open === "ai" ? null : "ai");
            }}
            className={`inline-flex items-center gap-1 text-[11px] rounded border px-2 py-1 ${
              open === "ai" ? "border-accent text-accent" : "border-bg-border text-fg-muted hover:text-fg"
            }`}
          >
            <Sparkles className="h-3 w-3" /> AI suggest
          </button>
          <button
            type="button"
            onClick={() => {
              setNote(null);
              setOpen(open === "library" ? null : "library");
            }}
            className={`inline-flex items-center gap-1 text-[11px] rounded border px-2 py-1 ${
              open === "library" ? "border-accent text-accent" : "border-bg-border text-fg-muted hover:text-fg"
            }`}
          >
            <BookOpen className="h-3 w-3" /> From saved
          </button>
          <button
            type="button"
            onClick={saveCurrentTemplate}
            disabled={savingTemplate || !currentSubject.trim() || !currentBody.trim()}
            className="inline-flex items-center gap-1 text-[11px] rounded border border-bg-border px-2 py-1 text-fg-muted hover:text-fg disabled:opacity-40"
          >
            <Save className="h-3 w-3" /> {savingTemplate ? "Saving..." : "Save to Templates"}
          </button>
        </div>
      </div>

      {note && <div className="text-[11px] text-status-engaged">{note}</div>}

      {open === "ai" && (
        <div className="space-y-2">
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Optional steer: shorter, warmer, lead with the bank statements…"
            className="w-full rounded border border-bg-border bg-bg-elev px-2 py-1 text-[11px] text-fg"
          />
          <button
            type="button"
            onClick={runAi}
            disabled={loading}
            className="inline-flex items-center gap-1.5 text-[11px] rounded bg-accent text-bg-deep px-2.5 py-1 font-bold hover:bg-accent-bright disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {loading ? "Writing a fresh version…" : "Suggest a fresh version"}
          </button>
          {err && (
            <div className="flex items-start gap-1.5 text-[11px] text-rose-400">
              <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{err}</span>
            </div>
          )}
          {suggestion && (
            <div className="rounded border border-accent/40 bg-accent/5 p-2 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-fg-dim">Suggested</div>
              <div className="text-[11px] font-bold text-fg">{suggestion.subject}</div>
              <div className="text-[11px] text-fg-muted whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                {suggestion.body}
              </div>
              <div className="flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => {
                    onApply(suggestion);
                    setSuggestion(null);
                    setOpen(null);
                    setNote("Applied the AI version. Edit if you like, then Save.");
                  }}
                  className="text-[11px] rounded bg-accent text-bg-deep px-2.5 py-1 font-bold hover:bg-accent-bright"
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={runAi}
                  disabled={loading}
                  className="text-[11px] rounded border border-bg-border px-2.5 py-1 text-fg-muted hover:text-fg disabled:opacity-50"
                >
                  Regenerate
                </button>
                <button
                  type="button"
                  onClick={() => setSuggestion(null)}
                  className="text-[11px] text-fg-dim hover:text-fg ml-auto"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {open === "library" && (
        <div className="space-y-1">
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) applyTemplate(e.target.value);
            }}
            className="w-full rounded border border-bg-border bg-bg-elev px-2 py-1 text-[11px] text-fg"
          >
            <option value="">Pick a saved template…</option>
            {saved.length > 0 && (
              <optgroup label="Your Drip Templates">
                {saved.map((template) => (
                  <option key={template.id} value={template.id}>{template.label}</option>
                ))}
              </optgroup>
            )}
            {SUNBIZ_TEMPLATE_CATEGORIES.map((cat) => {
              const items = SUNBIZ_EMAIL_TEMPLATES.filter((t) => t.category === cat.category);
              if (items.length === 0) return null;
              return (
                <optgroup key={cat.category} label={cat.label}>
                  {items.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
          <p className="text-[10px] text-fg-dim">
            Pastes the saved copy (with drip tokens) into the subject + body above. Edit, then Save.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * FilterEditor — structured editor for the DripTriggerFilter shape.
 * Three of the four supported keys (entity, field, to) cover ~all real
 * use cases; `from` is exposed under an expandable "Advanced" disclosure
 * since it's rarely needed (matches a specific transition pair).
 */
function FilterEditor({
  filter,
  onChange,
}: {
  filter: DripTriggerFilter;
  onChange: (next: DripTriggerFilter) => void;
}) {
  const [showFrom, setShowFrom] = useState(!!filter.from);
  function patch(p: Partial<DripTriggerFilter>) {
    onChange({ ...filter, ...p });
  }
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
            Entity
          </span>
          <select
            value={filter.entity || ""}
            onChange={(e) => patch({ entity: e.target.value || undefined })}
            className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
          >
            <option value="">— any —</option>
            <option value="lead">Lead</option>
            <option value="application">Application</option>
            <option value="offer">Offer</option>
            <option value="funded_deal">Funded deal</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
            Field
          </span>
          <select
            value={filter.field || ""}
            onChange={(e) => patch({ field: e.target.value || undefined })}
            className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
          >
            <option value="">— any —</option>
            <option value="stage">stage</option>
            <option value="status">status</option>
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
            To (target value)
          </span>
          <input
            type="text"
            value={filter.to || ""}
            onChange={(e) => patch({ to: e.target.value || undefined })}
            placeholder="viewed_application"
            className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
          />
        </label>
      </div>
      {showFrom ? (
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-fg-dim block mb-0.5">
            From (source value, rare)
            <button
              type="button"
              onClick={() => {
                setShowFrom(false);
                patch({ from: undefined });
              }}
              className="ml-2 text-fg-dim hover:text-fg normal-case tracking-normal"
            >
              hide
            </button>
          </span>
          <input
            type="text"
            value={filter.from || ""}
            onChange={(e) => patch({ from: e.target.value || undefined })}
            placeholder="sent_application"
            className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
          />
        </label>
      ) : (
        <button
          type="button"
          onClick={() => setShowFrom(true)}
          className="text-[10px] uppercase tracking-wider text-fg-dim hover:text-fg"
        >
          + Match only a specific transition
        </button>
      )}
    </div>
  );
}
