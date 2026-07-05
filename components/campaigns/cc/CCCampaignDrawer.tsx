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
import { Sparkline } from "@/components/charts/Sparkline";
import { Donut } from "@/components/charts/Donut";
import { Funnel } from "@/components/charts/Funnel";
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
  const opens = num(s, "em_opens", "opens");
  const clicks = num(s, "em_clicks", "clicks");
  return {
    sends,
    opens,
    opens_all: num(s, "em_opens_all", "opens_all") || opens,
    unique_opens: num(s, "em_unique_opens", "unique_opens") || opens,
    clicks,
    clicks_all: num(s, "em_clicks_all", "clicks_all") || clicks,
    bounces: num(s, "em_bounces", "bounces"),
    optouts: num(s, "em_optouts", "optouts", "opt_outs"),
    open_rate: sends ? opens / sends : 0,
    click_rate: sends ? clicks / sends : 0,
    device: {
      computer: num(s, "em_opens_all_computer", "opens_all_computer", "computer"),
      mobile: num(s, "em_opens_all_mobile", "opens_all_mobile", "mobile"),
      tablet: num(s, "em_opens_all_tablet", "opens_all_tablet", "tablet"),
    },
  };
}
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
  const trendVals = ((metrics?.trend || []) as { opens?: number }[]).map((t) => Number(t.opens || 0)).filter((n) => !isNaN(n));
  const deviceTotal = s.device.computer + s.device.mobile + s.device.tablet;

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
            <div className="space-y-3">
              {/* Rate rings + headline counts */}
              <div className="flex items-center gap-4 rounded-xl border border-bg-border bg-bg-panel/40 p-4">
                <div className="text-center">
                  <Donut pct={s.open_rate * 100} tone="threshold" />
                  <div className="mt-1.5 text-[10px] uppercase tracking-wide text-fg-dim">Open rate</div>
                </div>
                <div className="text-center">
                  <Donut pct={s.click_rate * 100} tone="accent" />
                  <div className="mt-1.5 text-[10px] uppercase tracking-wide text-fg-dim">Click rate</div>
                </div>
                <div className="flex-1 space-y-1.5 text-[12px]">
                  <div className="flex justify-between"><span className="text-fg-dim">Sent</span><span className="tabular-nums text-fg">{s.sends.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-fg-dim">Opens</span><span className="tabular-nums text-fg">{s.opens_all.toLocaleString()} <span className="text-fg-dim">/ {s.unique_opens.toLocaleString()} uniq</span></span></div>
                  <div className="flex justify-between"><span className="text-fg-dim">Clicks</span><span className="tabular-nums text-fg">{s.clicks.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-fg-dim">Bounces</span><span className={`tabular-nums ${s.bounces ? "text-status-warm" : "text-fg"}`}>{s.bounces.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-fg-dim">Opt-outs</span><span className={`tabular-nums ${s.optouts ? "text-status-hot" : "text-fg"}`}>{s.optouts.toLocaleString()}</span></div>
                </div>
              </div>

              {/* Delivery funnel */}
              <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4">
                <div className="mb-2.5 text-[10px] uppercase tracking-wide text-fg-dim">Delivery funnel</div>
                <Funnel steps={[{ label: "Sent", value: s.sends }, { label: "Opened", value: s.unique_opens || s.opens }, { label: "Clicked", value: s.clicks }]} />
              </div>

              {/* Opens over time */}
              {trendVals.length >= 2 && (
                <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wide text-fg-dim">Opens over time</span>
                    <span className="text-[11px] tabular-nums text-fg-muted">{s.opens_all.toLocaleString()} total</span>
                  </div>
                  <div className="text-accent"><Sparkline values={trendVals} width={480} height={48} area className="w-full" /></div>
                </div>
              )}

              {/* Opens by device */}
              {deviceTotal > 0 && (
                <div className="space-y-2 rounded-xl border border-bg-border bg-bg-panel/40 p-4">
                  <div className="text-[10px] uppercase tracking-wide text-fg-dim">Opens by device</div>
                  {[{ k: "Mobile", v: s.device.mobile }, { k: "Desktop", v: s.device.computer }, { k: "Tablet", v: s.device.tablet }].map((d) => (
                    <div key={d.k} className="flex items-center gap-3 text-[12px]">
                      <span className="w-16 text-fg-dim">{d.k}</span>
                      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-bg-elev"><div className="absolute inset-y-0 left-0 rounded-full bg-accent/50" style={{ width: `${(d.v / deviceTotal) * 100}%` }} /></div>
                      <span className="w-10 text-right tabular-nums text-fg-muted">{((d.v / deviceTotal) * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              )}
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
                      <td className="py-2 text-right tabular-nums text-fg">{num(l, "unique_clicks", "click_count", "clicks", "unique_click_count").toLocaleString()}</td>
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
