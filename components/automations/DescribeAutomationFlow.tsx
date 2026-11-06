"use client";

import { useState } from "react";
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, RotateCcw, Save, Sparkles } from "lucide-react";
import {
  AUTOMATION_DEPARTMENTS,
  AUTOMATION_TRIGGERS,
  parseAutomationPipeline,
  suggestConnectorKeys,
  targetMachineIsSelectable,
  targetMachineState,
  type AutomationDepartment,
  type AutomationPipeline,
  type AutomationTrigger,
} from "@/lib/automations/pipeline";

type Draft = {
  suggested_name: string;
  suggested_description: string;
  schedule: string;
  schedule_human: string;
  script_filename: string;
  script_content: string;
  agent_key: string;
  reasoning: string;
};

type Device = {
  id: string;
  label: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  scope: string | null;
  tool_capabilities?: string[] | string | null;
  mine?: boolean;
};

type CredentialRow = { key: string; has_value: boolean };
type Phase = "wizard" | "drafting" | "review" | "saving" | "saved";

const DEPARTMENT_LABEL: Record<AutomationDepartment, string> = {
  marketing: "Marketing",
  sales: "Sales",
  operations: "Operations",
  finance: "Finance",
  customer_success: "Customer success",
  executive: "Executive",
};

const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  schedule: "On a schedule",
  event: "When an event appears",
  manual: "Manual until activated",
};

function fieldClass() {
  return "w-full rounded-lg border border-bg-border bg-bg-deep px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none";
}

function relativeSeen(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 1 ? "just now" : `${minutes}m ago`;
}

