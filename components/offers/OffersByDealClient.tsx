"use client";

/**
 * OffersByDealClient — Phase 6, Jordan/Oasis 2026-05-23.
 *
 * Deal-first lender intelligence. Two views:
 *   - Accordion: one row per application; expands to show lender threads +
 *     offer records sorted by outcome priority.
 *   - Kanban: columns keyed by thread status; cards show lender + app +
 *     amount + sent date.
 *
 * Data:
 *   GET /api/manifest/sun/records/application?limit=500
 *   GET /api/applications/[id]/lender-threads
 *   GET /api/manifest/sun/records/offer?limit=500
 *
 * No new API routes. No email-scanner / portal-extractor UI — Phase 6
 * future work. "Needs Review" is a client-side flag only.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/Card";
import { formatMoney } from "@/lib/format-helpers";
import {
  ChevronDown,
  ChevronRight,
  AlertCircle,
  HandCoins,
  LayoutList,
  LayoutGrid,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type AppRow = {
  id: string;
  data: Record<string, unknown>;
  updated_at: string;
};

type OfferRow = {
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
  gmail_thread_id: string | null;
  created_at: string;
};

type ViewMode = "accordion" | "kanban";

// Team member shape from /api/team/members — used to label the per-agent
// offer filter with real names.
type TenantMember = {
  auth_user_id: string;
  full_name: string | null;
  display_name: string | null;
};

// Sentinel agent-filter value for deals with no assigned rep.
const UNASSIGNED = "__unassigned__";

// Per-application enriched bundle used for rendering.
type DealBundle = {
  app: AppRow;
  threads: Thread[];
  offers: OfferRow[];
  needsReview: boolean;
};

// ─── Constants ───────────────────────────────────────────────────────────────

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

const KANBAN_COLUMNS: { key: string; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "sent", label: "Sent" },
  { key: "responded", label: "Responded" },
  { key: "approved", label: "Approved" },
  { key: "info_requested", label: "Needs Review" },
  { key: "declined", label: "Declined" },
  { key: "no_response", label: "No Response" },
  { key: "error", label: "Error" },
];

// Text-only color per status — used where the full pill background/border
// would be too heavy (e.g. Kanban column label).
const STATUS_TEXT_COLOR: Record<string, string> = {
  pending: "text-amber-300",
  sent: "text-sky-300",
  responded: "text-violet-300",
  approved: "text-emerald-300",
  declined: "text-red-300",
  info_requested: "text-orange-300",
  no_response: "text-slate-300",
  error: "text-rose-300",
};

// Thread sort priority: best outcomes first.
const STATUS_SORT_RANK: Record<string, number> = {
  approved: 0,
  responded: 1,
  info_requested: 2,
  sent: 3,
  pending: 4,
  no_response: 5,
  declined: 6,
  error: 7,
};

function statusRank(s: string): number {
  return STATUS_SORT_RANK[s] ?? 99;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Use the shared formatMoney from lib/format-helpers — self-review
// 2026-05-24 surfaced that this file was duplicating the same util.
const fmtCurrency = formatMoney;

function StatusPill({ status }: { status: string }) {
  const tone =
    STATUS_TONE[status] ?? "bg-slate-500/15 text-slate-300 border-slate-500/30";
  return (
    <span
      className={`inline-block text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded border ${tone}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function OffersByDealClient({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  const [view, setView] = useState<ViewMode>("accordion");

  // Raw data
  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [offerRecords, setOfferRecords] = useState<OfferRow[]>([]);
  // Map of appId → threads (batch-fetched for all apps on mount)
  const [threadMap, setThreadMap] = useState<Record<string, Thread[]>>({});
  // Ref-based guard: mutable without triggering re-renders or re-fetch loops.
  const fetchedIdsRef = useRef<Set<string>>(new Set());
  // Which accordion rows are expanded
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ── Per-agent offer filter (2026-06-25) ─────────────────────────────────
  // Each deal belongs to the rep it's assigned to (app.data.assigned_to). The
  // filter lets you view one agent's offers, "Unassigned", or All — the same
  // agent-slice the lead board offers. Names come from /api/team/members.
  const [members, setMembers] = useState<TenantMember[]>([]);
  // null = All; UNASSIGNED = no rep; otherwise an auth_user_id.
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const r = await fetch("/api/team/members", { cache: "no-store" });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; members?: TenantMember[] };
        if (live && j.ok && Array.isArray(j.members)) setMembers(j.members);
      } catch {
        /* soft-fail — chips fall back to id slugs */
      }
    })();
    return () => { live = false; };
  }, []);

  // ── Load apps + offer records on mount ──────────────────────────────────
  useEffect(() => {
    if (!tenantId) {
      // Preview mode (operator viewing a tenant they don't own) — render
      // the same scaffold an empty real tenant would see: kanban columns,
      // accordion, view toggle, all visible with zero rows. The catch-all
      // dispatcher already surfaces a "preview" Tag at page chrome.
      setApps([]);
      setOfferRecords([]);
      return;
    }
    (async () => {
      try {
        const [appsRes, offersRes] = await Promise.all([
          fetch(`/api/manifest/${tenantSlug}/records/application?limit=500`, {
            credentials: "include",
          }),
          fetch(`/api/manifest/${tenantSlug}/records/offer?limit=500`, {
            credentials: "include",
          }),
        ]);
        const appsJson = await appsRes.json();
        const offersJson = await offersRes.json();
        setApps((appsJson.records || appsJson.rows || []) as AppRow[]);
        setOfferRecords((offersJson.records || offersJson.rows || []) as OfferRow[]);
      } catch {
        setApps([]);
      }
    })();
  }, [tenantSlug, tenantId]);

  // ── Batch-fetch threads for all apps once we have the app list ───────────
  // Using a ref-based guard means this function is stable (no useCallback
  // dependency churn) and the guard never triggers a re-render.
  useEffect(() => {
    if (!apps) return;
    async function fetchOne(appId: string) {
      if (fetchedIdsRef.current.has(appId)) return;
      fetchedIdsRef.current.add(appId);
      try {
        const res = await fetch(`/api/applications/${appId}/lender-threads`, {
          credentials: "include",
        });
        const json = await res.json();
        setThreadMap((prev) => ({
          ...prev,
          [appId]: json.ok ? (json.threads || []) : [],
        }));
      } catch {
        setThreadMap((prev) => ({ ...prev, [appId]: [] }));
      }
    }
    for (const app of apps) fetchOne(app.id);
  }, [apps]);

  // ── Build deal bundles (only apps with at least one thread or offer) ─────
  const allDeals = useMemo<DealBundle[]>(() => {
    if (!apps) return [];

    // Index offer records by their application_id (stored in data field).
    const offersByApp: Record<string, OfferRow[]> = {};
    for (const o of offerRecords) {
      const appId = String(o.data.application_id || "");
      if (!appId) continue;
      if (!offersByApp[appId]) offersByApp[appId] = [];
      offersByApp[appId].push(o);
    }

    return apps
      .map((app): DealBundle => {
        const threads = threadMap[app.id] ?? [];
        const offers = offersByApp[app.id] ?? [];
        const needsReview =
          threads.some(
            (t) => t.status === "info_requested" || t.last_error != null,
          );
        return { app, threads, offers, needsReview };
      })
      .filter((d) => d.threads.length > 0 || d.offers.length > 0)
      .sort((a, b) => {
        // Needs-review first, then sort by most-recent thread activity.
        if (a.needsReview && !b.needsReview) return -1;
        if (!a.needsReview && b.needsReview) return 1;
        const aTime =
          a.threads.reduce((max, t) => {
            const ts = new Date(t.last_response_at || t.sent_at || t.created_at).getTime();
            return ts > max ? ts : max;
          }, 0);
        const bTime =
          b.threads.reduce((max, t) => {
            const ts = new Date(t.last_response_at || t.sent_at || t.created_at).getTime();
            return ts > max ? ts : max;
          }, 0);
        return bTime - aTime;
      });
  }, [apps, threadMap, offerRecords]);

  // Resolve an assigned_to id → display name (members first, then the name
  // denormalized on the record, then a short id).
  const agentName = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) {
      map.set(m.auth_user_id, m.display_name || m.full_name || m.auth_user_id.slice(0, 8));
    }
    for (const d of allDeals) {
      const id = String(d.app.data.assigned_to || "");
      if (id && !map.has(id)) {
        const nm = String(d.app.data.assigned_to_name || "");
        if (nm) map.set(id, nm);
      }
    }
    return map;
  }, [members, allDeals]);

  // Per-agent buckets (id → deal count) for the chip row, busiest first.
  const agentBuckets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of allDeals) {
      const id = String(d.app.data.assigned_to || "") || UNASSIGNED;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [allDeals]);

  // The visible deals after applying the agent filter.
  const deals = useMemo(() => {
    if (agentFilter === null) return allDeals;
    return allDeals.filter((d) => (String(d.app.data.assigned_to || "") || UNASSIGNED) === agentFilter);
  }, [allDeals, agentFilter]);

  // Preview-mode bail removed 2026-05-25 — operator viewing a tenant
  // they don't own should see the same scaffold (8 kanban columns,
  // accordion shell, view toggle) an empty real tenant sees. Empty
  // arrays + the existing empty-state cards handle the no-data render
  // honestly; catch-all dispatcher already shows the "preview" Tag.

  // ── Loading skeleton ─────────────────────────────────────────────────────
  const isLoading = apps === null;

  return (
    <div className="space-y-5">
      {/* Catch-all dispatcher already renders the page title +
          subtitle. No inner PageHeader here — duplicated 2026-05-24. */}

      {/* View toggle */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setView("accordion")}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold border transition-colors ${
            view === "accordion"
              ? "bg-accent/10 border-accent/30 text-accent"
              : "bg-bg-elev border-bg-border text-fg-muted hover:text-fg"
          }`}
        >
          <LayoutList className="w-3.5 h-3.5" />
          Accordion
        </button>
        <button
          type="button"
          onClick={() => setView("kanban")}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-semibold border transition-colors ${
            view === "kanban"
              ? "bg-accent/10 border-accent/30 text-accent"
              : "bg-bg-elev border-bg-border text-fg-muted hover:text-fg"
          }`}
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          Kanban
        </button>

        {/* Deal count */}
        {!isLoading && (
          <span className="ml-auto text-[11px] text-fg-dim font-mono">
            {agentFilter !== null
              ? `${deals.length} of ${allDeals.length} deals`
              : `${deals.length} deal${deals.length === 1 ? "" : "s"}`}
          </span>
        )}
      </div>

      {/* Per-agent filter chips — only when more than one agent has offers.
          "All" + one chip per rep (busiest first) + Unassigned. */}
      {!isLoading && agentBuckets.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10.5px] uppercase tracking-wider text-fg-dim font-semibold mr-0.5">
            Agent
          </span>
          <button
            type="button"
            onClick={() => setAgentFilter(null)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-semibold border transition-colors ${
              agentFilter === null
                ? "bg-accent/15 border-accent/40 text-accent"
                : "bg-bg-elev border-bg-border text-fg-muted hover:text-fg"
            }`}
          >
            All
            <span className="font-mono text-[10px] opacity-70">{allDeals.length}</span>
          </button>
          {agentBuckets.map(([id, count]) => {
            const label = id === UNASSIGNED ? "Unassigned" : agentName.get(id) || id.slice(0, 8);
            const active = agentFilter === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setAgentFilter(active ? null : id)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-semibold border transition-colors ${
                  active
                    ? "bg-accent/15 border-accent/40 text-accent"
                    : "bg-bg-elev border-bg-border text-fg-muted hover:text-fg"
                }`}
              >
                {label}
                <span className="font-mono text-[10px] opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {isLoading ? (
        <div className="text-xs text-fg-dim italic py-8 text-center">
          Loading applications and lender threads…
        </div>
      ) : view === "kanban" ? (
        // Kanban always renders its 8-column lifecycle scaffold even
        // when deals is empty — operators need to see the structure of
        // the offer pipeline (pending / sent / responded / approved /
        // needs review / declined / no response / error) without first
        // having data, per CC's 2026-05-24 feedback.
        <>
          {deals.length === 0 && (
            <Card>
              <div className="flex items-center gap-2 text-sm text-fg-muted py-2">
                <HandCoins className="w-4 h-4 text-fg-dim" />
                No lender threads yet. Use Shopping Out to send the first
                package — replies will land in the columns below.
              </div>
            </Card>
          )}
          <KanbanView deals={deals} />
        </>
      ) : deals.length === 0 ? (
        <Card>
          <div className="flex items-center gap-2 text-sm text-fg-muted py-2">
            <HandCoins className="w-4 h-4 text-fg-dim" />
            No applications have lender threads yet. Use Shopping Out to send
            the first package.
          </div>
        </Card>
      ) : (
        <AccordionView
          deals={deals}
          expanded={expanded}
          setExpanded={setExpanded}
        />
      )}
    </div>
  );
}

