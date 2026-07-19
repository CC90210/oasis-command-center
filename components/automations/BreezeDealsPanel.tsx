"use client";

/**
 * BreezeDealsPanel — the Breeze BD deal queue (scrub_candidates) on the SunBiz
 * Automations tab, with in-dashboard review.
 *
 * The mca-lead-scrubber daemon pulls UW Entry Sheets off the shared Breeze
 * Drive, verifies + scores each deal, and stages the qualified ones here as
 * pending_review. An operator can approve / decline them RIGHT HERE (or still in
 * Ezra's Telegram — same end state). Approving creates the lead at uw_sheet and
 * promotes it to a shoppable application (full UW-sheet fields + branded PDF).
 *
 * Live subs arrive without contact PII, so an approved deal is flagged
 * "Needs phone" — fill it inline (one click) to make the merchant contactable.
 *
 * Data: GET /api/automations/breeze-deals; actions: POST /api/scrub-candidates/[id]
 * and POST /api/leads/[id]/set-field (both auth-gated, tenant-scoped,
 * PII-whitelisted server-side). Refreshes every 60s.
 */

import { useCallback, useEffect, useState } from "react";
import { Banknote, AlertCircle, CheckCircle2, XCircle, Hourglass, RefreshCw, PhoneOff, Check, X, RotateCw } from "lucide-react";

type Deal = {
  id: string;
  status: string;
  tier: string;
  score: number;
  reasons: string[];
  previously_submitted: boolean;
  leverage_pct: number | null;
  monthly_revenue: number | null;
  business_name: string;
  iso_broker: string | null;
  source_file: string | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_lead_id: string | null;
  needs_lookup: boolean;
};

type ApiResponse = {
  ok: boolean;
  counts: { pending_review: number; approved: number; declined: number; total: number };
  status: string;
  deals: Deal[];
  error?: string;
};

const FILTERS = [
  { key: "pending_review", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "declined", label: "Declined" },
  { key: "all", label: "All" },
] as const;

