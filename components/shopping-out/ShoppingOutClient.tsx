"use client";

/**
 * Shopping Out — Jordan/Oasis 2026-05-23 (Phase 4).
 *
 * Multi-lender outreach UI on top of the existing shop-out engine:
 *   - POST /api/applications/[id]/shop-out  → fires the package
 *   - GET  /api/applications/[id]/lender-threads → reads what's been sent
 *   - GET  /api/manifest/sun/records/application → active apps to pick from
 *   - GET  /api/manifest/sun/records/lender      → lenders to pick from
 *
 * No backend changes for v1. UI flow:
 *   1. Pick application (search/filter active ones)
 *   2. Pick lenders (default = match-fitness ranked from dry-run plan)
 *   3. Confirm attachments + notes
 *   4. Preview email (one shared body)
 *   5. Send → application_lender_threads rows land at status='pending'
 *   6. Result panel shows existing threads for this application
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, PageHeader, Tag } from "@/components/Card";
import { ShoppingBag, Send, RefreshCcw, Loader2 } from "lucide-react";

type AppRow = {
  id: string;
  data: Record<string, unknown>;
  updated_at: string;
};

type LenderRow = {
  id: string;
  data: Record<string, unknown>;
};

type Thread = {
  id: string;
  lender_id: string;
  lender_name: string;
  status: string;
  subject: string | null;
  sent_at: string | null;
  last_response_at: string | null;
  last_response_summary: string | null;
  last_error: string | null;
  created_at: string;
};

type PlanRow = {
  lender_id: string;
  lender_name: string;
  recipient_email: string | null;
  match_score: number;
  blockers: string[];
  rendered_subject: string;
};

// Application statuses that DON'T qualify for shopping out (terminal /
// post-funded states). Mirror of the keep-list from migration 064.
const SHOPPABLE_STATUSES = new Set<string>([
  "application_in",
  "shopping",
  "missing_info",
  "requested_docs",
  "docs_out",
  "login",
  "follow_ups",
]);

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  sent: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  responded: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  approved: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  declined: "bg-red-500/15 text-red-300 border-red-500/30",
  info_requested: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  no_response: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function ShoppingOutClient({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  const params = useSearchParams();
  const presetAppId = params.get("application");

  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [lenders, setLenders] = useState<LenderRow[] | null>(null);
  const [appSearch, setAppSearch] = useState("");
  const [selectedAppId, setSelectedAppId] = useState<string | null>(presetAppId);
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [selectedLenderIds, setSelectedLenderIds] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Load active applications + lenders on mount.
  useEffect(() => {
    if (!tenantId) return;
    (async () => {
      try {
        const [appsRes, lendersRes] = await Promise.all([
          fetch(`/api/manifest/${tenantSlug}/records/application?limit=500`, {
            credentials: "include",
          }),
          fetch(`/api/manifest/${tenantSlug}/records/lender?limit=500`, {
            credentials: "include",
          }),
        ]);
        const appsJson = await appsRes.json();
        const lendersJson = await lendersRes.json();
        setApps(((appsJson.records || appsJson.rows || []) as AppRow[]) || []);
        setLenders(((lendersJson.records || lendersJson.rows || []) as LenderRow[]) || []);
      } catch {
        setApps([]);
        setLenders([]);
      }
    })();
  }, [tenantSlug, tenantId]);

  // Filter to active applications and apply free-text search.
  const visibleApps = useMemo(() => {
    if (!apps) return [];
    const needle = appSearch.trim().toLowerCase();
    return apps.filter((a) => {
      const status = String(a.data.status || "");
      if (!SHOPPABLE_STATUSES.has(status)) return false;
      if (!needle) return true;
      const haystack = [
        a.data.business_name,
        a.data.contact_name,
        a.data.email,
        a.data.phone,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [apps, appSearch]);

  const selectedApp = useMemo(
    () => apps?.find((a) => a.id === selectedAppId) || null,
    [apps, selectedAppId],
  );

  // Refresh plan + threads whenever the selected application changes.
  const refreshPlanAndThreads = useCallback(async () => {
    if (!selectedAppId || !lenders) return;
    setPlanLoading(true);
    try {
      const allLenderIds = lenders.map((l) => l.id);
      const [planRes, threadsRes] = await Promise.all([
        fetch(`/api/applications/${selectedAppId}/shop-out`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            lender_ids: allLenderIds,
            cc_emails: [],
            attachments: [],
            dry_run: true,
          }),
        }),
        fetch(`/api/applications/${selectedAppId}/lender-threads`, {
          credentials: "include",
        }),
      ]);
      const planJson = await planRes.json();
      const threadsJson = await threadsRes.json();
      if (planJson.ok && Array.isArray(planJson.plan)) {
        // Rank by match_score desc; preserve only entries with a real
        // recipient_email (no point pre-selecting a lender we can't reach).
        const ranked: PlanRow[] = planJson.plan
          .map((p: Record<string, unknown>) => ({
            lender_id: String(p.lender_id || ""),
            lender_name: String(p.lender_name || "(unknown)"),
            recipient_email: typeof p.recipient_email === "string" ? p.recipient_email : null,
            match_score: typeof p.match_score === "number" ? p.match_score : 0,
            blockers: Array.isArray(p.blockers)
              ? (p.blockers as string[]).filter((b) => typeof b === "string")
              : [],
            rendered_subject: String(p.rendered_subject || ""),
          }))
          .sort((a: PlanRow, b: PlanRow) => b.match_score - a.match_score);
        setPlan(ranked);
        // Default selection: top 5 contactable lenders with zero blockers.
        const defaults = new Set<string>(
          ranked
            .filter((r) => r.recipient_email && r.blockers.length === 0)
            .slice(0, 5)
            .map((r) => r.lender_id),
        );
        setSelectedLenderIds(defaults);
      } else {
        setPlan([]);
        setSelectedLenderIds(new Set());
      }
      if (threadsJson.ok) {
        setThreads(threadsJson.threads || []);
      } else {
        setThreads([]);
      }
    } finally {
      setPlanLoading(false);
    }
  }, [selectedAppId, lenders]);

  useEffect(() => {
    if (selectedAppId && lenders) refreshPlanAndThreads();
  }, [selectedAppId, lenders, refreshPlanAndThreads]);

  const toggleLender = (id: string) => {
    setSelectedLenderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!selectedAppId || selectedLenderIds.size === 0) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch(`/api/applications/${selectedAppId}/shop-out`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          lender_ids: Array.from(selectedLenderIds),
          cc_emails: [],
          attachments: [],
          body_template: notes.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        setSendResult({
          ok: true,
          message: `Queued ${json.queued} lender thread${json.queued === 1 ? "" : "s"}${
            json.blocked ? ` · ${json.blocked} blocked` : ""
          }. Physical SMTP fires via Solara bridge — see Automations.`,
        });
        await refreshPlanAndThreads();
      } else {
        setSendResult({ ok: false, message: json.error || "Send failed." });
      }
    } catch (err) {
      setSendResult({ ok: false, message: String((err as Error).message || err) });
    } finally {
      setSending(false);
    }
  };

  if (!tenantId) {
    return (
      <Card>
        <div className="text-sm text-fg-muted leading-relaxed">
          Preview mode — Shopping Out is operator-only. Sign in as the SunBiz
          tenant to pick applications, rank lenders, and send packages.
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Shopping Out"
        subtitle="Pick an application, pick lenders, send the package."
        action={<Tag tone="info">Phase 4 · live engine</Tag>}
      />

      {/* Step 1 — Pick application */}
      <Card>
        <div className="space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
            1 · Application
          </div>
          <input
            type="search"
            value={appSearch}
            onChange={(e) => setAppSearch(e.target.value)}
            placeholder="Search by business / contact / email…"
            className="w-full text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg placeholder:text-fg-dim"
          />
          {apps === null ? (
            <div className="text-xs text-fg-dim italic py-4 text-center">Loading active applications…</div>
          ) : visibleApps.length === 0 ? (
            <div className="text-xs text-fg-dim italic py-4 text-center">
              No active applications match. Apps in funded / declined / dead don&apos;t qualify.
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-md border border-bg-border divide-y divide-bg-border">
              {visibleApps.slice(0, 50).map((a) => {
                const isSelected = a.id === selectedAppId;
                const biz = String(a.data.business_name || "(unnamed)");
                const status = String(a.data.status || "—");
                const contact = String(a.data.contact_name || "");
                const revenue = a.data.monthly_revenue;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setSelectedAppId(a.id)}
                    className={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 hover:bg-bg-elev/60 ${
                      isSelected ? "bg-accent/10" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <div className={`text-[13px] font-semibold truncate ${isSelected ? "text-accent" : "text-fg"}`}>
                        {biz}
                      </div>
                      <div className="text-[11px] text-fg-dim truncate">
                        {contact ? `${contact} · ` : ""}
                        {revenue != null ? `$${Number(revenue).toLocaleString()}/mo` : "revenue unknown"}
                      </div>
                    </div>
                    <span className="text-[10px] uppercase font-mono text-fg-muted shrink-0">
                      {status.replace(/_/g, " ")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Step 2 — Pick lenders (ranked) */}
      {selectedAppId && (
        <Card>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
                  2 · Lenders
                </div>
                <div className="text-[11.5px] text-fg-muted mt-0.5">
                  {typeof selectedApp?.data.business_name === "string" && (
                    <>
                      Ranking against{" "}
                      <span className="font-semibold text-fg">
                        {selectedApp.data.business_name}
                      </span>
                      .
                    </>
                  )}{" "}
                  Top-5 contactable lenders pre-selected.
                </div>
              </div>
              <button
                type="button"
                onClick={refreshPlanAndThreads}
                disabled={planLoading}
                className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-50"
              >
                <RefreshCcw className={`w-3 h-3 ${planLoading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            {planLoading && plan === null ? (
              <div className="text-xs text-fg-dim italic py-4 text-center inline-flex items-center gap-2 justify-center w-full">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Scoring lenders…
              </div>
            ) : plan && plan.length > 0 ? (
              <div className="max-h-80 overflow-y-auto rounded-md border border-bg-border divide-y divide-bg-border">
                {plan.map((p) => {
                  const isSelected = selectedLenderIds.has(p.lender_id);
                  const blocked = p.blockers.length > 0;
                  const missingEmail = !p.recipient_email;
                  return (
                    <label
                      key={p.lender_id}
                      className={`flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-bg-elev/60 ${
                        isSelected ? "bg-accent/10" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleLender(p.lender_id)}
                        disabled={missingEmail}
                        className="mt-1 accent-accent"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[13px] font-semibold text-fg truncate">
                            {p.lender_name}
                          </span>
                          <span className="text-[10px] font-mono text-fg-dim">
                            score {p.match_score.toFixed(2)}
                          </span>
                        </div>
                        <div className="text-[11px] text-fg-muted truncate">
                          {p.recipient_email || (
                            <span className="text-rose-300">no contact email — uncontactable</span>
                          )}
                        </div>
                        {blocked && (
                          <div className="text-[10.5px] text-amber-300 mt-1 leading-snug">
                            ⚠ {p.blockers.join(" · ")}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-fg-dim italic py-4 text-center">
                No lenders in directory. Add some on the Lenders page first.
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Step 3 — Notes + Send */}
      {selectedAppId && plan && plan.length > 0 && (
        <Card>
          <div className="space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
              3 · Notes (optional — injected into email body)
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any context for the lenders — e.g. 'Owner is finalist for SBA but needs short-term bridge'…"
              rows={4}
              maxLength={2000}
              className="w-full text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg resize-none"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-fg-dim">
                {selectedLenderIds.size} lender{selectedLenderIds.size === 1 ? "" : "s"} selected
                {" · "}
                attachments inherited from the application&apos;s documents
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={sending || selectedLenderIds.size === 0}
                className="inline-flex items-center gap-2 text-[12.5px] font-semibold px-4 py-2 rounded-md bg-accent text-bg-deep disabled:opacity-40"
              >
                {sending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                Send to {selectedLenderIds.size || 0} lender{selectedLenderIds.size === 1 ? "" : "s"}
              </button>
            </div>
            {sendResult && (
              <div
                className={`rounded-md border p-2.5 text-[12px] ${
                  sendResult.ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-100"
                }`}
              >
                {sendResult.message}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Step 4 — Threads for this app */}
      {selectedAppId && (
        <Card>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
                Existing lender threads
              </div>
              <Tag tone="info">
                <ShoppingBag className="w-3 h-3 mr-1 inline" />
                {threads.length}
              </Tag>
            </div>
            {threads.length === 0 ? (
              <div className="text-xs text-fg-dim italic py-3 text-center">
                No threads yet. The first send creates one row per lender.
              </div>
            ) : (
              <div className="rounded-md border border-bg-border divide-y divide-bg-border">
                {threads.map((t) => {
                  const tone =
                    STATUS_TONE[t.status] || "bg-slate-500/15 text-slate-300 border-slate-500/30";
                  return (
                    <div key={t.id} className="px-3 py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-fg truncate">
                          {t.lender_name}
                        </div>
                        <div className="text-[11px] text-fg-dim truncate">
                          {t.subject || "(no subject)"}
                        </div>
                        {t.last_response_summary && (
                          <div className="text-[11.5px] text-fg-muted mt-1 leading-snug">
                            ↳ {t.last_response_summary}
                          </div>
                        )}
                        {t.last_error && (
                          <div className="text-[11px] text-rose-300 mt-1">⚠ {t.last_error}</div>
                        )}
                      </div>
                      <div className="text-right shrink-0 space-y-1">
                        <span
                          className={`inline-block text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded border ${tone}`}
                        >
                          {t.status.replace(/_/g, " ")}
                        </span>
                        <div className="text-[10px] text-fg-dim font-mono">
                          {t.sent_at
                            ? new Date(t.sent_at).toLocaleDateString()
                            : new Date(t.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