export function DescribeAutomationFlow() {
  const [step, setStep] = useState(1);
  const [phase, setPhase] = useState<Phase>("wizard");
  const [department, setDepartment] = useState<AutomationDepartment | null>(null);
  const [objective, setObjective] = useState("");
  const [triggerKind, setTriggerKind] = useState<AutomationTrigger>("schedule");
  const [scheduleHint, setScheduleHint] = useState("");
  const [inputText, setInputText] = useState("");
  const [expectedOutputs, setExpectedOutputs] = useState("");
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [connectorKeys, setConnectorKeys] = useState<string[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [targetPairingId, setTargetPairingId] = useState("");
  const [loadingContext, setLoadingContext] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<{ cronId: string; scriptPath: string; targetLabel: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pipeline(): AutomationPipeline {
    return parseAutomationPipeline({
      department,
      objective,
      trigger_kind: triggerKind,
      schedule_hint: scheduleHint,
      input_parameters: inputText,
      expected_outputs: expectedOutputs,
      connector_keys: connectorKeys,
      target_pairing_id: targetPairingId,
    });
  }

  async function openConnectors() {
    setError(null);
    try {
      parseAutomationPipeline({
        department,
        objective,
        trigger_kind: triggerKind,
        schedule_hint: scheduleHint,
        input_parameters: inputText,
        expected_outputs: expectedOutputs,
        connector_keys: [],
        target_pairing_id: "placeholder-machine",
      });
    } catch (validation) {
      setError(validation instanceof Error ? validation.message : "Finish the workflow details first.");
      return;
    }
    setLoadingContext(true);
    try {
      const [credentialsResponse, devicesResponse] = await Promise.all([
        fetch("/api/credentials/custom", { cache: "no-store" }),
        fetch("/api/devices", { cache: "no-store" }),
      ]);
      const credentialsBody = (await credentialsResponse.json().catch(() => ({}))) as { ok?: boolean; entries?: CredentialRow[]; error?: string };
      const devicesBody = (await devicesResponse.json().catch(() => ({}))) as { ok?: boolean; devices?: Device[]; error?: string };
      if (!credentialsResponse.ok || !credentialsBody.ok) throw new Error(credentialsBody.error || "The credential vault could not be read.");
      if (!devicesResponse.ok || !devicesBody.ok) throw new Error(devicesBody.error || "Paired computers could not be read.");
      const savedCredentials = (credentialsBody.entries || []).filter((row) => row.has_value);
      const ownDevices = (devicesBody.devices || []).filter((device) => device.mine !== false);
      setCredentials(savedCredentials);
      setDevices(ownDevices);
      setConnectorKeys(suggestConnectorKeys(department!, objective, savedCredentials.map((row) => row.key)));
      setStep(3);
    } catch (contextError) {
      setError(contextError instanceof Error ? contextError.message : "Setup context could not be loaded.");
    } finally {
      setLoadingContext(false);
    }
  }

  function openTargets() {
    const selectable = devices
      .filter((device) => targetMachineIsSelectable(device))
      .sort((a, b) => Date.parse(b.last_seen_at || "") - Date.parse(a.last_seen_at || ""));
    setTargetPairingId((current) => current || selectable[0]?.id || "");
    setError(selectable.length ? null : "No online computer with generated-automation support is available. Update and start its bridge, then reload this step.");
    setStep(4);
  }

  async function createDraft() {
    let parsed: AutomationPipeline;
    try {
      parsed = pipeline();
    } catch (validation) {
      setError(validation instanceof Error ? validation.message : "Finish every setup step first.");
      return;
    }
    setError(null);
    setPhase("drafting");
    try {
      const response = await fetch("/api/automations/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pipeline: parsed }),
      });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; draft?: Draft; error?: string; message?: string };
      if (!response.ok || !body.ok || !body.draft) throw new Error(body.message || body.error || "Drafting failed.");
      setDraft(body.draft);
      setPhase("review");
    } catch (draftError) {
      setError(draftError instanceof Error ? draftError.message : "Drafting failed.");
      setPhase("wizard");
    }
  }

  async function saveDraft() {
    if (!draft) return;
    const parsed = pipeline();
    setPhase("saving");
    setError(null);
    try {
      const response = await fetch("/api/automations/save-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, pipeline: parsed, confirmed: true }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        cron_id?: string;
        script_path?: string;
        target_label?: string | null;
        error?: string;
        message?: string;
      };
      if (!response.ok || !body.ok || !body.cron_id || !body.script_path) {
        throw new Error(body.message || body.error || "Save failed.");
      }
      setSaved({ cronId: body.cron_id, scriptPath: body.script_path, targetLabel: body.target_label || null });
      setPhase("saved");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Save failed.");
      setPhase("review");
    }
  }

  function reset() {
    setStep(1);
    setPhase("wizard");
    setDepartment(null);
    setObjective("");
    setTriggerKind("schedule");
    setScheduleHint("");
    setInputText("");
    setExpectedOutputs("");
    setCredentials([]);
    setConnectorKeys([]);
    setDevices([]);
    setTargetPairingId("");
    setDraft(null);
    setSaved(null);
    setError(null);
  }

  if (phase === "drafting") {
    return <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 p-5"><Loader2 className="h-5 w-5 animate-spin text-accent" /><div><p className="text-sm font-bold text-fg">Building the reviewed draft…</p><p className="text-[11px] text-fg-muted">The four setup steps are being translated into a paused script job.</p></div></div>;
  }

  if ((phase === "review" || phase === "saving") && draft) {
    const target = devices.find((device) => device.id === targetPairingId);
    return (
      <div className="space-y-4 rounded-xl border border-status-engaged/40 bg-status-engaged/5 p-4">
        <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-status-engaged" /><p className="text-sm font-bold text-fg">Review before saving</p></div>
        <dl className="grid gap-2 text-sm sm:grid-cols-[9rem_1fr]">
          <dt className="text-xs font-bold uppercase tracking-wider text-fg-muted">Name</dt><dd>{draft.suggested_name}</dd>
          <dt className="text-xs font-bold uppercase tracking-wider text-fg-muted">Department</dt><dd>{DEPARTMENT_LABEL[department!]}</dd>
          <dt className="text-xs font-bold uppercase tracking-wider text-fg-muted">Schedule</dt><dd>{draft.schedule_human} <span className="font-mono text-[11px] text-fg-dim">({draft.schedule})</span></dd>
          <dt className="text-xs font-bold uppercase tracking-wider text-fg-muted">Computer</dt><dd>{target?.label || "Paired computer"}</dd>
          <dt className="text-xs font-bold uppercase tracking-wider text-fg-muted">Credentials</dt><dd>{connectorKeys.length ? connectorKeys.join(", ") : "None required"}</dd>
          <dt className="text-xs font-bold uppercase tracking-wider text-fg-muted">Script</dt><dd className="font-mono text-xs">scripts/{draft.script_filename}</dd>
        </dl>
        <details className="rounded-lg border border-bg-border bg-bg-deep/40"><summary className="cursor-pointer px-3 py-2 text-xs text-fg-muted">Inspect generated Python ({draft.script_content.split("\n").length} lines)</summary><pre className="max-h-96 overflow-auto px-3 pb-3 font-mono text-[10px] text-fg-dim">{draft.script_content}</pre></details>
        <p className="rounded-lg bg-bg-deep/40 p-3 text-[11px] leading-relaxed text-fg-muted"><span className="font-bold text-fg">Why this design:</span> {draft.reasoning}</p>
        {error && <p role="alert" className="flex items-start gap-2 rounded-md border border-status-hot/30 bg-status-hot/10 p-2.5 text-xs text-status-hot"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-xs" disabled={phase === "saving"} onClick={() => setPhase("wizard")}><ChevronLeft className="h-3.5 w-3.5" />Edit setup</button>
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-xs" disabled={phase === "saving"} onClick={() => void createDraft()}><RotateCcw className="h-3.5 w-3.5" />Re-draft</button>
          <button type="button" className="btn-send inline-flex items-center gap-1.5 text-xs" disabled={phase === "saving"} onClick={() => void saveDraft()}>{phase === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}{phase === "saving" ? "Saving…" : "Save automation (disabled)"}</button>
        </div>
      </div>
    );
  }

  if (phase === "saved" && saved) {
    return (
      <div className="space-y-3 rounded-xl border border-status-engaged/40 bg-status-engaged/5 p-4">
        <div className="flex items-center gap-2"><CheckCircle2 className="h-5 w-5 text-status-engaged" /><p className="text-sm font-bold text-fg">Automation saved (paused)</p></div>
        <p className="text-sm leading-relaxed text-fg-muted">The reusable template and paused schedule are stored in the Command Center. When you enable it, {saved.targetLabel || "the selected computer"} will materialize <code className="font-mono text-fg">{saved.scriptPath}</code> from the reviewed source before each run.</p>
        <button type="button" onClick={reset} className="btn-secondary inline-flex items-center gap-1.5 text-xs"><Sparkles className="h-3.5 w-3.5" />Build another</button>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-accent/30 bg-accent/5 p-4">
      <div>
        <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-accent" /><p className="text-sm font-bold text-fg">Build an automation</p></div>
        <p className="mt-1 text-[11px] text-fg-muted">Four explicit steps. New automations land switched off, so nothing runs until you review and activate it.</p>
      </div>
      <ol className="grid grid-cols-4 gap-2" aria-label="Automation setup progress">
        {["Department", "Workflow", "Connectors", "Computer"].map((label, index) => {
          const number = index + 1;
          return <li key={label} className={`rounded-md border px-2 py-2 text-center text-[10px] font-bold uppercase tracking-wider ${step === number ? "border-accent/50 bg-accent/10 text-fg" : number < step ? "border-status-engaged/30 text-status-engaged" : "border-bg-border text-fg-dim"}`}><span className="block font-mono text-[9px]">0{number}</span>{label}</li>;
        })}
      </ol>

      {step === 1 && (
        <div className="space-y-3"><p className="text-sm font-semibold text-fg">Which department owns the outcome?</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{AUTOMATION_DEPARTMENTS.map((item) => <button key={item} type="button" aria-pressed={department === item} onClick={() => setDepartment(item)} className={`rounded-lg border p-3 text-left text-sm font-semibold transition-colors ${department === item ? "border-accent/50 bg-accent/10 text-fg" : "border-bg-border bg-bg-deep/50 text-fg-muted hover:text-fg"}`}>{DEPARTMENT_LABEL[item]}</button>)}</div><div className="flex justify-end"><button type="button" disabled={!department} onClick={() => setStep(2)} className="btn-send inline-flex items-center gap-1.5 text-xs disabled:opacity-40">Workflow details<ChevronRight className="h-3.5 w-3.5" /></button></div></div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <label className="block text-xs font-bold uppercase tracking-wider text-fg-muted">Objective<textarea rows={3} className={`${fieldClass()} mt-1 normal-case tracking-normal`} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="When a qualified lead arrives, prepare a concise account brief and send it to the sales owner." /></label>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-bold uppercase tracking-wider text-fg-muted">Trigger<select className={`${fieldClass()} mt-1 normal-case tracking-normal`} value={triggerKind} onChange={(e) => setTriggerKind(e.target.value as AutomationTrigger)}>{AUTOMATION_TRIGGERS.map((item) => <option key={item} value={item}>{TRIGGER_LABEL[item]}</option>)}</select></label><label className="block text-xs font-bold uppercase tracking-wider text-fg-muted">{triggerKind === "schedule" ? "Schedule" : "Schedule hint"}<input className={`${fieldClass()} mt-1 normal-case tracking-normal`} value={scheduleHint} onChange={(e) => setScheduleHint(e.target.value)} placeholder={triggerKind === "schedule" ? "Weekdays at 9am or 0 9 * * 1-5" : "How often should OASIS check?"} /></label></div>
          <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs font-bold uppercase tracking-wider text-fg-muted">Input parameters<textarea rows={2} className={`${fieldClass()} mt-1 normal-case tracking-normal`} value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="lead_id, date range, owner" /></label><label className="block text-xs font-bold uppercase tracking-wider text-fg-muted">Expected output<textarea rows={2} className={`${fieldClass()} mt-1 normal-case tracking-normal`} value={expectedOutputs} onChange={(e) => setExpectedOutputs(e.target.value)} placeholder="A Telegram summary and a saved CRM note" /></label></div>
          <div className="flex justify-between"><button type="button" className="btn-secondary inline-flex items-center gap-1 text-xs" onClick={() => setStep(1)}><ChevronLeft className="h-3.5 w-3.5" />Department</button><button type="button" className="btn-send inline-flex items-center gap-1.5 text-xs" disabled={loadingContext} onClick={() => void openConnectors()}>{loadingContext ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{loadingContext ? "Reading workspace…" : "Bind connectors"}<ChevronRight className="h-3.5 w-3.5" /></button></div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3"><div><p className="text-sm font-semibold text-fg">Credentials were matched by department and objective</p><p className="mt-1 text-[11px] text-fg-muted">Only credential names are bound to the template. Values stay encrypted and never enter this page or the AI prompt.</p></div>{credentials.length === 0 ? <p className="rounded-lg border border-bg-border bg-bg-deep/40 p-3 text-xs text-fg-muted">No custom vault credentials are saved. This automation can still use built-in Command Center services.</p> : <div className="grid gap-2 sm:grid-cols-2">{credentials.map((row) => { const selected = connectorKeys.includes(row.key); return <label key={row.key} className={`flex items-center gap-2 rounded-lg border p-3 text-xs ${selected ? "border-accent/40 bg-accent/10 text-fg" : "border-bg-border bg-bg-deep/40 text-fg-muted"}`}><input type="checkbox" checked={selected} onChange={() => setConnectorKeys((current) => selected ? current.filter((key) => key !== row.key) : [...current, row.key])} className="h-4 w-4 accent-[#1FE3F0]" /><span className="font-mono">{row.key}</span>{selected && <span className="ml-auto text-[10px] text-status-engaged">bound</span>}</label>; })}</div>}<div className="flex justify-between"><button type="button" className="btn-secondary inline-flex items-center gap-1 text-xs" onClick={() => setStep(2)}><ChevronLeft className="h-3.5 w-3.5" />Workflow</button><button type="button" className="btn-send inline-flex items-center gap-1.5 text-xs" onClick={openTargets}>Choose computer<ChevronRight className="h-3.5 w-3.5" /></button></div></div>
      )}

      {step === 4 && (
        <div className="space-y-3"><div><p className="text-sm font-semibold text-fg">Run it on a live paired computer</p><p className="mt-1 text-[11px] text-fg-muted">The freshest eligible computer is selected automatically. Offline and connector-only pairings cannot receive scheduled scripts.</p></div><div className="space-y-2">{devices.map((device) => { const selectable = targetMachineIsSelectable(device); const state = targetMachineState(device.last_seen_at); return <button key={device.id} type="button" disabled={!selectable} onClick={() => setTargetPairingId(device.id)} className={`flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left ${targetPairingId === device.id ? "border-accent/50 bg-accent/10" : "border-bg-border bg-bg-deep/40"} disabled:cursor-not-allowed disabled:opacity-45`}><span><span className="block text-sm font-semibold text-fg">{device.label || "Paired computer"}</span><span className="text-[11px] text-fg-muted">Last heartbeat {relativeSeen(device.last_seen_at)} · {device.scope || "legacy daemon"}</span></span><span className={`text-[10px] font-bold uppercase tracking-wider ${state === "online" ? "text-status-engaged" : state === "idle" ? "text-status-warm" : "text-status-hot"}`}>{state}</span></button>; })}</div>{error && <p role="alert" className="flex items-start gap-2 rounded-md border border-status-warm/30 bg-status-warm/10 p-2.5 text-xs text-status-warm"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>}<div className="flex justify-between"><button type="button" className="btn-secondary inline-flex items-center gap-1 text-xs" onClick={() => setStep(3)}><ChevronLeft className="h-3.5 w-3.5" />Connectors</button><button type="button" className="btn-send inline-flex items-center gap-1.5 text-xs" disabled={!targetPairingId} onClick={() => void createDraft()}><Sparkles className="h-3.5 w-3.5" />Draft for review</button></div></div>
      )}

      {error && step !== 4 && <p role="alert" className="flex items-start gap-2 rounded-md border border-status-warm/30 bg-status-warm/10 p-2.5 text-xs text-status-warm"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{error}</p>}
    </div>
  );
}