export function BreezeDealsPanel() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("pending_review");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (status: string) => {
    try {
      setRefreshing(true);
      const res = await fetch(`/api/automations/breeze-deals?status=${status}&limit=25`);
      const j = (await res.json()) as ApiResponse;
      if (!j.ok) {
        setError(j.error || `http_${res.status}`);
        return;
      }
      setData(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh(filter);
    const t = setInterval(() => void refresh(filter), 60_000);
    return () => clearInterval(t);
  }, [filter, refresh]);

  if (error) {
    return (
      <div className="rounded-xl border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>Couldn&apos;t load Breeze BD deals: {error}</span>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-xs text-fg-muted">
        Loading Breeze BD deals…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Banknote className="w-4 h-4 text-fg-muted" />
          <div className="text-sm font-bold text-fg">Breeze BD deals</div>
          <span className="text-[10px] uppercase tracking-wider text-fg-dim border border-bg-border rounded-full px-1.5 py-0.5">
            {data.counts.pending_review} pending · {data.counts.total} total
          </span>
          {refreshing && <RefreshCw className="w-3 h-3 text-fg-dim animate-spin" />}
        </div>
        <div className="flex items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                filter === f.key
                  ? "border-accent/60 bg-accent/10 text-fg"
                  : "border-bg-border bg-bg-elev/50 text-fg-muted hover:bg-bg-elev hover:text-fg"
              }`}
            >
              {f.label}
              {f.key !== "all" && (
                <span className="ml-1 text-fg-dim font-mono">
                  {data.counts[f.key as keyof typeof data.counts]}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="text-[11px] text-fg-muted leading-relaxed">
        UW Entry Sheets pulled off the shared Breeze Drive, verified and scored by the scrubber
        daemon. Qualified deals wait here as <span className="text-fg">Pending</span> —{" "}
        <span className="text-fg">Approve</span> to create the lead and promote it to a shoppable
        application, or <span className="text-fg">Decline</span>. Approved subs with no phone are
        flagged <span className="text-status-warm">Needs phone</span> for a one-click fill.
      </div>

      {data.deals.length === 0 ? (
        <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-6 text-center text-xs text-fg-muted">
          No {filter === "all" ? "" : `${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} `}
          deals yet. New UW sheets land here within ~2 minutes of the scrubber&apos;s next pass.
        </div>
      ) : (
        <div className="space-y-2">
          {data.deals.map((d) => (
            <DealRow key={d.id} deal={d} onChanged={() => void refresh(filter)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DealRow({ deal, onChanged }: { deal: Deal; onChanged: () => void }) {
  const [busy, setBusy] = useState<null | "approve" | "decline" | "retry_promote" | "phone">(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phone, setPhone] = useState("");

  const act = useCallback(
    async (action: "approve" | "decline" | "retry_promote") => {
      setBusy(action);
      setRowError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/scrub-candidates/${deal.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const j = (await res.json()) as {
          ok: boolean; error?: string; message?: string;
          promoted?: boolean; promote_error?: string; missing_critical?: string[];
        };
        if (!j.ok) {
          setRowError(j.message || j.error || `http_${res.status}`);
          return;
        }
        if (action === "approve" && j.promoted === false) {
          setNotice(`Lead created, but promote failed (${j.promote_error || "error"}). Use Retry.`);
        } else if (j.missing_critical && j.missing_critical.length) {
          setNotice(`Promoted — missing: ${j.missing_critical.join(", ")}.`);
        }
        onChanged();
      } catch (e) {
        setRowError(e instanceof Error ? e.message : "action_failed");
      } finally {
        setBusy(null);
      }
    },
    [deal.id, onChanged],
  );

  const savePhone = useCallback(async () => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10) {
      setRowError("Enter a 10-digit phone");
      return;
    }
    if (!deal.created_lead_id) return;
    setBusy("phone");
    setRowError(null);
    try {
      const res = await fetch(`/api/leads/${deal.created_lead_id}/set-field`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "phone", value: phone.trim() }),
      });
      const j = (await res.json()) as { ok: boolean; error?: string; message?: string };
      if (!j.ok) {
        setRowError(j.message || j.error || `http_${res.status}`);
        return;
      }
      setPhone("");
      setNotice("Phone saved — merchant is now contactable.");
      onChanged();
    } catch (e) {
      setRowError(e instanceof Error ? e.message : "save_failed");
    } finally {
      setBusy(null);
    }
  }, [phone, deal.created_lead_id, onChanged]);

  return <DealRowView
    deal={deal}
    busy={busy}
    rowError={rowError}
    notice={notice}
    phone={phone}
    setPhone={setPhone}
    act={act}
    savePhone={savePhone}
  />;
}

function DealRowView({
  deal, busy, rowError, notice, phone, setPhone, act, savePhone,
}: {
  deal: Deal;
  busy: null | "approve" | "decline" | "retry_promote" | "phone";
  rowError: string | null;
  notice: string | null;
  phone: string;
  setPhone: (v: string) => void;
  act: (a: "approve" | "decline" | "retry_promote") => void;
  savePhone: () => void;
}) {
  const StatusIcon =
    deal.status === "approved" ? CheckCircle2 : deal.status === "declined" ? XCircle : Hourglass;
  const statusClass =
    deal.status === "approved"
      ? "text-status-engaged"
      : deal.status === "declined"
        ? "text-status-warm"
        : "text-accent";
  const statusLabel =
    deal.status === "approved"
      ? `Approved${deal.reviewed_by ? ` · ${deal.reviewed_by}` : ""}`
      : deal.status === "declined"
        ? `Declined${deal.reviewed_by ? ` · ${deal.reviewed_by}` : ""}`
        : "Pending review";

  // The scrubber's score reasons ("leverage 12% (+20)") in the tooltip —
  // same detail-on-hover convention as the workers panel.
  const tooltip = deal.reasons.length
    ? deal.reasons.join("\n")
    : deal.source_file || deal.id;

  return (
    <div
      className={`rounded-lg border p-3 ${
        deal.status === "pending_review"
          ? "border-bg-border bg-bg-elev/30"
          : "border-bg-border bg-bg-deep/40 opacity-90"
      }`}
      title={tooltip}
    >
      <div className="flex items-start gap-2">
        <StatusIcon className={`w-4 h-4 shrink-0 mt-0.5 ${statusClass}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-bold text-sm text-fg truncate">{deal.business_name}</div>
            <span
              className={`text-[10px] uppercase tracking-wider rounded-full border px-1.5 py-0.5 ${
                deal.tier === "good"
                  ? "border-status-engaged/40 text-status-engaged"
                  : "border-accent/40 text-accent"
              }`}
            >
              {deal.tier} · {deal.score}
            </span>
            {deal.previously_submitted && (
              <span className="text-[10px] uppercase tracking-wider rounded-full border border-status-warm/40 text-status-warm px-1.5 py-0.5">
                Prev. submitted
              </span>
            )}
            {deal.needs_lookup && deal.status !== "declined" && (
              <span className="text-[10px] uppercase tracking-wider rounded-full border border-status-warm/40 text-status-warm px-1.5 py-0.5 flex items-center gap-1">
                <PhoneOff className="w-3 h-3" /> Needs phone
              </span>
            )}
          </div>
          <div className="text-[11px] text-fg-muted mt-1 flex items-center gap-3 flex-wrap">
            {deal.monthly_revenue != null && (
              <span>{formatMoney(deal.monthly_revenue)}/mo revenue</span>
            )}
            {deal.leverage_pct != null && <span>{Number(deal.leverage_pct)}% leverage</span>}
            {deal.iso_broker && <span className="truncate">ISO: {deal.iso_broker}</span>}
          </div>
          <div className="text-[11px] text-fg-dim mt-1 flex items-center gap-3 flex-wrap">
            <span className={statusClass}>{statusLabel}</span>
            <span>{relativeTime(deal.created_at)}</span>
            {deal.source_file && (
              <span className="font-mono truncate max-w-[280px]">{deal.source_file}</span>
            )}
          </div>

          {/* Actions */}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            {deal.status === "pending_review" && (
              <>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => act("approve")}
                  className="inline-flex items-center gap-1 rounded-md border border-status-engaged/50 bg-status-engaged/10 px-2 py-1 text-[11px] font-bold text-status-engaged hover:bg-status-engaged/20 disabled:opacity-50"
                >
                  {busy === "approve" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => act("decline")}
                  className="inline-flex items-center gap-1 rounded-md border border-status-warm/50 bg-status-warm/10 px-2 py-1 text-[11px] font-bold text-status-warm hover:bg-status-warm/20 disabled:opacity-50"
                >
                  {busy === "decline" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                  Decline
                </button>
              </>
            )}
            {deal.status === "approved" && deal.created_lead_id && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => act("retry_promote")}
                className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev/50 px-2 py-1 text-[11px] font-bold text-fg-muted hover:bg-bg-elev hover:text-fg disabled:opacity-50"
                title="Re-run promote to (re)build the application + PDF"
              >
                {busy === "retry_promote" ? <RefreshCw className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
                Retry promote
              </button>
            )}
            {deal.status === "approved" && deal.created_lead_id && deal.needs_lookup && (
              <div className="inline-flex items-center gap-1">
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="Add phone…"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-32 rounded-md border border-bg-border bg-bg-deep/40 px-2 py-1 text-[11px] text-fg placeholder:text-fg-dim focus:border-accent/60 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={savePhone}
                  className="inline-flex items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] font-bold text-accent hover:bg-accent/20 disabled:opacity-50"
                >
                  {busy === "phone" ? <RefreshCw className="w-3 h-3 animate-spin" /> : "Save phone"}
                </button>
              </div>
            )}
          </div>
          {rowError && <div className="mt-1 text-[11px] text-status-warm">{rowError}</div>}
          {notice && <div className="mt-1 text-[11px] text-fg-muted">{notice}</div>}
        </div>
      </div>
    </div>
  );
}

function formatMoney(n: number): string {
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleDateString();
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 30 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return new Date(iso).toLocaleDateString();
}
