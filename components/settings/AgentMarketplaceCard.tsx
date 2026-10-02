"use client";

/**
 * AgentMarketplaceCard — Settings > AI brain's Workspace agents: the
 * workspace's AI team, from the SAME roster the AI Team page lists
 * (components/os/aiteam/roster.ts loadWorkspaceRoster, W4a 2026-10-01). The two
 * used to read unrelated sources and list different teammates (audit S2-01).
 *
 *   Department leads    one per department this workspace has a lead for.
 *   Built by your team  the teammates the workspace built in the builder,
 *                       including any its manifest does not bind yet (Off).
 *
 * Core teammates are locked: a "Core · always on" pill and no switch. Every
 * other teammate gets Disable / Enable (Enable binds one that is not bound
 * yet). There is no Remove: a removed teammate had no way back from here, and
 * an action with no inverse is a trapdoor.
 *
 * NAMES. Each teammate is shown by its roster name (its manifest binding's
 * display_name). OASIS's leads are named for their departments; the persona
 * behind any of them is never printed, and no name takes a persona's colour.
 * The hand-written job table ("Personal assistant", "Commerce", "Memory
 * keeper"...) and the "Available add-ons" list of OASIS house agents are gone
 * (audit S2-02, S2-14): CC's own agents live in Admin > Fleet.
 *
 * Writes go through POST /api/tenant/agents/toggle (owner/admin gate at the
 * API); this component renders the UI only.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

export type WorkspaceAgentRow = {
  slug: string;
  name: string;
  summary: string;
  /** Department labels a lead answers in; [] for a teammate the workspace built. */
  departments: string[];
  enabled: boolean;
  core: boolean;
  /** False: the workspace built it but its manifest does not bind it yet. */
  bound: boolean;
};

type Props = {
  leads: WorkspaceAgentRow[];
  /** The teammates the workspace built; null when they could not be read. */
  custom: WorkspaceAgentRow[] | null;
  isOwner: boolean;
  /** The AI Team page, when this viewer can open it. */
  aiTeamHref: string | null;
};

type Action = "add" | "enable" | "disable";

export function AgentMarketplaceCard({ leads: initialLeads, custom: initialCustom, isOwner, aiTeamHref }: Props) {
  const router = useRouter();
  const [leads, setLeads] = useState<WorkspaceAgentRow[]>(initialLeads);
  const [custom, setCustom] = useState<WorkspaceAgentRow[] | null>(initialCustom);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function callToggle(row: WorkspaceAgentRow, action: Action) {
    setBusySlug(row.slug);
    setError(null);
    setFlash(null);
    try {
      const r = await fetch("/api/tenant/agents/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, slug: row.slug }),
      });
      const out = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
      if (!r.ok || !out.ok) {
        setError(out.message || out.error || `toggle_failed:${r.status}`);
        return;
      }
      const on = action !== "disable";
      const update = (rows: WorkspaceAgentRow[]) =>
        rows.map((x) => (x.slug === row.slug ? { ...x, enabled: on, bound: true } : x));
      setLeads(update);
      setCustom((rows) => (rows ? update(rows) : rows));
      // Refresh server siblings (Profile primary picker, provider overrides,
      // chat shell props) from the same manifest mutation. Without this, the
      // Workspace card changed immediately while the rest of Settings kept the
      // previous roster until a full page reload.
      router.refresh();
      setFlash(on ? `${row.name} is on` : `${row.name} is off`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "toggle_failed");
    } finally {
      setBusySlug(null);
    }
  }

  const state = (a: WorkspaceAgentRow) => (a.core ? "Core" : a.enabled ? "Enabled" : "Disabled");

  if (!isOwner) {
    return (
      <div className="space-y-2">
        <p className="text-[12px] text-fg-muted leading-relaxed">
          Only the workspace owner or an admin can switch AI teammates on or off.
        </p>
        <ul className="space-y-2">
          {[...leads, ...(custom ?? [])].map((a) => (
            <li
              key={a.slug}
              className="flex items-center gap-2 rounded-md border border-bg-border bg-bg-deep/30 px-3 py-2 text-sm"
            >
              <span className="font-semibold text-fg">{a.name}</span>
              <span className="text-fg-dim text-[11px] ml-auto">{state(a)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const row = (a: WorkspaceAgentRow) => {
    const isBusy = busySlug === a.slug;
    const meta = a.departments.join(" · ");
    return (
      <li key={a.slug} className="flex items-start justify-between gap-3 rounded-lg border border-bg-border bg-bg-deep/30 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-sm text-fg">{a.name}</span>
            {meta && meta !== a.name && <span className="text-[11px] text-fg-dim">{meta}</span>}
            {a.core ? (
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
          <p className="text-[11.5px] text-fg-muted mt-1 leading-relaxed">{a.summary || "Built for this workspace."}</p>
        </div>
        {!a.core && (
          <div className="shrink-0 flex items-center gap-2">
            {a.enabled ? (
              <button
                type="button"
                onClick={() => callToggle(a, "disable")}
                disabled={isBusy}
                className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev px-2.5 py-1 text-[11.5px] font-bold text-fg-muted hover:text-fg disabled:opacity-50 transition-colors"
              >
                {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Disable
              </button>
            ) : (
              <button
                type="button"
                onClick={() => callToggle(a, a.bound ? "enable" : "add")}
                disabled={isBusy}
                className="inline-flex items-center gap-1 rounded-md bg-accent text-bg-deep px-2.5 py-1 text-[11.5px] font-bold hover:bg-accent/90 disabled:opacity-60 transition-colors"
              >
                {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Enable
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-fg-muted leading-relaxed">
        The same team the AI Team page lists. Core teammates are locked because the workspace depends on them; switch
        the others on or off here or there.
      </p>

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

      <section className="space-y-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">Department leads</h4>
        {leads.length === 0 ? (
          <p className="text-[12px] text-fg-muted">No department has a lead in this workspace yet.</p>
        ) : (
          <ul className="space-y-2">{leads.map(row)}</ul>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">Built by your team</h4>
        {custom === null ? (
          <p className="text-[12px] text-fg-muted">Couldn&apos;t load the teammates your team built. Refresh to try again.</p>
        ) : custom.length === 0 ? (
          <p className="text-[12px] text-fg-muted">
            {aiTeamHref ? "None yet. Build one from the AI Team page." : "None yet."}
          </p>
        ) : (
          <ul className="space-y-2">{custom.map(row)}</ul>
        )}
      </section>
    </div>
  );
}
