"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { UserProfile } from "@/lib/supabase";
import { AGENT_REGISTRY, resolveAgentKey } from "@/lib/agents";

/**
 * `tenantAgents` — slugs of agents the tenant manifest enables. When
 * provided, the primary-agent picker renders THIS list. Workspace agent
 * membership is managed once in the tenant manifest, not independently on
 * every user's profile.
 */
export function ProfileEditor({
  profile,
  tenantAgents,
}: {
  profile: UserProfile;
  tenantAgents?: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [fullName, setFullName] = useState(profile.full_name);
  const [displayName, setDisplayName] = useState(profile.display_name || "");
  const [personalPhone, setPersonalPhone] = useState(
    (profile as { personal_phone?: string | null }).personal_phone || "",
  );
  const [brand, setBrand] = useState(profile.brand);
  const [mrrTarget, setMrrTarget] = useState(String(profile.mrr_target_usd));
  const [mrrCurrent, setMrrCurrent] = useState(String(profile.mrr_current_usd));
  const [mrrDate, setMrrDate] = useState(profile.mrr_target_date || "");
  const [manifesto, setManifesto] = useState(profile.manifesto || "");
  const tenantBase = (tenantAgents || []).map(resolveAgentKey);
  const availableAgentKeys = Array.from(
    new Set(tenantBase.filter((key): key is string => typeof key === "string" && key.length > 0)),
  );
  const requestedPrimary = resolveAgentKey(profile.primary_agent);
  const [primaryAgent, setPrimaryAgent] = useState(
    availableAgentKeys.includes(requestedPrimary)
      ? requestedPrimary
      : availableAgentKeys[0] || "",
  );

  async function onSave() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: fullName,
          display_name: displayName || null,
          personal_phone: personalPhone.trim() || null,
          brand,
          mrr_target_usd: Number(mrrTarget) || 0,
          mrr_current_usd: Number(mrrCurrent) || 0,
          mrr_target_date: mrrDate || null,
          manifesto: manifesto || null,
          ...(primaryAgent ? { primary_agent: primaryAgent } : {}),
        }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        setErr(body.error || `error ${r.status}`);
        return;
      }
      setMsg("Saved.");
      router.refresh();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="Full name">
          <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Display name">
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. CC" />
        </Field>
        <Field label="Personal phone">
          <input
            className="input"
            type="tel"
            value={personalPhone}
            onChange={(e) => setPersonalPhone(e.target.value)}
            placeholder="555-123-4567"
          />
          <p className="text-xs text-fg-muted mt-1">
            Display-only. Outbound SMS still goes through your tenant&apos;s shared number; this is what agents quote when they tell a lead how to reach you directly.
          </p>
        </Field>
        <Field label="Brand">
          <input className="input" value={brand} onChange={(e) => setBrand(e.target.value)} />
        </Field>
        <Field label="Primary agent">
          <select
            className="select"
            value={primaryAgent}
            onChange={(e) => setPrimaryAgent(e.target.value)}
            disabled={availableAgentKeys.length === 0}
          >
            {availableAgentKeys.length === 0 ? (
              <option value="">No workspace agents enabled</option>
            ) : availableAgentKeys.map((k) => (
              <option key={k} value={k}>{AGENT_REGISTRY[k]?.label || k}</option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-fg-dim leading-relaxed">
            This list comes from Workspace agents below. Enable or remove an agent there once for the whole team.
          </p>
        </Field>
        <Field label="MRR target (USD)">
          <input className="input" type="number" value={mrrTarget} onChange={(e) => setMrrTarget(e.target.value)} />
        </Field>
        <Field label="MRR current (USD)">
          <input className="input" type="number" value={mrrCurrent} onChange={(e) => setMrrCurrent(e.target.value)} />
        </Field>
        <Field label="MRR target date">
          <input className="input" type="date" value={mrrDate} onChange={(e) => setMrrDate(e.target.value)} />
        </Field>
        <Field label="Email">
          <input className="input opacity-60" value={profile.email} disabled />
        </Field>
      </div>

      <Field label="Manifesto / direction (shown on Today)">
        <textarea
          className="textarea"
          value={manifesto}
          onChange={(e) => setManifesto(e.target.value)}
          rows={6}
          placeholder="A line you want to read every morning."
        />
      </Field>

      <div className="flex items-center gap-3 pt-2">
        <button onClick={onSave} disabled={busy} className="btn-primary">
          {busy ? "Saving…" : "Save profile"}
        </button>
        {msg && <span className="text-status-engaged text-sm">{msg}</span>}
        {err && <span className="text-status-hot text-sm">{err}</span>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      {children}
    </div>
  );
}
