"use client";

/**
 * CampaignDetailDrawer — right-side slide-in drawer for a TextTorrent campaign,
 * opened by `?campaign=<id>` over the Campaigns page. Mirrors the lead drawer
 * chrome (overlay / Esc / scroll-lock / tabbed). Loads live metrics from
 * /api/campaigns/[id]/metrics in one round trip; tabs render off that payload.
 *
 * Tabs: Overview (delivery + reply stats), Numbers (per-sender health — the
 * "which number is getting spammy" view), Replies (the native inbound replies).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { X, Megaphone, Loader2 } from "lucide-react";

type MetricsPayload = {
  ok: boolean;
  error?: string;
  message?: string;
  campaign?: {
    id: string;
    name?: string;
    status?: string;
    contact_list_id?: number;
    created_at?: string;
    credits_consumed?: number;
    total_participants?: number;
  };
  counts?: { total: number; delivered: number; failed: number; scheduled: number; processing: number };
  replies?: { count: number; rate: number; sampled: number; truncated: boolean; items: Array<{ to: string; message: string }> };
  numbers?: Array<{ send_from: string; sent: number; delivered: number; failed: number; replies: number; failure_rate: number }>;
};

type TabKey = "overview" | "numbers" | "replies";
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "numbers", label: "Numbers" },
  { key: "replies", label: "Replies" },
];

function pct(n: number) {
  return `${n}%`;
}
function healthTone(failureRate: number): { label: string; cls: string } {
  if (failureRate >= 20) return { label: "spammy", cls: "bg-red-500/20 text-red-300" };
  if (failureRate >= 10) return { label: "watch", cls: "bg-amber-500/20 text-amber-300" };
  return { label: "healthy", cls: "bg-emerald-500/15 text-emerald-300" };
}

function StatTile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-bg-border bg-bg-deep/30 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-[0.1em] text-fg-dim/80 font-semibold">{label}</div>
      <div className="text-xl font-bold text-fg mt-0.5 tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-fg-dim mt-0.5">{hint}</div>}
    </div>
  );
}

export function CampaignDetailDrawer({ campaignId }: { tenantSlug: string; campaignId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<MetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    const next = new URLSearchParams(searchParams?.toString() || "");
    next.delete("campaign");
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [close]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    fetch(`/api/campaigns/${encodeURIComponent(campaignId)}/metrics`, { credentials: "include" })
      .then((r) => r.json())
      .then((j: MetricsPayload) => {
        if (!alive) return;
        if (!j.ok) {
          setError(j.message || j.error || "load_failed");
          return;
        }
        setData(j);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [campaignId]);

  const c = data?.campaign;
  const counts = data?.counts;
  const replies = data?.replies;
  const numbers = data?.numbers || [];
  const title = c?.name || `Campaign ${campaignId}`;
  const deliveryRate = counts && counts.total ? Math.round((counts.delivered / counts.total) * 100) : null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label={`${title} metrics`}>
      <button
        type="button"
        aria-label="Close drawer"
        onClick={close}
        className="flex-1 bg-black/60 backdrop-blur-sm cursor-default"
      />
      <aside className="relative w-full sm:w-[580px] h-full bg-bg-elev border-l border-bg-border shadow-[-12px_0_32px_-8px_rgba(0,0,0,0.6)] flex flex-col">
        <header className="px-5 py-4 border-b border-bg-border/60">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-[0.12em] text-fg-dim/80 font-semibold mb-1">Campaign</div>
              <h2 className="text-lg font-bold text-fg truncate leading-tight flex items-center gap-2">
                <Megaphone className="h-4 w-4 text-fg-dim shrink-0" />
                {title}
              </h2>
              <div className="text-[11px] text-fg-dim mt-1 truncate">
                {c?.status || "—"}
                {c?.total_participants ? ` · ${c.total_participants} contacts` : ""}
                {typeof c?.credits_consumed === "number" ? ` · ${c.credits_consumed} credits` : ""}
              </div>
            </div>
            <button
              ref={closeBtnRef}
              type="button"
              onClick={close}
              aria-label="Close"
              className="p-1 rounded-md text-fg-muted hover:text-fg hover:bg-bg-deep transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        <nav className="flex gap-0.5 px-5 pt-3 border-b border-bg-border/50 overflow-x-auto">
          {TABS.map((t) => {
            const isActive = activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={`text-[11px] uppercase tracking-[0.08em] px-2.5 py-1.5 rounded-t-md border-b-2 inline-flex items-center gap-1.5 transition-colors ${
                  isActive ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg hover:bg-bg-deep/30"
                }`}
              >
                {t.label}
                {t.key === "replies" && replies?.count ? (
                  <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-accent/20 text-accent text-[9.5px] font-mono">
                    {replies.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          {error ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[13px] text-red-300">
              Couldn&apos;t load metrics: {error}
            </div>
          ) : !data ? (
            <div className="flex items-center gap-2 text-fg-dim text-[13px] py-6">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading live metrics…
            </div>
          ) : activeTab === "overview" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2.5">
                <StatTile label="Sent" value={counts?.total ?? "—"} />
                <StatTile label="Delivered" value={counts?.delivered ?? "—"} hint={deliveryRate != null ? pct(deliveryRate) : undefined} />
                <StatTile label="Failed" value={counts?.failed ?? "—"} />
                <StatTile label="Reply rate" value={replies ? pct(replies.rate) : "—"} hint={replies ? `${replies.count} replies` : undefined} />
              </div>
              {replies?.truncated && (
                <div className="text-[11px] text-fg-dim">
                  Reply rate is computed from a {replies.sampled}-message sample. Full attribution lands once the metrics
                  collector is enabled.
                </div>
              )}
            </div>
          ) : activeTab === "numbers" ? (
            numbers.length === 0 ? (
              <div className="text-fg-dim text-[13px] py-6">No per-number data for this campaign yet.</div>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-fg-dim border-b border-bg-border">
                    <th className="py-2 font-medium">Number</th>
                    <th className="py-2 font-medium text-right">Sent</th>
                    <th className="py-2 font-medium text-right">Delivered</th>
                    <th className="py-2 font-medium text-right">Failed</th>
                    <th className="py-2 font-medium text-right">Replies</th>
                    <th className="py-2 font-medium text-right">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {numbers.map((n) => {
                    const h = healthTone(n.failure_rate);
                    return (
                      <tr key={n.send_from} className="border-b border-bg-border/40 last:border-b-0">
                        <td className="py-2 text-fg font-mono text-[11px]">{n.send_from}</td>
                        <td className="py-2 text-right tabular-nums text-fg-muted">{n.sent}</td>
                        <td className="py-2 text-right tabular-nums text-fg-muted">{n.delivered}</td>
                        <td className="py-2 text-right tabular-nums text-status-hot">{n.failed}</td>
                        <td className="py-2 text-right tabular-nums text-fg-muted">{n.replies}</td>
                        <td className="py-2 text-right">
                          <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] ${h.cls}`}>
                            {n.failure_rate}% · {h.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : (
            // replies
            !replies || replies.items.length === 0 ? (
              <div className="text-fg-dim text-[13px] py-6">No replies captured yet.</div>
            ) : (
              <div className="space-y-2">
                {replies.items.map((r, i) => (
                  <div key={`${r.to}-${i}`} className="rounded-md border border-bg-border bg-bg-deep/20 px-3 py-2">
                    <div className="text-[11px] text-fg-dim font-mono">{r.to}</div>
                    <div className="text-[13px] text-fg mt-0.5 whitespace-pre-wrap break-words">{r.message}</div>
                  </div>
                ))}
                {replies.truncated && (
                  <div className="text-[11px] text-fg-dim">Showing replies from the first {replies.sampled} messages.</div>
                )}
              </div>
            )
          )}
        </div>
      </aside>
    </div>
  );
}