// ─── Accordion view ───────────────────────────────────────────────────────────

function AccordionView({
  deals,
  expanded,
  setExpanded,
}: {
  deals: DealBundle[];
  expanded: Set<string>;
  setExpanded: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="rounded-xl border border-bg-border divide-y divide-bg-border overflow-hidden">
      {deals.map((deal) => (
        <AccordionRow
          key={deal.app.id}
          deal={deal}
          isOpen={expanded.has(deal.app.id)}
          onToggle={() => toggle(deal.app.id)}
        />
      ))}
    </div>
  );
}

function AccordionRow({
  deal,
  isOpen,
  onToggle,
}: {
  deal: DealBundle;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const { app, threads, offers, needsReview } = deal;
  const biz = String(app.data.business_name || "(unnamed)");
  const contact = String(app.data.contact_name || "");
  const revenue = app.data.monthly_revenue;
  const appStatus = String(app.data.status || "");

  // Thread status summary counts
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of threads) {
      counts[t.status] = (counts[t.status] ?? 0) + 1;
    }
    return counts;
  }, [threads]);

  const appStatusTone =
    STATUS_TONE[appStatus] ?? "bg-slate-500/15 text-slate-300 border-slate-500/30";

  // Sorted threads: approved/offers first, declined/error last.
  const sortedThreads = useMemo(
    () => [...threads].sort((a, b) => statusRank(a.status) - statusRank(b.status)),
    [threads],
  );

  // Map offer records by lender_id for quick look-up in thread rows.
  const offerByLender = useMemo(() => {
    const map: Record<string, OfferRow> = {};
    for (const o of offers) {
      const lid = String(o.data.lender_id || o.data.lender_name || "");
      if (lid) map[lid] = o;
    }
    return map;
  }, [offers]);

  // All sent lenders have declined → surface the MANUAL "Decline deal" button.
  // Manual-only (never auto-moves) so the operator can still open another chain
  // to new lenders before deciding; it hides again the moment a new thread is
  // pending/sent/approved. (Adon 2026-06-23.)
  const allDeclined = useMemo(() => {
    if (threads.length === 0) return false;
    const stillOpen = new Set(["pending", "sent", "responded", "approved", "info_requested"]);
    return (
      threads.every((t) => !stillOpen.has(t.status)) &&
      threads.some((t) => t.status === "declined") &&
      appStatus !== "declined"
    );
  }, [threads, appStatus]);
  const [declining, setDeclining] = useState(false);
  async function declineDeal() {
    if (typeof window !== "undefined" && !window.confirm(`Move "${biz}" to Declined? All lenders passed on this deal.`)) return;
    setDeclining(true);
    try {
      const r = await fetch(`/api/leads/${app.id}/set-stage`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entity: "application", stage: "declined" }),
      });
      if (r.ok && typeof window !== "undefined") window.location.reload();
    } finally {
      setDeclining(false);
    }
  }

  return (
    <div className="bg-bg-elev/30">
      {/* Header row */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-bg-elev/60 transition-colors"
      >
        <span className="text-fg-dim shrink-0">
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </span>

        {/* Business + contact */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-semibold text-fg truncate">
              {biz}
            </span>
            {contact && (
              <span className="text-[11px] text-fg-dim truncate">{contact}</span>
            )}
            {revenue != null && (
              <span className="text-[11px] text-fg-dim font-mono">
                {fmtCurrency(revenue)}/mo
              </span>
            )}
          </div>

          {/* Thread summary chips */}
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {Object.entries(statusCounts).map(([status, count]) => (
              <span
                key={status}
                className={`text-[10px] font-mono px-1.5 py-0 rounded border ${
                  STATUS_TONE[status] ?? "bg-slate-500/15 text-slate-300 border-slate-500/30"
                }`}
              >
                {count} {status.replace(/_/g, " ")}
              </span>
            ))}
            {offers.length > 0 && (
              <span className="text-[10px] font-mono px-1.5 py-0 rounded border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                {offers.length} offer record{offers.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>

        {/* Right-side: app status + needs-review badge */}
        <div className="flex items-center gap-2 shrink-0">
          {needsReview && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-orange-500/15 text-orange-300 border-orange-500/30">
              <AlertCircle className="w-3 h-3" />
              Needs Review
            </span>
          )}
          <span
            className={`text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded border ${appStatusTone}`}
          >
            {appStatus.replace(/_/g, " ") || "—"}
          </span>
        </div>
      </button>

      {/* Expanded thread table */}
      {isOpen && (
        <div className="border-t border-bg-border">
          {allDeclined && (
            <div className="px-4 py-2.5 flex items-center justify-between gap-3 bg-red-500/5 border-b border-red-500/20">
              <span className="text-[11.5px] text-red-200">
                All lenders passed on this deal. Move it to Declined, or open another chain to new lenders first.
              </span>
              <button
                type="button"
                onClick={declineDeal}
                disabled={declining}
                className="inline-flex items-center gap-1.5 shrink-0 rounded-md border border-red-500/40 bg-red-500/10 text-red-200 px-3 py-1.5 text-[11px] font-semibold hover:bg-red-500/20 disabled:opacity-50"
              >
                <AlertCircle className="w-3.5 h-3.5" />
                {declining ? "Moving…" : "Decline deal"}
              </button>
            </div>
          )}
          {sortedThreads.length === 0 && offers.length === 0 ? (
            <div className="px-6 py-3 text-[12px] text-fg-dim italic">
              No threads or offer records on this application.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-bg-deep/50">
                  <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-fg-dim font-semibold border-b border-bg-border">
                    <th className="px-4 py-2">Lender</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Amount</th>
                    <th className="px-3 py-2">Term</th>
                    <th className="px-3 py-2">Factor</th>
                    <th className="px-3 py-2 hidden sm:table-cell">Subject</th>
                    <th className="px-3 py-2">Sent</th>
                    <th className="px-3 py-2">Response</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedThreads.map((t) => {
                    // Look up offer record by lender_id first, then lender_name.
                    const offer =
                      offerByLender[t.lender_id] ||
                      offerByLender[t.lender_name] ||
                      null;
                    const amount = offer
                      ? fmtCurrency(offer.data.amount)
                      : "—";
                    const termMonths =
                      offer && offer.data.term_months != null
                        ? `${offer.data.term_months}mo`
                        : "—";
                    const factorRate =
                      offer && offer.data.factor_rate != null
                        ? String(offer.data.factor_rate)
                        : "—";

                    return (
                      <ThreadRow
                        key={t.id}
                        thread={t}
                        amount={amount}
                        termMonths={termMonths}
                        factorRate={factorRate}
                      />
                    );
                  })}
                  {/* Codex review 2026-05-24 — offer records without a
                      matching thread (legacy / manually-entered offers)
                      were hidden because the table only rendered
                      sortedThreads. Render them here as offer-only rows
                      so the count in the accordion header always matches
                      what the table shows. */}
                  {(() => {
                    const threadLenderKeys = new Set<string>();
                    for (const t of sortedThreads) {
                      threadLenderKeys.add(t.lender_id);
                      if (t.lender_name) threadLenderKeys.add(t.lender_name);
                    }
                    const orphanOffers = offers.filter((o) => {
                      const lid = String(o.data.lender_id || "");
                      const lname = String(o.data.lender_name || "");
                      return !threadLenderKeys.has(lid) && !threadLenderKeys.has(lname);
                    });
                    return orphanOffers.map((o) => (
                      <OfferOnlyRow key={`offer-${o.id}`} offer={o} />
                    ));
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ThreadRow({
  thread: t,
  amount,
  termMonths,
  factorRate,
}: {
  thread: Thread;
  amount: string;
  termMonths: string;
  factorRate: string;
}) {
  return (
    <>
      <tr className="border-b border-bg-border/50 last:border-0 hover:bg-bg-elev/20 transition-colors align-top">
        <td className="px-4 py-2.5">
          <div className="font-semibold text-fg text-[12.5px] leading-tight">
            {t.lender_name || "—"}
          </div>
        </td>
        <td className="px-3 py-2.5">
          <StatusPill status={t.status} />
        </td>
        <td className="px-3 py-2.5 font-mono text-[11.5px] text-fg">
          {amount}
        </td>
        <td className="px-3 py-2.5 font-mono text-[11.5px] text-fg-muted">
          {termMonths}
        </td>
        <td className="px-3 py-2.5 font-mono text-[11.5px] text-fg-muted">
          {factorRate}
        </td>
        <td className="px-3 py-2.5 text-[11px] text-fg-dim hidden sm:table-cell max-w-[200px] truncate">
          {t.subject || "—"}
        </td>
        <td className="px-3 py-2.5 text-[11px] text-fg-dim font-mono whitespace-nowrap">
          {fmtDate(t.sent_at)}
        </td>
        <td className="px-3 py-2.5 text-[11px] text-fg-dim font-mono whitespace-nowrap">
          {fmtDate(t.last_response_at)}
        </td>
      </tr>
      {/* Response summary row */}
      {(t.last_response_summary || t.last_error) && (
        <tr className="border-b border-bg-border/50 last:border-0 bg-bg-deep/20">
          <td colSpan={8} className="px-4 pb-2.5 pt-0">
            {t.last_response_summary && (
              <div className="text-[11.5px] text-fg-muted leading-snug">
                ↳ {t.last_response_summary}
              </div>
            )}
            {t.last_error && (
              <div className="text-[11px] text-rose-300 mt-0.5">
                ⚠ {t.last_error}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Renders an offer record that has no matching application_lender_thread.
 * Codex review 2026-05-24: without this row the accordion header's
 * "N offer records" count would be a lie — header says 2, table shows 0.
 */
function OfferOnlyRow({ offer }: { offer: OfferRow }) {
  const d = offer.data;
  const lenderName = String(d.lender_name || "—");
  const amount = fmtCurrency(d.amount);
  const termMonths = d.term_months != null ? `${d.term_months}mo` : "—";
  const factorRate = d.factor_rate != null ? String(d.factor_rate) : "—";
  const stage = String(d.stage || "—");
  return (
    <tr className="border-b border-bg-border/50 last:border-0 hover:bg-bg-elev/20 transition-colors align-top">
      <td className="px-4 py-2.5">
        <div className="font-semibold text-fg text-[12.5px] leading-tight">{lenderName}</div>
        <div className="text-[10px] text-fg-dim mt-0.5">offer record · no thread</div>
      </td>
      <td className="px-3 py-2.5">
        <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
          {stage.replace(/_/g, " ")}
        </span>
      </td>
      <td className="px-3 py-2.5 font-mono text-[11.5px] text-fg">{amount}</td>
      <td className="px-3 py-2.5 font-mono text-[11.5px] text-fg-muted">{termMonths}</td>
      <td className="px-3 py-2.5 font-mono text-[11.5px] text-fg-muted">{factorRate}</td>
      <td className="px-3 py-2.5 text-[11px] text-fg-dim hidden sm:table-cell">—</td>
      <td className="px-3 py-2.5 text-[11px] text-fg-dim font-mono whitespace-nowrap">—</td>
      <td className="px-3 py-2.5 text-[11px] text-fg-dim font-mono whitespace-nowrap">—</td>
    </tr>
  );
}

// ─── Kanban view ──────────────────────────────────────────────────────────────

type KanbanCardData = {
  threadId: string;
  lenderName: string;
  appName: string;
  amount: string;
  sentAt: string | null;
  status: string;
  needsReview: boolean;
};

function KanbanView({ deals }: { deals: DealBundle[] }) {
  const cardsByStatus = useMemo(() => {
    const map: Record<string, KanbanCardData[]> = {};
    for (const col of KANBAN_COLUMNS) map[col.key] = [];

    // Index offer records across all deals by lender_id and lender_name.
    for (const deal of deals) {
      const offerByLender: Record<string, OfferRow> = {};
      for (const o of deal.offers) {
        const lid = String(o.data.lender_id || o.data.lender_name || "");
        if (lid) offerByLender[lid] = o;
      }

      for (const t of deal.threads) {
        const offer =
          offerByLender[t.lender_id] || offerByLender[t.lender_name] || null;
        const amount = offer ? fmtCurrency(offer.data.amount) : "—";
        const card: KanbanCardData = {
          threadId: t.id,
          lenderName: t.lender_name || "—",
          appName: String(deal.app.data.business_name || "(unnamed)"),
          amount,
          sentAt: t.sent_at,
          status: t.status,
          needsReview:
            t.status === "info_requested" || t.last_error != null,
        };
        if (t.status in map) {
          map[t.status].push(card);
        } else {
          // Unknown status lands in its own bucket; we won't render it but
          // it's not lost — just not in the schema set.
          (map[t.status] = map[t.status] || []).push(card);
        }
      }
    }
    return map;
  }, [deals]);

  const totalThreads = Object.values(cardsByStatus).reduce(
    (sum, cards) => sum + cards.length,
    0,
  );

  if (totalThreads === 0) {
    return (
      <Card>
        <div className="text-sm text-fg-muted">
          No lender threads to display in Kanban.
        </div>
      </Card>
    );
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex gap-3 min-w-max">
        {KANBAN_COLUMNS.map((col) => {
          const cards = cardsByStatus[col.key] || [];
          const tone =
            STATUS_TONE[col.key] ?? "bg-slate-500/15 text-slate-300 border-slate-500/30";
          return (
            <div
              key={col.key}
              className="w-52 shrink-0 rounded-lg border border-bg-border bg-bg-elev/40 overflow-hidden"
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-bg-border bg-bg-deep/40">
                <span className={`text-[10.5px] font-semibold uppercase tracking-wider ${STATUS_TEXT_COLOR[col.key] ?? "text-slate-300"}`}>
                  {col.label}
                </span>
                <span className={`text-[10px] font-mono px-1.5 py-0 rounded border ${tone}`}>
                  {cards.length}
                </span>
              </div>
              {/* Cards */}
              <div className="p-2 space-y-1.5 max-h-[70vh] overflow-y-auto">
                {cards.length === 0 ? (
                  <div className="text-[10.5px] text-fg-dim italic py-3 text-center">
                    —
                  </div>
                ) : (
                  cards.map((card) => (
                    <KanbanCard key={card.threadId} card={card} />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KanbanCard({ card }: { card: KanbanCardData }) {
  return (
    <div className="rounded-md border border-bg-border bg-bg-deep/60 px-2.5 py-2 space-y-1">
      <div className="font-semibold text-[12px] text-fg leading-tight truncate">
        {card.lenderName}
      </div>
      <div className="text-[10.5px] text-fg-muted truncate">{card.appName}</div>
      <div className="flex items-center justify-between gap-1 flex-wrap">
        {card.amount !== "—" && (
          <span className="text-[10.5px] font-mono text-emerald-300">
            {card.amount}
          </span>
        )}
        {card.sentAt && (
          <span className="text-[10px] font-mono text-fg-dim">
            {fmtDate(card.sentAt)}
          </span>
        )}
      </div>
      {card.needsReview && (
        <div className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0 rounded border bg-orange-500/15 text-orange-300 border-orange-500/30">
          <AlertCircle className="w-2.5 h-2.5" />
          Review
        </div>
      )}
    </div>
  );
}
