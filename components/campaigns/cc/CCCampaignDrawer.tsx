"use client";

/**
 * CCCampaignDrawer — slide-in detail for one Constant Contact campaign. Tabs:
 *   Overview → headline stats (Stat tiles)
 *   Links    → per-URL click breakdown
 *   Actions  → rename, cancel a scheduled send, resend to non-openers, view preview, delete
 * Data: /api/campaigns/constant-contact/campaigns/[id] (+ /metrics). Actions are
 * admin-gated + dry-run-safe on the server; on success we call onChanged().
 */

import { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";
import { Stat } from "@/components/Card";
import type { CampaignRef } from "../ConstantContactConsole";

type Detail = { ok: boolean; activity_id?: string | null; activity?: { permalink_url?: string } | null; schedule?: unknown; stats?: unknown };
type Metrics = { ok: boolean; stats?: unknown; links?: unknown; trend?: unknown[] };

type TabKey = "overview" | "links" | "actions";

function num(o: Record<string, unknown> | undefined | null, ...keys: string[]): number {
  if (!o) return 0;
  for (const k of keys) {
    const v = o[k];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}
function extractStats(stats: unknown) {
  const r = stats as { results?: { stats?: Record<string, unknown> }[]; stats?: Record<string, unknown> } | Record<string, unknown> | null;
  const s = (r as { results?: { stats?: Record<string, unknown> }[] })?.results?.[0]?.stats
    || (r as { stats?: Record<string, unknown> })?.stats
    || (r as Record<string, unknown>)
    || {};
  const sends = num(s, "em_sends", "sends");
  return {
    sends,
    opens: num(s, "em_opens", "opens"),
    unique_opens: num(s, "em_unique_opens", "unique_opens"),
    clicks: num(s, "em_clicks", "clicks"),
    bounces: num(s, "em_bounces", "bounces"),
    optouts: num(s, "em_optouts", "optouts", "opt_outs"),
    open_rate: sends ? num(s, "em_opens", "opens") / sends : 0,
    click_rate: sends ? num(s, "em_clicks", "clicks") / sends : 0,
  };
}
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function CCCampaignDrawer({ campaign, onClose, onChanged }: { campaign: CampaignRef; onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<TabKey>("overview");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(campaign.name);
  const [resendSubject, setResendSubject] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);

  const id = campaign.campaign_id;
  const statusUpper = (campaign.status || "").toUpperCase();
  const isScheduled = statusUpper === "SCHEDULED";
  const isSent = ["DONE", "EXECUTING", "SENT", "COMPLETED"].includes(statusUpper);

  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([
      fetch(`/api/campaigns/constant-contact/campaigns/${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => r.json()),
      fetch(`/api/campaigns/constant-contact/campaigns/${encodeURIComponent(id)}/metrics`, { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([d, m]) => {
        if (!alive) return;
        if (!d.ok) setError(d.message || d.error || "load_failed");
        setDetail(d);
        setMetrics(m);
      })
      .catch((e) => { if (alive) setError(String(e?.message || e)); });
    return () => { alive = false; };
  }, [id]);

  async function act(kind: string, run: () => Promise<Response>, okText: string) {
    setBusy(kind);
    setNotice(null);
    try {
      const r = await run();
      const j = await r.json();
      if (!r.ok || !j.ok) { setNotice({ kind: "err", text: j.message || j.error || "failed" }); return; }
      if (j.dry_run) { setNotice({ kind: "info", text: "Dry run — live sending is off for Constant Contact." }); return; }
      setNotice({ kind: "ok", text: okText });
      onChanged();
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setBusy("");
    }
  }

  const s = extractStats(metrics?.stats ?? detail?.stats);
  // CC's EmailLinks report returns the rows under `link_click_counts`.
  const linkRows = ((metrics?.links as { link_click_counts?: unknown[]; tracking_activities?: unknown[]; results?: unknown[] } | undefined)?.link_click_counts
    || (metrics?.links as { tracking_activities?: unknown[] } | undefined)?.tracking_activities
    || (metrics?.links as { results?: unknown[] } | undefined)?.results
    || (Array.isArray(metrics?.links) ? (metrics?.links as unknown[]) : [])) as Record<string, unknown>[];
  const permalink = detail?.activity?.permalink_url;

  const tabCls = (k: TabKey) => `px-3 py-1.5 text-[12px] rounded-md ${tab === k ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <button type="button" onClick={onClose} className="flex-1 bg-black/60 backdrop-blur-sm cursor-default" aria-label="Close" />
      <aside className="relative w-full sm:w-[560px] h-full bg-bg-elev border-l border-bg-border shadow-[-12px_0_32px_-8px_rgba(0,0,0,0.6)] flex flex-col">
        <header className="px-5 py-4 border-b border-bg-border/60 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg truncate">{campaign.name || "(untitled)"}</div>
            <div className="text-[11px] text-fg-dim uppercase tracking-wide">{(campaign.status || "").toLowerCase()}</div>
          </div>
          <button type="button" onClick={onClose} className="text-fg-dim hover:text-fg"><X className="h-4 w-4" /></button>
        </header>

        <nav className="flex gap-1 px-5 pt-3">
          <button type="button" className={tabCls("overview")} onClick={() => setTab("overview")}>Overview</button>
          <button type="button" className={tabCls("links")} onClick={() => setTab("links")}>Links</button>
          <button type="button" className={tabCls("actions")} onClick={() => setTab("actions")}>Actions</button>
        </nav>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {error && <div className="text-[12px] text-status-warm">{error}</div>}

          {tab === "overview" && (
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Sends" value={s.sends.toLocaleString()} />
              <Stat label="Opens" value={s.opens.toLocaleString()} hint={`${s.unique_opens.toLocaleString()} unique`} />
              <Stat label="Open rate" value={pct(s.open_rate)} accent />
              <Stat label="Clicks" value={s.clicks.toLocaleString()} />
              <Stat label="Click rate" value={pct(s.click_rate)} />
              <Stat label="Bounces" value={s.bounces.toLocaleString()} />
              <Stat label="Opt-outs" value={s.optouts.toLocaleString()} />
            </div>
          )}

          {tab === "links" && (
            linkRows.length === 0 ? (
              <div className="text-[12px] text-fg-dim italic">No link clicks recorded yet.</div>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-fg-dim border-b border-bg-border">
                    <th className="py-2 font-medium">Link</th>
                    <th className="py-2 font-medium text-right">Clicks</th>
                  </tr>
                </thead>
                <tbody>
                  {linkRows.map((l, i) => (
                    <tr key={i} className="border-b border-bg-border/40 last:border-b-0">
                      <td className="py-2 text-fg-muted max-w-[380px] truncate">{String(l.url || l.link_url || "—")}</td>
                      <td className="py-2 text-right tabular-nums text-fg">{num(l, "click_count", "clicks", "unique_click_count").toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {tab === "actions" && (
            <div className="space-y-4">
              {notice && (
                <div className={`text-[12px] rounded-md border px-2.5 py-1.5 ${notice.kind === "ok" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : notice.kind === "info" ? "border-status-warm/40 bg-status-warm/5 text-status-warm" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>
                  {notice.text}
                </div>
              )}

              {/* Rename */}
              <div className="space-y-1">
                <div className="text-[11px] uppercase tracking-wide text-fg-dim">Rename</div>
                <div className="flex gap-2">
                  <input value={name} onChange={(e) => setName(e.target.value)} className="flex-1 text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5" />
                  <button
                    type="button"
                    disabled={busy === "rename" || !name.trim() || name === campaign.name}
                    onClick={() => act("rename", () => fetch(`/api/campaigns/constant-contact/campaigns/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }), "Renamed.")}
                    className="rounded-md border border-bg-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50"
                  >Save</button>
                </div>
              </div>

              {isScheduled && (
                <button
                  type="button"
                  disabled={busy === "cancel"}
                  onClick={() => act("cancel", () => fetch(`/api/campaigns/constant-contact/campaigns/${encodeURIComponent(id)}/schedule`, { method: "DELETE" }), "Scheduled send cancelled.")}
                  className="inline-flex items-center gap-1.5 rounded-md border border-status-warm/40 bg-status-warm/5 text-status-warm px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
                >{busy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Cancel scheduled send</button>
              )}

              {isSent && (
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-fg-dim">Resend to non-openers</div>
                  <div className="flex gap-2">
                    <input value={resendSubject} onChange={(e) => setResendSubject(e.target.value)} placeholder="New subject line" className="flex-1 text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5" />
                    <button
                      type="button"
                      disabled={busy === "resend" || !resendSubject.trim()}
                      onClick={() => act("resend", () => fetch(`/api/campaigns/constant-contact/campaigns/${encodeURIComponent(id)}/resend`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resend_subject: resendSubject }) }), "Resend queued to non-openers.")}
                      className="rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50"
                    >{busy === "resend" ? "…" : "Resend"}</button>
                  </div>
                </div>
              )}

              {permalink && (
                <a href={permalink} target="_blank" rel="noreferrer" className="inline-block text-[12px] text-accent underline">View sent email ↗</a>
              )}

              {/* Delete */}
              <div className="pt-2 border-t border-bg-border/50">
                {!confirmDelete ? (
                  <button type="button" onClick={() => setConfirmDelete(true)} className="text-[12px] text-red-300 hover:text-red-200">Delete campaign</button>
                ) : (
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="text-fg-muted">Delete permanently?</span>
                    <button
                      type="button"
                      disabled={busy === "delete"}
                      onClick={() => act("delete", () => fetch(`/api/campaigns/constant-contact/campaigns/${encodeURIComponent(id)}`, { method: "DELETE" }), "Campaign deleted.")}
                      className="font-semibold text-red-300"
                    >{busy === "delete" ? "Deleting…" : "Confirm"}</button>
                    <button type="button" onClick={() => setConfirmDelete(false)} className="text-fg-dim">Cancel</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
