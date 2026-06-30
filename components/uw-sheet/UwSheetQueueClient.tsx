"use client";

/**
 * UwSheetQueueClient — the deal-packet review cards for /uw-sheet.
 *
 * Renders each pending scrub_candidate with the full underwriting packet Ezra
 * needs to decide, plus Approve / Decline. Approve POSTs to
 * /api/scrub-candidates/[id] which createRecord()s the lead at the uw_sheet
 * stage (firing the follow-up lifecycle); Decline discards it.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2, XCircle, Loader2, Building2, Phone, Mail, TrendingUp,
  Layers, Gauge, Repeat, FileSpreadsheet,
} from "lucide-react";

type Funder = { funder?: string; frequency?: string; payment?: number };

type LeadData = {
  company?: string;
  business_name?: string;
  contact_name?: string;
  name?: string;
  phone?: string;
  email?: string;
  state?: string;
  monthly_revenue?: number;
  annual_revenue?: number;
  mca_positions?: number;
  current_funders?: Funder[];
  current_funders_text?: string;
  previously_submitted?: boolean;
  [k: string]: unknown;
};

export type ScrubCandidate = {
  id: string;
  tier: "good" | "review" | string;
  score: number;
  reasons: string[] | null;
  decline_reason: string | null;
  previously_submitted: boolean;
  leverage_pct: number | null;
  monthly_revenue: number | null;
  lead_data: LeadData;
  source_file: string | null;
  scrubbed_at: string | null;
  created_at: string;
};

const TIER_TONE: Record<string, string> = {
  good: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  review: "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return "$" + Math.round(n).toLocaleString();
}

export function UwSheetQueueClient({ initialRows }: { initialRows: ScrubCandidate[] }) {
  const router = useRouter();
  const [rows, setRows] = useState<ScrubCandidate[]>(initialRows);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, action: "approve" | "decline") {
    setError(null);
    let note: string | undefined;
    if (action === "decline") {
      const entered = window.prompt("Reason for declining (optional):") ?? undefined;
      note = entered;
    }
    setBusy(id);
    try {
      const res = await fetch(`/api/scrub-candidates/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, note }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || !j.ok) {
        setError(j.message || j.error || `http_${res.status}`);
        setBusy(null);
        return;
      }
      // Optimistically drop the card; refresh server data in the background.
      setRows((prev) => prev.filter((r) => r.id !== id));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "network_error");
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-8 text-center text-fg-muted text-sm">
        Queue clear — no deals waiting for review. Solara surfaces new ones here as it scrubs
        incoming sheets.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-400">
          {error}
        </div>
      )}
      <div className="text-xs text-fg-dim">{rows.length} deal{rows.length === 1 ? "" : "s"} pending</div>
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((c) => (
          <CandidateCard key={c.id} c={c} busy={busy === c.id} onAct={act} />
        ))}
      </div>
    </div>
  );
}

function CandidateCard({
  c, busy, onAct,
}: {
  c: ScrubCandidate;
  busy: boolean;
  onAct: (id: string, action: "approve" | "decline") => void;
}) {
  const d = c.lead_data || {};
  const name = d.company || d.business_name || d.name || "(unnamed business)";
  const funders = Array.isArray(d.current_funders) ? d.current_funders : [];
  const tone = TIER_TONE[c.tier] || "bg-slate-500/15 text-slate-300 border-slate-500/30";

  return (
    <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-4 flex flex-col gap-3">
      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <Building2 className="w-4 h-4 text-fg-muted shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-bold text-sm text-fg truncate">{name}</div>
            <div className="text-[11px] text-fg-dim truncate">
              {d.contact_name || "—"}{d.state ? ` · ${d.state}` : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {c.previously_submitted && (
            <span className="inline-flex items-center gap-1 text-[9.5px] font-mono uppercase tracking-wider border border-sky-500/30 bg-sky-500/15 text-sky-300 rounded px-1.5 py-0.5">
              <Repeat className="w-3 h-3" /> prev
            </span>
          )}
          <span className={`inline-flex items-center text-[9.5px] font-mono uppercase tracking-wider border rounded px-1.5 py-0.5 ${tone}`}>
            {c.tier} · {c.score}
          </span>
        </div>
      </div>

      {/* contact + metrics */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11.5px]">
        <Field icon={Phone} label="Phone" value={d.phone || "—"} />
        <Field icon={Mail} label="Email" value={d.email || "—"} />
        <Field icon={TrendingUp} label="Monthly rev" value={money(c.monthly_revenue ?? d.monthly_revenue)} />
        <Field icon={Layers} label="Positions" value={d.mca_positions != null ? String(d.mca_positions) : "—"} />
        <Field icon={Gauge} label="Leverage" value={c.leverage_pct != null ? `${c.leverage_pct}%` : "unknown"} />
        <Field icon={FileSpreadsheet} label="Source" value={c.source_file || "—"} />
      </div>

      {/* funder stack */}
      {(funders.length > 0 || d.current_funders_text) && (
        <div className="rounded-lg border border-bg-border bg-bg-deep/40 p-2">
          <div className="text-[10px] uppercase tracking-wider text-fg-dim mb-1">Existing positions</div>
          {funders.length > 0 ? (
            <ul className="space-y-0.5">
              {funders.slice(0, 6).map((f, i) => (
                <li key={i} className="text-[11px] text-fg-muted">
                  {f.funder || "?"} · {f.frequency || "?"} · {money(f.payment)}
                </li>
              ))}
              {funders.length > 6 && (
                <li className="text-[10px] text-fg-dim">+{funders.length - 6} more</li>
              )}
            </ul>
          ) : (
            <div className="text-[11px] text-fg-muted line-clamp-2">{d.current_funders_text}</div>
          )}
        </div>
      )}

      {/* scrub reasoning */}
      {Array.isArray(c.reasons) && c.reasons.length > 0 && (
        <div className="text-[11px] text-fg-dim leading-relaxed">
          <span className="text-fg-muted font-medium">Why: </span>
          {c.reasons.join(" · ")}
        </div>
      )}

      {/* actions */}
      <div className="flex items-center gap-2 pt-1 mt-auto">
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(c.id, "approve")}
          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600/90 hover:bg-emerald-600 text-white text-xs font-bold py-1.5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAct(c.id, "decline")}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-bg-border bg-bg-elev/50 hover:bg-bg-elev text-fg-muted hover:text-fg text-xs font-bold py-1.5 px-3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <XCircle className="w-3.5 h-3.5" />
          Decline
        </button>
      </div>
    </div>
  );
}

function Field({
  icon: Icon, label, value,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <Icon className="w-3 h-3 text-fg-dim shrink-0" />
      <span className="text-fg-dim shrink-0">{label}:</span>
      <span className="text-fg-muted truncate">{value}</span>
    </div>
  );
}
