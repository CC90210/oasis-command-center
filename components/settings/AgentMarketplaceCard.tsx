"use client";

/**
 * AgentMarketplaceCard — owner-only Settings card for managing which
 * agents are enabled on the tenant's manifest.
 *
 * Core agents (manifest.agents[].core === true) are locked: rendered
 * with a "Core · always on" pill, the toggle is disabled, the operator
 * cannot remove them. For SunBiz that's Solara + Helios — the funding-
 * shop CRM depends on them.
 *
 * Non-core slots:
 *   - Already in manifest, enabled=true       → "Enabled" toggle (can remove)
 *   - Already in manifest, enabled=false      → "Disabled" toggle (can enable)
 *   - Not in manifest yet                     → "+ Add to workspace" button
 *
 * Add-on candidates come from AGENT_REGISTRY filtered to chat-facing
 * personas — Bravo, Atlas, Maven, Aura, Hermes — excluding any slug
 * already present in the manifest.
 *
 * Architectural note: writes go through POST /api/tenant/agents/toggle
 * which mutates tenant_manifests.manifest.agents server-side. RLS +
 * owner gate enforced at the API; this component renders the UI only.
 */

import { useState } from "react";
import { Plus, Lock, Loader2, CheckCircle2, X, AlertCircle } from "lucide-react";
import { AGENT_REGISTRY, getAgentInfo, FAMILY_AGENT_KEYS } from "@/lib/agents";

type ManifestAgent = {
  slug: string;
  display_name: string;
  enabled: boolean;
  primary?: boolean;
  core?: boolean;
};

type Props = {
  initialAgents: ManifestAgent[];
  isOwner: boolean;
};

