"use client";

/**
 * DailyPlanClient — SunBiz Daily Plan / Calls tab.
 *
 * Added: 2026-05-25, second SunBiz product meeting.
 *
 * Backend tables:
 *   - daily_plan_items   — auto-generated at 6am ET by scripts/daily_plan_generator.py
 *                          (migration 069). Six category buckets: priority_call,
 *                          missing_info, stuck, new_offer, shop_today, renewal_eligible.
 *   - follow_up_tasks    — operator-managed queue (also migration 069).
 *
 * Data contract: GET /api/manifest/<slug>/daily-plan?date=<YYYY-MM-DD>
 *   Response shape → DailyPlanResponse (see type below).
 *   Dismiss: POST /api/manifest/<slug>/daily-plan/<item_id>/dismiss
 *   API route does not exist yet — client is authored against the agreed contract.
 *
 * Preview mode: when tenantId === null, renders the 6-pane scaffold with empty lists
 *   and no network calls. Same guard pattern as ShoppingOutClient (lines 144-152).
 *
 * SOP checklist: 5 hardcoded items, persisted to localStorage keyed by date
 *   so state resets automatically each day.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/Card";
import {
  Phone,
  AlertCircle,
  Clock,
  HandCoins,
  ShoppingBag,
  RefreshCw,
  CheckSquare,
  Square,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ItemCategory =
  | "priority_call"
  | "missing_info"
  | "stuck"
  | "new_offer"
  | "shop_today"
  | "renewal_eligible";

type DailyPlanItem = {
  id: string;
  category: ItemCategory;
  priority: number;
  reason: string;
  lead_id: string | null;
  application_id: string | null;
  business_name: string | null;
  contact_name: string | null;
  metadata: Record<string, unknown>;
  status: "open" | "done" | "dismissed";
};

type DailyPlanSummary = {
  total: number;
  priority_calls: number;
  missing_info: number;
  stuck: number;
  new_offers: number;
  shop_today: number;
  renewals_eligible: number;
};

type DailyPlanResponse = {
  date: string;
  summary: DailyPlanSummary;
  items: DailyPlanItem[];
};

// ---------------------------------------------------------------------------
// SOP Checklist config
// ---------------------------------------------------------------------------

const SOP_ITEMS = [
  {
    id: "standup",
    label: "Daily standup",
    subtitle: "Telegram → Solara: ask for hot-deals brief",
  },
  {
    id: "drip",
    label: "Drip queue review",
    subtitle: "Sequences tab → check for stuck or errored steps",
  },
  {
    id: "voicemail",
    label: "Voicemail callback sweep",
    subtitle: "Return every call left on your work line yesterday",
  },
  {
    id: "bank_parse",
    label: "Bank statement parse queue",
    subtitle: "Underwriting tab → re-run anything stuck >24h",
  },
  {
    id: "digest",
    label: "End-of-day Telegram digest",
    subtitle: "Confirm tomorrow's priorities before you log off",
  },
] as const;

type SopId = (typeof SOP_ITEMS)[number]["id"];

// ---------------------------------------------------------------------------
// Pane config
// ---------------------------------------------------------------------------

const PANE_CONFIG: Array<{
  category: ItemCategory;
  label: string;
  Icon: React.ElementType<{ className?: string }>;
  summaryKey: keyof DailyPlanSummary;
}> = [
  { category: "priority_call", label: "Priority Calls", Icon: Phone, summaryKey: "priority_calls" },
  { category: "missing_info", label: "Missing Info", Icon: AlertCircle, summaryKey: "missing_info" },
  { category: "stuck", label: "Stuck Leads", Icon: Clock, summaryKey: "stuck" },
  { category: "new_offer", label: "New Offers", Icon: HandCoins, summaryKey: "new_offers" },
  { category: "shop_today", label: "Shop Today", Icon: ShoppingBag, summaryKey: "shop_today" },
  {
    category: "renewal_eligible",
    label: "Renewals Eligible",
    Icon: RefreshCw,
    summaryKey: "renewals_eligible",
  },
];

const ROWS_COLLAPSED = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sopStorageKey(date: string): string {
  return `daily_plan_sop_${date}`;
}

function loadSopState(date: string): Set<SopId> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(sopStorageKey(date));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed as SopId[]);
  } catch {
    return new Set();
  }
}

function saveSopState(date: string, checked: Set<SopId>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(sopStorageKey(date), JSON.stringify(Array.from(checked)));
  } catch {
    // localStorage unavailable — silently no-op
  }
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function buildSummaryLine(summary: DailyPlanSummary): string {
  const parts: string[] = [];
  if (summary.priority_calls > 0)
    parts.push(`${summary.priority_calls} priority call${summary.priority_calls === 1 ? "" : "s"}`);
  if (summary.missing_info > 0)
    parts.push(`${summary.missing_info} missing info`);
  if (summary.stuck > 0)
    parts.push(`${summary.stuck} stuck lead${summary.stuck === 1 ? "" : "s"}`);
  if (summary.new_offers > 0)
    parts.push(`${summary.new_offers} new offer${summary.new_offers === 1 ? "" : "s"}`);
  if (summary.shop_today > 0)
    parts.push(`${summary.shop_today} to shop`);
  if (summary.renewals_eligible > 0)
    parts.push(`${summary.renewals_eligible} renewal${summary.renewals_eligible === 1 ? "" : "s"}`);
  if (parts.length === 0) return "Nothing on your plate today.";
  return `${summary.total} item${summary.total === 1 ? "" : "s"} on your plan today — ${parts.slice(0, 3).join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  tenantSlug,
  onDismiss,
}: {
  item: DailyPlanItem;
  tenantSlug: string;
  onDismiss: (id: string) => void;
}) {
  const router = useRouter();
  const displayName = item.business_name || item.contact_name || "(unnamed)";

  function openRecord() {
    if (item.application_id) {
      router.push(`/t/${tenantSlug}/applications?application=${item.application_id}`);
    } else if (item.lead_id) {
      router.push(`/t/${tenantSlug}/leads?lead=${item.lead_id}`);
    }
  }

  return (
    <div className="group flex items-start gap-3 px-3 py-2.5 border-b border-bg-border last:border-b-0 hover:bg-bg-elev/40">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-fg truncate">{displayName}</div>
        <div className="text-[11.5px] text-fg-muted leading-snug mt-0.5 line-clamp-1">
          {item.reason}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
        {(item.application_id || item.lead_id) && (
          <button
            type="button"
            onClick={openRecord}
            className="text-[11px] font-semibold px-2 py-0.5 rounded border border-bg-border text-fg-dim hover:text-fg hover:border-accent/40 hover:bg-accent/5"
          >
            Open
          </button>
        )}
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          aria-label="Dismiss"
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-fg-dim hover:text-fg"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function PlanPane({
  label,
  Icon,
  count,
  items,
  tenantSlug,
  onDismiss,
}: {
  label: string;
  Icon: React.ElementType<{ className?: string }>;
  count: number;
  items: DailyPlanItem[];
  tenantSlug: string;
  onDismiss: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Collapse automatically when dismissals bring the list to ≤ ROWS_COLLAPSED
  // so the "Show less" button doesn't linger on an already-short list.
  const overflow = items.length - ROWS_COLLAPSED;
  const shouldExpand = expanded && overflow > 0;
  const visible = shouldExpand ? items : items.slice(0, ROWS_COLLAPSED);

  return (
    <Card
      title={label}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <Icon className="w-3 h-3" />
          <span>{count} item{count === 1 ? "" : "s"}</span>
        </span>
      }
      noPadding
    >
      {items.length === 0 ? (
        <div className="px-4 py-5 text-[12.5px] text-fg-muted italic">Nothing today</div>
      ) : (
        <div>
          {visible.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              tenantSlug={tenantSlug}
              onDismiss={onDismiss}
            />
          ))}
          {overflow > 0 && !shouldExpand && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full text-left px-3 py-2 text-[11.5px] text-fg-dim hover:text-fg hover:bg-bg-elev/40"
            >
              + {overflow} more
            </button>
          )}
          {shouldExpand && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="w-full text-left px-3 py-2 text-[11.5px] text-fg-dim hover:text-fg hover:bg-bg-elev/40"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function SopChecklist({ date }: { date: string }) {
  const [checked, setChecked] = useState<Set<SopId>>(new Set());

  useEffect(() => {
    setChecked(loadSopState(date));
  }, [date]);

  function toggle(id: SopId) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveSopState(date, next);
      return next;
    });
  }

  const done = checked.size;
  const total = SOP_ITEMS.length;

  return (
    <Card
      title="SOP Checklist"
      subtitle={`${done} / ${total} complete`}
    >
      <div className="space-y-1">
        {SOP_ITEMS.map((item) => {
          const isChecked = checked.has(item.id);
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => toggle(item.id)}
              className={`w-full flex items-start gap-3 px-2 py-2 rounded-md text-left hover:bg-bg-elev/50 ${
                isChecked ? "opacity-60" : ""
              }`}
            >
              {isChecked ? (
                <CheckSquare className="w-4 h-4 mt-0.5 shrink-0 text-accent" />
              ) : (
                <Square className="w-4 h-4 mt-0.5 shrink-0 text-fg-dim" />
              )}
              <div className="min-w-0">
                <div
                  className={`text-[13px] font-semibold ${
                    isChecked ? "line-through text-fg-dim" : "text-fg"
                  }`}
                >
                  {item.label}
                </div>
                <div className="text-[11.5px] text-fg-muted mt-0.5">{item.subtitle}</div>
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DailyPlanClient({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  // Stable for the lifetime of the component (changes only at midnight, which
  // triggers a remount via the date-keyed parent or the next page load).
  const date = useMemo(() => todayIso(), []);

  const [plan, setPlan] = useState<DailyPlanResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistically dismissed item ids — excluded from visible lists immediately
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const fetchPlan = useCallback(async () => {
    if (!tenantId) {
      // Preview mode — render empty scaffold, no fetches fire.
      setPlan({
        date,
        summary: {
          total: 0,
          priority_calls: 0,
          missing_info: 0,
          stuck: 0,
          new_offers: 0,
          shop_today: 0,
          renewals_eligible: 0,
        },
        items: [],
      });
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/manifest/${tenantSlug}/daily-plan?date=${date}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        setError(`Failed to load daily plan (${res.status}).`);
        return;
      }
      const json = (await res.json()) as DailyPlanResponse;
      setPlan(json);
      // Reset optimistic dismissals on full refresh
      setDismissedIds(new Set());
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setLoading(false);
    }
  }, [tenantSlug, tenantId, date]);

  useEffect(() => {
    fetchPlan();
  }, [fetchPlan]);

  const handleDismiss = useCallback(
    async (itemId: string) => {
      // Optimistic update
      setDismissedIds((prev) => new Set([...prev, itemId]));
      try {
        const res = await fetch(
          `/api/manifest/${tenantSlug}/daily-plan/${itemId}/dismiss`,
          { method: "POST", credentials: "include" },
        );
        if (!res.ok) {
          // Revert on error
          setDismissedIds((prev) => {
            const next = new Set(prev);
            next.delete(itemId);
            return next;
          });
        }
      } catch {
        // Revert on network error
        setDismissedIds((prev) => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      }
    },
    [tenantSlug],
  );

  // Build per-category item arrays (excluding dismissed + server-side dismissed)
  const itemsByCategory = useMemo(() => {
    const map = new Map<ItemCategory, DailyPlanItem[]>();
    PANE_CONFIG.forEach(({ category }) => map.set(category, []));
    if (!plan) return map;
    for (const item of plan.items) {
      if (item.status === "dismissed" || dismissedIds.has(item.id)) continue;
      const bucket = map.get(item.category);
      if (bucket) bucket.push(item);
    }
    // Sort each bucket by priority asc (lower number = higher priority)
    for (const [, bucket] of map) {
      bucket.sort((a, b) => a.priority - b.priority);
    }
    return map;
  }, [plan, dismissedIds]);

  // Recompute live summary in a single pass — counts per-category from the
  // already-filtered itemsByCategory map, then derive total and summary shape.
  const liveSummary: DailyPlanSummary = useMemo(() => {
    const pc = itemsByCategory.get("priority_call")?.length ?? 0;
    const mi = itemsByCategory.get("missing_info")?.length ?? 0;
    const st = itemsByCategory.get("stuck")?.length ?? 0;
    const no = itemsByCategory.get("new_offer")?.length ?? 0;
    const sh = itemsByCategory.get("shop_today")?.length ?? 0;
    const re = itemsByCategory.get("renewal_eligible")?.length ?? 0;
    return {
      total: pc + mi + st + no + sh + re,
      priority_calls: pc,
      missing_info: mi,
      stuck: st,
      new_offers: no,
      shop_today: sh,
      renewals_eligible: re,
    };
  }, [itemsByCategory]);

  const summaryLine = plan ? buildSummaryLine(liveSummary) : "Loading your plan…";

  return (
    <div className="space-y-5">
      {/* Hero header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold mb-1">
            Daily Plan
          </div>
          <h2 className="text-lg font-bold text-fg leading-snug">
            {formatDate(date)}
          </h2>
          <p className="text-[13px] text-fg-muted mt-1">{summaryLine}</p>
        </div>
        <button
          type="button"
          onClick={fetchPlan}
          disabled={loading}
          aria-label="Refresh daily plan"
          className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-50 shrink-0 mt-1"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-[12.5px] text-rose-200">
          {error}
        </div>
      )}

      {/* 6-pane grid — left column: Priority Calls / Missing Info / Stuck Leads */}
      {/*                right column: New Offers / Shop Today / Renewals Eligible */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left column */}
        <div className="space-y-4">
          {PANE_CONFIG.slice(0, 3).map(({ category, label, Icon, summaryKey }) => (
            <PlanPane
              key={category}
              label={label}
              Icon={Icon}
              count={liveSummary[summaryKey]}
              items={itemsByCategory.get(category) ?? []}
              tenantSlug={tenantSlug}
              onDismiss={handleDismiss}
            />
          ))}
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {PANE_CONFIG.slice(3).map(({ category, label, Icon, summaryKey }) => (
            <PlanPane
              key={category}
              label={label}
              Icon={Icon}
              count={liveSummary[summaryKey]}
              items={itemsByCategory.get(category) ?? []}
              tenantSlug={tenantSlug}
              onDismiss={handleDismiss}
            />
          ))}
        </div>
      </div>

      {/* SOP Checklist */}
      <SopChecklist date={date} />
    </div>
  );
}
