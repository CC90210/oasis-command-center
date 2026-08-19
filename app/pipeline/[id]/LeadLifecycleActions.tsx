"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BOOKING_URL } from "@/lib/marketing/routes";

type Founder = { auth_user_id: string | null; full_name: string; display_name: string | null; team_role: string; is_owner: boolean };

export function LeadLifecycleActions({ leadId, currentStage, canManage }: { leadId: string; currentStage: string; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [nextActionAt, setNextActionAt] = useState("");
  const [checks, setChecks] = useState([false, false, false, false]);
  const [founders, setFounders] = useState<Founder[]>([]);
  const [founderUserId, setFounderUserId] = useState("");
  const [meetingAt, setMeetingAt] = useState("");
  const [promisedDemo, setPromisedDemo] = useState("");

  useEffect(() => {
    fetch("/api/team/members").then((r) => r.ok ? r.json() : null).then((body) => {
      const next = (body?.members || []).filter((m: Founder) => m.is_owner || m.team_role === "admin");
      setFounders(next);
      if (next[0]?.auth_user_id) setFounderUserId(next[0].auth_user_id);
    }).catch(() => undefined);
  }, []);

  async function patch(body: Record<string, unknown>) {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/website-sales/${leadId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `update_${res.status}`);
      setMessage("Saved. The pipeline is up to date.");
      startTransition(() => router.refresh());
    } catch (error) { setMessage(error instanceof Error ? error.message : "Update failed"); }
    finally { setBusy(false); }
  }

  const disabled = busy || pending;
  return <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4 space-y-4">
    <div><div className="text-xs font-bold uppercase tracking-wider text-fg-muted">Required next action</div><div className="mt-1 text-sm text-fg">{instructionFor(currentStage, canManage)}</div></div>
    {!canManage && ["assigned", "attempting_contact", "connected"].includes(currentStage) && <>
      <label className="block text-xs text-fg-muted">Next follow-up time <input type="datetime-local" value={nextActionAt} onChange={(e) => setNextActionAt(e.target.value)} className="ml-2 rounded border border-bg-border bg-bg-deep px-2 py-1 text-fg" /></label>
      <div className="flex flex-wrap gap-2">
        <button disabled={disabled || !nextActionAt} onClick={() => patch({ action:"disposition", disposition:"attempted", nextActionAt:new Date(nextActionAt).toISOString() })} className="btn-secondary !px-3 !py-1.5 text-xs">No answer</button>
        <button disabled={disabled || !nextActionAt} onClick={() => patch({ action:"disposition", disposition:"voicemail", nextActionAt:new Date(nextActionAt).toISOString() })} className="btn-secondary !px-3 !py-1.5 text-xs">Voicemail left</button>
        <button disabled={disabled} onClick={() => patch({ action:"disposition", disposition:"connected" })} className="btn-secondary !px-3 !py-1.5 text-xs">Connected</button>
        <button disabled={disabled} onClick={() => patch({ action:"disposition", disposition:"lost", lossReason:"Not a fit / declined" })} className="btn-secondary !px-3 !py-1.5 text-xs">Lost</button>
      </div>
    </>}
    {!canManage && currentStage === "connected" && <div className="space-y-3">
      <div className="grid sm:grid-cols-2 gap-2">{["Decision-maker confirmed", "Website problem confirmed", "Timing confirmed", "Open to $2,000+"].map((label, i) => <label key={label} className="text-xs text-fg-muted"><input type="checkbox" checked={checks[i]} onChange={(e) => setChecks((old) => old.map((v,j) => j === i ? e.target.checked : v))} className="mr-2" />{label}</label>)}</div>
      <button disabled={disabled || !checks.every(Boolean)} onClick={() => patch({ action:"qualify", qualification:{ authorityConfirmed:true, websiteProblemConfirmed:true, timingConfirmed:true, minimumInvestmentConfirmed:true } })} className="btn-secondary !px-3 !py-1.5 text-xs">Mark qualified</button>
    </div>}
    {!canManage && currentStage === "qualified" && <div className="space-y-3">
      <a href={BOOKING_URL} target="_blank" rel="noreferrer" className="inline-flex text-xs font-bold text-accent hover:underline">Open OASIS Google Meet calendar ↗</a>
      <div className="grid md:grid-cols-3 gap-2"><select value={founderUserId} onChange={(e) => setFounderUserId(e.target.value)} className="rounded border border-bg-border bg-bg-deep px-2 py-2 text-xs text-fg"><option value="">Select founder</option>{founders.map((f) => f.auth_user_id && <option key={f.auth_user_id} value={f.auth_user_id}>{f.display_name || f.full_name}</option>)}</select><input type="datetime-local" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} className="rounded border border-bg-border bg-bg-deep px-2 py-2 text-xs text-fg"/><input value={promisedDemo} onChange={(e) => setPromisedDemo(e.target.value)} placeholder="Promised audit/demo angle" className="rounded border border-bg-border bg-bg-deep px-2 py-2 text-xs text-fg"/></div>
      <button disabled={disabled || !founderUserId || !meetingAt || !promisedDemo.trim()} onClick={() => patch({ action:"book_founder", founderUserId, meetingAt:new Date(meetingAt).toISOString(), promisedDemo })} className="btn-secondary !px-3 !py-1.5 text-xs">Send to founder pipeline</button>
    </div>}
    {message && <div className="text-xs text-fg-muted">{message}</div>}
  </div>;
}

function instructionFor(stage: string, admin: boolean): string {
  if (admin) return "Review the assigned rep, notes, promised demo, and move the deal through founder close and website fulfilment.";
  const map: Record<string,string> = { assigned:"Review the website audit, then make the first call.", attempting_contact:"Call the next scheduled touch and record exactly what happened.", connected:"Diagnose the website problem and complete all four qualification gates.", qualified:"Book the Google Meet, choose CC or Adon, and record the exact demo promise.", founder_meeting_booked:"Handoff complete. The founders now own scope, price, and close." };
  return map[stage] || "Follow the stage instructions in the Website Sales Playbook.";
}