export function AgentMarketplaceCard({ initialAgents, isOwner }: Props) {
  const [agents, setAgents] = useState<ManifestAgent[]>(initialAgents);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const knownSlugs = new Set(agents.map((a) => a.slug.toLowerCase()));
  // Candidate add-ons: chat-facing family agents NOT already in the manifest.
  const addOnCandidates = FAMILY_AGENT_KEYS.filter((k) => !knownSlugs.has(k.toLowerCase()));

  async function callToggle(body: {
    action: "add" | "enable" | "disable" | "remove";
    slug: string;
  }) {
    setBusySlug(body.slug);
    setError(null);
    setFlash(null);
    try {
      const r = await fetch("/api/tenant/agents/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        agents?: ManifestAgent[];
        error?: string;
        message?: string;
      };
      if (!r.ok || !out.ok) {
        setError(out.message || out.error || `toggle_failed:${r.status}`);
        return;
      }
      if (out.agents) setAgents(out.agents);
      setFlash(
        body.action === "add"
          ? `Added ${getAgentInfo(body.slug).label} to the workspace`
          : body.action === "remove"
            ? `Removed ${getAgentInfo(body.slug).label}`
            : body.action === "enable"
              ? `${getAgentInfo(body.slug).label} re-enabled`
              : `${getAgentInfo(body.slug).label} disabled`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "toggle_failed");
    } finally {
      setBusySlug(null);
    }
  }

  if (!isOwner) {
    return (
      <div className="rounded-2xl border border-bg-border bg-bg-elev/40 p-5">
        <header className="space-y-1">
          <h3 className="text-sm font-bold text-fg uppercase tracking-wider">
            Workspace agents
          </h3>
          <p className="text-[12px] text-fg-muted leading-relaxed">
            Only the workspace owner can add or remove agents. Ask Matt to manage the agent lineup.
          </p>
        </header>
        <ul className="mt-3 space-y-2">
          {agents.map((a) => {
            const info = getAgentInfo(a.slug);
            return (
              <li
                key={a.slug}
                className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-deep/30 px-3 py-2 text-sm"
              >
                <span className={`font-semibold ${info.textClass}`}>{a.display_name || info.label}</span>
                <span className="text-fg-dim text-[11px] ml-auto">
                  {a.core ? "Core" : a.enabled ? "Enabled" : "Disabled"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-bg-border bg-bg-elev/40 p-5 space-y-4">
      <header className="space-y-1">
        <h3 className="text-sm font-bold text-fg uppercase tracking-wider">
          Workspace agents
        </h3>
        <p className="text-[12px] text-fg-muted leading-relaxed">
          Your tenant&apos;s core agents are locked — the workspace depends on them. Add C-suite agents (Bravo, Atlas, Maven, Aura, Hermes) as needed; each one shows up in the chat picker and Settings → My Agents.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-md p-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {error}
        </div>
      )}
      {flash && (
        <div className="flex items-start gap-2 text-[12px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md p-2">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {flash}
        </div>
      )}

      {/* Current workspace agents */}
      <section className="space-y-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">
          Currently in this workspace
        </h4>
        <ul className="space-y-2">
          {agents.map((a) => {
            const info = getAgentInfo(a.slug);
            const isCore = a.core === true;
            const isBusy = busySlug === a.slug;
            return (
              <li
                key={a.slug}
                className="flex items-start justify-between gap-3 rounded-lg border border-bg-border bg-bg-deep/30 p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-bold text-sm ${info.textClass}`}>
                      {a.display_name || info.label}
                    </span>
                    {isCore ? (
                      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-accent/15 text-accent border border-accent/30">
                        <Lock className="w-3 h-3" />
                        Core · always on
                      </span>
                    ) : a.enabled ? (
                      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        <CheckCircle2 className="w-3 h-3" />
                        Enabled
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-elev/60 text-fg-dim border border-bg-border">
                        Disabled
                      </span>
                    )}
                  </div>
                  <p className="text-[11.5px] text-fg-muted mt-1 leading-relaxed">
                    {info.tagline}
                  </p>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  {!isCore && (
                    <>
                      {a.enabled ? (
                        <button
                          type="button"
                          onClick={() => callToggle({ action: "disable", slug: a.slug })}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev px-2.5 py-1 text-[11.5px] font-bold text-fg-muted hover:text-fg disabled:opacity-50 transition-colors"
                        >
                          {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                          Disable
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => callToggle({ action: "enable", slug: a.slug })}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 rounded-md bg-accent text-bg-deep px-2.5 py-1 text-[11.5px] font-bold hover:bg-accent/90 disabled:opacity-60 transition-colors"
                        >
                          {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                          Enable
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (!confirm(`Remove ${info.label} from this workspace? You can add it back any time.`)) return;
                          void callToggle({ action: "remove", slug: a.slug });
                        }}
                        disabled={isBusy}
                        className="inline-flex items-center justify-center rounded-md border border-bg-border bg-bg-elev px-2 py-1 text-fg-dim hover:text-red-300 hover:border-red-500/40 disabled:opacity-50 transition-colors"
                        title="Remove from workspace"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Add-on candidates */}
      {addOnCandidates.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">
            Available add-ons
          </h4>
          <p className="text-[11.5px] text-fg-muted leading-relaxed">
            These C-suite agents are part of the empire. Add the ones your team will use — each gets its own chat picker entry and its own area in the dashboard. Solara and Helios stay your CRM core.
          </p>
          <ul className="grid sm:grid-cols-2 gap-2">
            {addOnCandidates.map((slug) => {
              const info = getAgentInfo(slug);
              const reg = AGENT_REGISTRY[slug];
              const isBusy = busySlug === slug;
              return (
                <li
                  key={slug}
                  className="rounded-lg border border-bg-border bg-bg-deep/30 p-3 flex flex-col gap-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className={`font-bold text-sm ${info.textClass}`}>{info.label}</div>
                      <div className="text-[11.5px] text-fg-muted mt-0.5 leading-relaxed">
                        {reg?.role || info.tagline}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => callToggle({ action: "add", slug })}
                    disabled={isBusy}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md bg-accent text-bg-deep px-2.5 py-1.5 text-[12px] font-bold hover:bg-accent/90 disabled:opacity-60 transition-colors"
                  >
                    {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    Add to workspace
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
