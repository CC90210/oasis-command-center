"use client";

/**
 * LeadDetailDrawer — right-side slide-in drawer for the SunBiz Leads
 * and Applications pages. Mounts when the catch-all tenant page sees
 * `?lead=<uuid>` or `?application=<uuid>` in the URL.
 *
 * Five tabs (Activity / Lenders / Bank / Notes / Documents) and three
 * footer actions (Send Email / Send SMS / Send via Text Torrent). Opens
 * without navigating away from the list so the operator keeps the
 * pipeline view as their reference frame.
 *
 * Loads the aggregated lead detail from /api/leads/[id]/detail in one
 * round trip; tabs render off that single payload. The Activity tab is
 * the existing LeadTimelinePanel (its own /api/leads/[id]/timeline
 * fetch).
 */

import { useCallback, useEffect, useRef, useState } from "react";
// useRef intentionally imported for the file-input ref in DocumentsTab.
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { X, FileText, ImageIcon, Phone, Mail, ShoppingBag, Loader2 } from "lucide-react";
import { LeadTimelinePanel } from "./LeadTimelinePanel";
import { AssignmentControl } from "./AssignmentControl";
import { humanLeadDocSize, leadDocTypeLabel, LEAD_DOC_TYPES } from "@/lib/lead-doc-display";
import { LEAD_PIPELINE_STAGES, OPPORTUNITY_PIPELINE_STAGES, type StageMeta } from "@/lib/sunbiz-stage-meta";
import { formatMoney, relTime } from "@/lib/format-helpers";
import { lastTouchIsoFlat } from "@/lib/lead-staleness";

type DocRow = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  doc_type: string;
  uploaded_at: string;
};

type DetailPayload = {
  record: {
    id: string;
    entity: "lead" | "application";
    data: Record<string, unknown>;
  };
  documents: DocRow[];
  application: { id: string; data: Record<string, unknown> } | null;
};

type TabKey = "activity" | "owner" | "lenders" | "bank" | "documents" | "notes";

const TABS: { key: TabKey; label: string }[] = [
  { key: "activity", label: "Activity" },
  { key: "owner", label: "Owner" },
  { key: "lenders", label: "Lenders" },
  { key: "bank", label: "Bank" },
  { key: "documents", label: "Docs" },
  { key: "notes", label: "Notes" },
];

export function LeadDetailDrawer({
  tenantSlug,
  recordId,
  entity,
}: {
  tenantSlug: string;
  recordId: string;
  entity: "lead" | "application";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("activity");
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async () => {
    const url = `/api/leads/${recordId}/detail${entity === "application" ? "?entity=application" : ""}`;
    try {
      const r = await fetch(url, { credentials: "include", cache: "no-store" });
      const j = await r.json();
      if (j.ok) setData(j as DetailPayload);
    } catch {
      /* keep prior data */
    }
  }, [recordId, entity]);

  const close = useCallback(() => {
    const next = new URLSearchParams(searchParams?.toString() || "");
    next.delete("lead");
    next.delete("application");
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }, [router, searchParams]);

  // Esc to close + body scroll lock + focus the close button on mount
  // (Codex pass-2 finding from the prior session: drawers without these
  // three a11y affordances trap keyboard users and shift scroll context
  // behind the modal).
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
    const url = `/api/leads/${recordId}/detail${entity === "application" ? "?entity=application" : ""}`;
    fetch(url, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j.ok) {
          setError(j.error || "load_failed");
          return;
        }
        setData(j as DetailPayload);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [recordId, entity]);

  // Resolve the stage chip for the header. Leads use LEAD_PIPELINE_STAGES;
  // applications use OPPORTUNITY_PIPELINE_STAGES and key off `status` not
  // `stage`. Returns null when there's no current stage value so the chip
  // hides instead of showing "Unknown".
  const stageChip: StageMeta | null = (() => {
    if (!data) return null;
    const d = data.record.data as Record<string, unknown>;
    const key = String(entity === "application" ? d.status || "" : d.stage || "");
    if (!key) return null;
    const list = entity === "application" ? OPPORTUNITY_PIPELINE_STAGES : LEAD_PIPELINE_STAGES;
    return list.find((s) => s.key === key) || null;
  })();

  const shortId = recordId.slice(0, 8);
  const title = data
    ? resolveTitle(data.record.data, entity, shortId)
    : entity === "application"
      ? `Application ${shortId}`
      : `Lead ${shortId}`;
  const subtitle = data ? resolveSubtitle(data.record.data) : shortId;

  const editHref =
    entity === "application"
      ? `/t/${tenantSlug}/applications/${recordId}`
      : `/t/${tenantSlug}/leads/${recordId}`;

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} detail`}
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={close}
        className="flex-1 bg-black/60 backdrop-blur-sm cursor-default"
      />
      <aside className="relative w-full sm:w-[580px] h-full bg-bg-elev border-l border-bg-border shadow-[-12px_0_32px_-8px_rgba(0,0,0,0.6)] flex flex-col">
        {/* Header — 2026-06-08 refinement: softer divider, slightly wider
            inner spacing on the label row, stage chip is now rounded-full +
            uppercase letter-spacing to feel less rectangular. */}
        <header className="px-5 py-4 border-b border-bg-border/60 space-y-4">
          {/* Row 1: MERCHANT label + stage chip + close */}
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] uppercase tracking-[0.12em] text-fg-dim/80 font-semibold mb-1">
                {entity === "application" ? "Application" : "Merchant"}
              </div>
              <h2 className="text-lg font-bold text-fg truncate leading-tight">{title}</h2>
              <div className="text-[11px] text-fg-dim mt-1 truncate">{subtitle}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {stageChip && (
                <span
                  className="inline-block px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-[0.06em] whitespace-nowrap"
                  style={{ background: stageChip.bg, color: stageChip.fg }}
                >
                  {stageChip.label}
                </span>
              )}
              <button
                ref={closeBtnRef}
                type="button"
                onClick={close}
                aria-label="Close"
                className="p-1 rounded-md text-fg-muted hover:text-fg hover:bg-bg-deep transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Row 2: Stat tiles */}
          {data && <StatTiles record={data.record.data} application={data.application} />}

          {/* Row 3: Owner/Signer + Assigned to */}
          {data && <OwnerAssignedRow record={data.record.data} />}

          {/* Row 3.5: Assignment control (Phase 3 of SunBiz multi-employee
              personalization, 2026-05-29). Lets any team member set the
              soft-ownership assignee. The assigned employee's "My active
              deals" widget on their dashboard surfaces this record at the
              top. Doesn't lock anyone out of actions — it's a presentation
              hint, not an authorization gate. */}
          {data && recordId && (
            <AssignmentControl
              recordId={recordId}
              currentAssignedTo={
                typeof data.record.data.assigned_to === "string"
                  ? data.record.data.assigned_to
                  : null
              }
            />
          )}

          <div className="flex items-center justify-between gap-3">
            {/* Shop Out — Phase 4 entry point (Jordan/Oasis 2026-05-23).
                Only on the application drawer; pre-selects this app on the
                Shopping Out page so the operator picks lenders + previews
                + sends in one motion. Hidden on the lead drawer (Lead-side
                shopping doesn't make sense until the application exists). */}
            {entity === "application" ? (
              // ?app= (not ?application=) — the catch-all dispatcher at
              // app/t/[slug]/[...path]/page.tsx treats ?application= as
              // the signal to open the LeadDetailDrawer. Using ?app=
              // here keeps the drawer from re-opening over the Shopping
              // Out page (Codex review 2026-05-24).
              <Link
                href={`/t/${tenantSlug}/shopping-out?app=${recordId}`}
                className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold px-2.5 py-1 rounded-md bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20"
              >
                <ShoppingBag className="w-3 h-3" />
                Shop Out
              </Link>
            ) : (
              <span />
            )}
            <Link
              href={editHref}
              className="text-[10.5px] text-fg-muted hover:text-fg underline underline-offset-2"
            >
              Edit full record →
            </Link>
          </div>
        </header>

        {/* Tab nav — softened 2026-06-08: subtle hover bg, tighter padding,
            border-bg-border/50 so the divider doesn't compete with the
            header underline above */}
        <nav className="flex gap-0.5 px-5 pt-3 border-b border-bg-border/50 overflow-x-auto">
          {TABS.map((t) => {
            const isDocs = t.key === "documents";
            const missingCount = isDocs && data
              ? computeMissingDocCount(data.documents)
              : 0;
            const isActive = activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={`text-[11px] uppercase tracking-[0.08em] px-2.5 py-1.5 rounded-t-md border-b-2 inline-flex items-center gap-1.5 transition-colors ${
                  isActive
                    ? "border-accent text-fg"
                    : "border-transparent text-fg-muted hover:text-fg hover:bg-bg-deep/30"
                }`}
              >
                <span>{t.label}</span>
                {isDocs && missingCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-red-500/20 text-red-300 text-[9.5px] font-mono">
                    {missingCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
              Failed to load: {error}
            </div>
          )}
          {!error && !data && (
            <div className="text-xs text-fg-dim italic py-6 text-center">Loading…</div>
          )}
          {data && activeTab === "activity" && <LeadTimelinePanel leadId={recordId} />}
          {data && activeTab === "owner" && <OwnerTab record={data.record.data} />}
          {data && activeTab === "lenders" && <LendersTab application={data.application} />}
          {data && activeTab === "bank" && (
            <BankTab record={data.record.data} application={data.application} tenantSlug={tenantSlug} />
          )}
          {data && activeTab === "notes" && <NotesTab leadId={recordId} />}
          {data && activeTab === "documents" && (
            <DocumentsTab
              recordId={recordId}
              entity={entity}
              initialDocs={data.documents}
              onChange={reload}
            />
          )}
        </div>

        <DrawerFooter
          recordId={recordId}
          entity={entity}
          recordData={data?.record.data || {}}
          onChange={reload}
        />
      </aside>
    </div>
  );
}

function resolveTitle(
  d: Record<string, unknown>,
  entity: "lead" | "application",
  shortId: string,
): string {
  return (
    str(d.business_name) ||
    str(d.name) ||
    str(d.contact_name) ||
    str(d.title) ||
    `${entity === "application" ? "Application" : "Lead"} ${shortId}`
  );
}

function resolveSubtitle(d: Record<string, unknown>): string {
  const parts: string[] = [];
  if (str(d.contact_name) && str(d.business_name)) parts.push(str(d.contact_name)!);
  if (str(d.email)) parts.push(str(d.email)!);
  if (str(d.phone)) parts.push(str(d.phone)!);
  return parts.join(" · ") || "—";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function LendersTab({
  application,
}: {
  application: { id: string; data: Record<string, unknown> } | null;
}) {
  if (!application) {
    return (
      <div className="text-xs text-fg-dim italic py-6 text-center">
        No application linked to this lead yet. Lender shop-out results show up
        here once an application is created and submitted to underwriting.
      </div>
    );
  }
  const results = application.data.shop_out_results;
  const list = Array.isArray(results) ? (results as Record<string, unknown>[]) : [];

  const tally = { sent: 0, replied: 0, offer: 0, declined: 0, pending: 0 };
  for (const r of list) {
    const status = String(r.status || "").toLowerCase();
    if (status === "offer") tally.offer++;
    else if (status === "declined") tally.declined++;
    else if (status === "replied") tally.replied++;
    else if (status === "sent") tally.sent++;
    else tally.pending++;
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold">
            Shop status
          </div>
          <div className="text-[10.5px] text-fg-dim">
            {list.length} submission{list.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="flex gap-1 h-2 rounded-full overflow-hidden bg-bg-deep/60">
          <div className="flex-1" style={{ background: "#A87534" }} />
          <div className="flex-1" style={{ background: "#4A6FA5" }} />
          <div className="flex-1" style={{ background: "#3C7E68" }} />
          <div className="flex-1" style={{ background: "#5B5550" }} />
          <div className="flex-1" style={{ background: "#6B4E8C" }} />
        </div>
        <div className="grid grid-cols-5 gap-1 mt-1.5 text-center">
          <ShopTile label="Sent" count={tally.sent} />
          <ShopTile label="Replied" count={tally.replied} />
          <ShopTile label="Offer" count={tally.offer} />
          <ShopTile label="Declined" count={tally.declined} />
          <ShopTile label="Pending" count={tally.pending} />
        </div>
      </div>

      {list.length === 0 ? (
        <div className="text-xs text-fg-dim italic py-4 text-center">
          Application {application.id.slice(0, 8)} hasn&apos;t been shopped out yet.
        </div>
      ) : (
        <ul className="divide-y divide-bg-border">
          {list.map((r, i) => {
            const status = String(r.status || "pending").toLowerCase();
            const offerDetail = [
              str(r.amount) && `Offer: ${str(r.amount)}`,
              str(r.factor_rate) && `${str(r.factor_rate)} factor`,
              str(r.term_days) && `${str(r.term_days)} day`,
              str(r.commission) && `${str(r.commission)} comm.`,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={i} className="py-3 flex items-start gap-3">
                <span className={`mt-1.5 inline-block w-2 h-2 rounded-full shrink-0 ${lenderDotClass(status)}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-fg font-medium text-[13px]">
                    {str(r.lender_name) || str(r.lender_id) || "Lender"}
                  </div>
                  <div className="text-[11px] text-fg-dim leading-relaxed mt-0.5">
                    {str(r.note) || offerDetail || "—"}
                  </div>
                </div>
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${lenderStatusClass(status)}`}
                >
                  {status}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ShopTile({ label, count }: { label: string; count: number }) {
  return (
    <div>
      <div className="text-sm font-bold text-fg">{count}</div>
      <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">{label}</div>
    </div>
  );
}

function lenderDotClass(status: string): string {
  if (status === "offer") return "bg-emerald-400";
  if (status === "replied") return "bg-sky-400";
  if (status === "declined") return "bg-fg-dim";
  if (status === "sent") return "bg-amber-400";
  return "bg-fg-faint";
}

function lenderStatusClass(status: string): string {
  if (status === "offer") return "bg-emerald-500/15 text-emerald-300";
  if (status === "replied") return "bg-sky-500/15 text-sky-300";
  if (status === "declined") return "bg-fg-dim/15 text-fg-dim";
  if (status === "sent") return "bg-amber-500/15 text-amber-300";
  return "bg-bg-deep text-fg-muted";
}

/* -------------------------------------------------------------------------- */
/* Underwriting types (application_underwriting table — migration 069)        */
/* -------------------------------------------------------------------------- */

type UnderwritingRun = {
  id: string;
  run_at: string;
  status: "pending" | "parsing" | "complete" | "error";
  readiness_score: number | null;
  risk_flags: string[] | null;
  error_message: string | null;
};

/* -------------------------------------------------------------------------- */
/* Sparkline — pure SVG polyline, no chart library                             */
/* FIXME(api): parser_output series fields are Phase ε (daemon side).         */
/* -------------------------------------------------------------------------- */

function Sparkline({
  values,
  label,
  width = 120,
  height = 30,
}: {
  values: number[];
  label: string;
  width?: number;
  height?: number;
}) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pad = 2;
  const points = values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (width - pad * 2);
      const y = pad + (1 - (v - min) / range) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] text-fg-dim font-medium">{label}</span>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible"
        aria-hidden="true"
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          className="text-accent"
        />
      </svg>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* UnderwritingBadge                                                           */
/* FIXME(api): /api/applications/[id]/underwriting/latest and                 */
/*             /api/applications/[id]/underwriting/run — Phase ε endpoints.   */
/* -------------------------------------------------------------------------- */

function UnderwritingBadge({
  applicationId,
  tenantSlug,
  run,
  onRerun,
  rerunPending,
}: {
  applicationId: string;
  tenantSlug: string;
  run: UnderwritingRun | null;
  onRerun: () => void;
  rerunPending: boolean;
}) {
  // 2026-06-11 CC bug: /t/<slug>/underwriting page doesn't exist in the
  // SunBiz manifest, so the old underwritingHref Link 404'd. The drawer
  // (this component's parent) is the canonical surface — UnderwritingPanel
  // further down renders the metric card + banking signals + risk flags
  // + sales angle inline. The link is removed; "Run underwriting →" is
  // now a button calling onRerun directly. applicationId + tenantSlug
  // retained on the type signature for future re-introduction.
  void applicationId; void tenantSlug;

  if (!run) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-semibold bg-bg-deep border border-bg-border text-fg-dim">
          Not underwritten
        </span>
        <button
          type="button"
          onClick={onRerun}
          disabled={rerunPending}
          className="text-[10.5px] text-accent hover:underline disabled:opacity-40"
        >
          {rerunPending ? "Starting…" : "Run underwriting →"}
        </button>
      </div>
    );
  }

  if (run.status === "pending" || run.status === "parsing") {
    return (
      <div className="flex items-center gap-2">
        <span
          className="inline-block w-3 h-3 rounded-full border-2 border-amber-400 border-t-transparent animate-spin"
          aria-hidden="true"
        />
        <span className="text-[10.5px] font-semibold text-amber-300">
          Underwriting in progress…
        </span>
      </div>
    );
  }

  if (run.status === "error") {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-semibold bg-red-500/15 border border-red-500/30 text-red-300"
          title={run.error_message || "Unknown error"}
        >
          Underwriting failed
        </span>
        {run.error_message && (
          <span
            className="text-[10px] text-red-300/70 truncate max-w-[160px]"
            title={run.error_message}
          >
            {run.error_message}
          </span>
        )}
        <button
          type="button"
          disabled={rerunPending}
          onClick={onRerun}
          className="text-[10.5px] font-semibold px-2 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 disabled:opacity-50"
        >
          {rerunPending ? "…" : "Retry"}
        </button>
      </div>
    );
  }

  // status === 'complete'
  const score = typeof run.readiness_score === "number" ? run.readiness_score : null;
  const scoreLabel = score !== null ? `${score}/100` : "—";

  let badgeClass = "bg-red-500/15 border-red-500/30 text-red-300";
  let badgeText = `Not ready (readiness ${scoreLabel})`;
  if (score !== null && score >= 70) {
    badgeClass = "bg-emerald-500/15 border-emerald-500/30 text-emerald-300";
    badgeText = `Ready to shop (readiness ${scoreLabel})`;
  } else if (score !== null && score >= 40) {
    badgeClass = "bg-amber-500/15 border-amber-500/30 text-amber-300";
    badgeText = `Caution (readiness ${scoreLabel}) — see risk flags`;
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-semibold border ${badgeClass}`}
    >
      {badgeText}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* BankTab — enhanced with underwriting status + sparklines (2026-05-25)      */
/* -------------------------------------------------------------------------- */

function BankTab({
  record,
  application,
  tenantSlug,
}: {
  record: Record<string, unknown>;
  application: { id: string; data: Record<string, unknown> } | null;
  tenantSlug: string;
}) {
  const applicationId = application?.id ?? null;

  // Underwriting run state.
  // undefined = fetch still in flight (shows "Loading…")
  // null      = no run yet, or Phase ε endpoint not built (shows "Not underwritten")
  // FIXME(api): /api/applications/[id]/underwriting/latest — Phase ε
  const [uwRun, setUwRun] = useState<UnderwritingRun | null | undefined>(undefined);
  const [uwError, setUwError] = useState<string | null>(null);
  const [rerunPending, setRerunPending] = useState(false);

  const fetchLatestRun = useCallback(async () => {
    if (!applicationId) return;
    try {
      const r = await fetch(`/api/applications/${applicationId}/underwriting/latest`, {
        credentials: "include",
        cache: "no-store",
      });
      const j = await r.json().catch(() => ({}));
      // Non-ok (including 404 while Phase ε endpoint isn't built yet) →
      // resolve to null so the badge shows "Not underwritten", not "Loading…"
      // indefinitely.
      if (!r.ok) {
        setUwRun(null);
        return;
      }
      setUwRun((j.run as UnderwritingRun) ?? null);
    } catch {
      // Network failure — resolve to null; operator can retry via Re-run.
      setUwRun(null);
    }
  }, [applicationId]);

  useEffect(() => {
    fetchLatestRun();
  }, [fetchLatestRun]);

  // Auto-poll while underwriting is in flight. The kick-orchestrator-once
  // fix (SunBiz-Agent 25932e7) makes Re-run complete in ~2 min, but
  // without polling the drawer kept showing "in progress…" forever
  // because fetchLatestRun() only ran once after Re-run, when the row
  // was still pending. Now: re-fetch every 5s while pending/parsing,
  // stop on complete/error. Visibility-aware so we don't hammer when
  // the tab is hidden. Same pattern as ShoppingOutClient polling.
  useEffect(() => {
    if (uwRun?.status !== "pending" && uwRun?.status !== "parsing") return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchLatestRun();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [uwRun?.status, fetchLatestRun]);

  // FIXME(api): /api/applications/[id]/underwriting/run — Phase ε
  const handleRerun = async () => {
    if (!applicationId) return;
    setRerunPending(true);
    setUwError(null);
    try {
      const r = await fetch(`/api/applications/${applicationId}/underwriting/run`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggered_by: "manual" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setUwError(j.error || `failed_${r.status}`);
        return;
      }
      await fetchLatestRun();
    } catch (e) {
      setUwError(String((e as Error).message || e));
    } finally {
      setRerunPending(false);
    }
  };

  // Extract sparkline series from parser_output.
  // Phase ε — absent until the parser daemon writes them.
  // Only render Sparkline when the series has ≥ 2 data points.
  const parserOutput =
    record.parser_output && typeof record.parser_output === "object"
      ? (record.parser_output as Record<string, unknown>)
      : null;

  const revenueSeries: number[] = Array.isArray(parserOutput?.monthly_revenue_series)
    ? (parserOutput!.monthly_revenue_series as { amount: number }[])
        .slice(-3)
        .map((p) => (typeof p.amount === "number" ? p.amount : 0))
    : [];

  const balanceSeries: number[] = Array.isArray(parserOutput?.daily_balance_series)
    ? (parserOutput!.daily_balance_series as { amount: number }[])
        .slice(-90)
        .map((p) => (typeof p.amount === "number" ? p.amount : 0))
    : [];

  const depositSeries: number[] = Array.isArray(parserOutput?.deposits_per_month_series)
    ? (parserOutput!.deposits_per_month_series as { count: number }[])
        .slice(-3)
        .map((p) => (typeof p.count === "number" ? p.count : 0))
    : [];

  // Labels shown above each sparkline. Fall back to static record values
  // when no series data exists — those values also appear in the field rows
  // below, so no separate static fallback div is needed inside Trends.
  const avgRevLabel = record.avg_monthly_revenue
    ? fmtMoney(record.avg_monthly_revenue)
    : record.monthly_revenue
      ? fmtMoney(record.monthly_revenue)
      : null;
  const avgBalLabel = record.avg_daily_balance ? fmtMoney(record.avg_daily_balance) : null;
  const depMonthLabel = record.deposits_per_month ? String(record.deposits_per_month) : null;

  // Risk flags from the latest underwriting run.
  const riskFlags: string[] =
    Array.isArray(uwRun?.risk_flags) && (uwRun?.risk_flags?.length ?? 0) > 0
      ? (uwRun!.risk_flags as string[])
      : [];

  // Static field rows — original BankTab behaviour fully preserved.
  const FIELDS: { key: string; label: string; format?: "money" }[] = [
    { key: "avg_monthly_revenue", label: "Avg monthly revenue", format: "money" },
    { key: "monthly_revenue", label: "Avg monthly revenue", format: "money" },
    { key: "revenue_trend", label: "Revenue trend" },
    { key: "avg_daily_balance", label: "Avg daily balance", format: "money" },
    { key: "nsf_avg", label: "NSF avg / mo" },
    { key: "nsf_count", label: "NSF avg / mo" },
    { key: "deposit_consistency", label: "Deposit consistency" },
    { key: "deposits_per_month", label: "Deposits / month" },
    { key: "statements", label: "Statements" },
    { key: "open_mca_positions", label: "Open MCA positions" },
    { key: "leverage_ratio", label: "Leverage ratio" },
    { key: "last_funding", label: "Last funding" },
    { key: "bank_name", label: "Bank" },
  ];
  const seen = new Set<string>();
  const rows = FIELDS.filter((f) => {
    const v = record[f.key];
    if (v == null || v === "") return false;
    if (seen.has(f.label)) return false;
    seen.add(f.label);
    return true;
  }).map((f) => ({
    label: f.label,
    value: f.format === "money" ? fmtMoney(record[f.key]) : String(record[f.key]),
  }));

  const isRunInProgress = uwRun?.status === "pending" || uwRun?.status === "parsing";
  // 2026-06-11: /t/<slug>/underwriting page doesn't exist; link removed.
  // Drawer is the canonical underwriting surface (UnderwritingPanel below).
  const underwritingHref: string | null = null;
  void tenantSlug; void applicationId;

  return (
    <div className="space-y-4">
      {/* Underwriting status — application-only; hidden on the lead drawer */}
      {applicationId && (
        <div className="rounded-md border border-bg-border bg-bg-deep/40 p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold mb-1">
            Underwriting
          </div>
          {uwRun === undefined ? (
            <div className="text-[11px] text-fg-dim italic">Loading…</div>
          ) : (
            <UnderwritingBadge
              applicationId={applicationId}
              tenantSlug={tenantSlug}
              run={uwRun}
              onRerun={handleRerun}
              rerunPending={rerunPending}
            />
          )}
          {uwError && <div className="text-[11px] text-red-300">{uwError}</div>}

          {/* Risk flags chip strip — only when flags present */}
          {riskFlags.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {riskFlags.map((flag) => (
                <span
                  key={flag}
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30 font-semibold"
                >
                  {flag.replace(/_/g, " ")}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sparklines — only when the daemon has written series data.
          Static number fallbacks live in the field rows below, not here. */}
      {(revenueSeries.length >= 2 || balanceSeries.length >= 2 || depositSeries.length >= 2) && (
        <div className="rounded-md border border-bg-border bg-bg-deep/40 p-3">
          <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold mb-3">
            Trends
          </div>
          <div className="flex items-start justify-around gap-2">
            {revenueSeries.length >= 2 && (
              <Sparkline values={revenueSeries} label={avgRevLabel || "Rev / mo"} />
            )}
            {balanceSeries.length >= 2 && (
              <Sparkline values={balanceSeries} label={avgBalLabel || "Daily bal"} />
            )}
            {depositSeries.length >= 2 && (
              <Sparkline
                values={depositSeries}
                label={depMonthLabel ? `${depMonthLabel}/mo` : "Dep / mo"}
              />
            )}
          </div>
        </div>
      )}

      {/* Static field rows — original behaviour preserved */}
      {rows.length === 0 && !applicationId ? (
        <div className="text-xs text-fg-dim italic py-6 text-center">
          No banking info yet. Fields fill in from the application form, uploaded
          bank statements, and the underwriter brief.
        </div>
      ) : (
        <div className="space-y-1">
          {rows.map((r, i) => (
            <div
              key={i}
              className="flex items-baseline justify-between gap-3 py-2.5 border-b border-bg-border last:border-b-0"
            >
              <dt className="text-[12px] text-fg-muted">{r.label}</dt>
              <dd className="text-fg text-[13px] font-medium text-right">{r.value}</dd>
            </div>
          ))}
        </div>
      )}

      {/* Re-run button + report link — application-only footer */}
      {applicationId && (
        <div className="pt-1 flex flex-col items-end gap-1.5">
          <button
            type="button"
            disabled={isRunInProgress || rerunPending}
            onClick={handleRerun}
            className="text-[11px] font-semibold px-3 py-1.5 rounded-md bg-bg-elev border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev/80 disabled:opacity-40"
          >
            {rerunPending ? "Running…" : "Re-run underwriting"}
          </button>
          {underwritingHref && (
            <Link
              href={underwritingHref}
              className="text-xs text-fg-dim hover:text-fg underline-offset-2 hover:underline"
            >
              View full underwriting report →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

// Money formatting moved to lib/format-helpers (shared with timeline +
// integrations panel). Local alias kept for in-file callers.
const fmtMoney = formatMoney;

type NoteRow = {
  id: string;
  content_preview: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

function NotesTab({ leadId }: { leadId: string }) {
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/notes`, { credentials: "include" });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || "load_failed");
        setNotes([]);
        return;
      }
      setNotes((j.notes || []) as NoteRow[]);
    } catch (e) {
      setError(String((e as Error).message || e));
      setNotes([]);
    }
  }, [leadId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async () => {
    if (!draft.trim()) return;
    setPending(true);
    setError(null);
    try {
      const r = await fetch(`/api/leads/${leadId}/notes`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: draft }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `failed_${r.status}`);
        return;
      }
      setDraft("");
      await reload();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a note about this lead…"
          rows={3}
          maxLength={4000}
          className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg resize-none"
        />
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-fg-dim">
            {error ? <span className="text-red-400">{error}</span> : `${draft.length}/4000`}
          </div>
          <button
            type="button"
            disabled={pending || !draft.trim()}
            onClick={save}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save note"}
          </button>
        </div>
      </div>
      <div className="border-t border-bg-border pt-3">
        {notes === null ? (
          <div className="text-xs text-fg-dim italic">Loading…</div>
        ) : notes.length === 0 ? (
          <div className="text-xs text-fg-dim italic py-3 text-center">
            No notes yet. Your first one will land at the top.
          </div>
        ) : (
          <ul className="space-y-2.5">
            {notes.map((n) => {
              const author =
                n.metadata && typeof n.metadata === "object"
                  ? (n.metadata as Record<string, unknown>).author_email
                  : null;
              return (
                <li key={n.id} className="rounded-md bg-bg-deep/60 border border-bg-border p-2.5">
                  <div className="text-[13px] text-fg whitespace-pre-wrap leading-relaxed">
                    {n.content_preview}
                  </div>
                  <div className="text-[10.5px] text-fg-dim mt-1.5">
                    {typeof author === "string" ? `${author} · ` : ""}
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function DocumentsTab({
  recordId,
  entity,
  initialDocs,
  onChange,
}: {
  recordId: string;
  entity: "lead" | "application";
  initialDocs: DocRow[];
  onChange?: () => void | Promise<void>;
}) {
  const [docs, setDocs] = useState<DocRow[]>(initialDocs);
  const [docType, setDocType] = useState<string>("bank_statements_3mo");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageNotice, setStageNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const qs = entity === "application" ? "?entity=application" : "";
      const r = await fetch(`/api/leads/${recordId}/documents${qs}`, { credentials: "include" });
      const j = await r.json();
      if (j.ok) setDocs((j.documents || []) as DocRow[]);
    } catch {
      /* keep previous list */
    }
  }, [recordId, entity]);

  const upload = async (file: File) => {
    setPending(true);
    setError(null);
    setStageNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("doc_type", docType);
      fd.append("source", "drawer_upload");
      const qs = entity === "application" ? "?entity=application" : "";
      const r = await fetch(`/api/leads/${recordId}/documents${qs}`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setError(j.error || `upload_failed_${r.status}`);
        return;
      }
      if (j.stage_bumped) {
        setStageNotice(`Stage advanced to ${j.stage_bumped} — all required docs received.`);
      }
      await refresh();
      if (onChange) await onChange();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setPending(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-bg-border bg-bg-deep/60 p-3 space-y-2">
        <label className="text-[11px] uppercase tracking-wider text-fg-muted">
          Upload a document
        </label>
        <select
          value={docType}
          onChange={(e) => setDocType(e.target.value)}
          className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-elev border border-bg-border text-fg"
        >
          {LEAD_DOC_TYPES.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
              {p.required ? " *" : ""}
            </option>
          ))}
        </select>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,application/pdf,.doc,.docx,.txt,.csv"
          disabled={pending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
          className="block w-full text-xs text-fg-muted file:mr-2 file:py-1 file:px-2 file:rounded-md file:border file:border-bg-border file:bg-bg-elev file:text-fg file:text-[11px] file:font-semibold file:cursor-pointer disabled:opacity-50"
        />
        {pending && <div className="text-[11px] text-fg-dim">Uploading…</div>}
        {error && (
          <div className="text-[11px] text-red-300">{error}</div>
        )}
        {stageNotice && (
          <div className="text-[11px] text-emerald-300">{stageNotice}</div>
        )}
      </div>

      <DocsSummary docs={docs} />

      {docs.length === 0 ? (
        <div className="text-xs text-fg-dim italic py-4 text-center">
          No documents yet. Upload one above or wait for the form intake.
        </div>
      ) : (
        <ul className="divide-y divide-bg-border">
          {docs.map((d) => {
            const isImage = (d.mime_type || "").startsWith("image/");
            return (
              <li key={d.id} className="flex items-center gap-3 py-2.5 text-sm">
                <div className="shrink-0 text-fg-dim">
                  {isImage ? <ImageIcon className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-fg truncate">{d.filename}</div>
                  <div className="text-[11px] text-fg-dim">
                    {leadDocTypeLabel(d.doc_type)} · {humanLeadDocSize(d.size_bytes)} ·{" "}
                    {new Date(d.uploaded_at).toLocaleDateString()}
                  </div>
                </div>
                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-semibold">
                  verified
                </span>
                <DocDownloadButton id={d.id} filename={d.filename} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DocsSummary({ docs }: { docs: DocRow[] }) {
  const onFile = docs.length;
  const verified = docs.length;
  const present = new Set(docs.map((d) => d.doc_type));
  // Required SunBiz canonical set — keep in sync with REQUIRED_LEAD_DOC_TYPES.
  const REQUIRED = ["bank_statements_3mo", "drivers_license", "void_cheque"];
  const missing = REQUIRED.filter((r) => !present.has(r));
  const total = REQUIRED.length + Math.max(onFile - (REQUIRED.length - missing.length), 0);

  return (
    <div className="rounded-lg border border-bg-border bg-bg-deep/40 p-3 flex items-center gap-4">
      <div>
        <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">On file</div>
        <div className="text-lg font-bold text-fg leading-tight">
          {onFile}
          <span className="text-fg-dim text-xs font-normal"> / {total || REQUIRED.length}</span>
        </div>
      </div>
      <div>
        <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">Verified</div>
        <div className="text-lg font-bold text-emerald-300 leading-tight">{verified}</div>
      </div>
      <div>
        <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">Missing</div>
        <div className={`text-lg font-bold leading-tight ${missing.length > 0 ? "text-red-300" : "text-fg-dim"}`}>
          {missing.length}
        </div>
      </div>
      {missing.length > 0 && (
        <div className="ml-auto text-right">
          <div className="text-[9.5px] uppercase tracking-wider text-fg-dim mb-1">Still needs</div>
          <div className="flex flex-wrap gap-1 justify-end">
            {missing.map((m) => (
              <span
                key={m}
                className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 font-semibold"
              >
                {leadDocTypeLabel(m).split(" (")[0]}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function computeMissingDocCount(docs: DocRow[]): number {
  const REQUIRED = ["bank_statements_3mo", "drivers_license", "void_cheque"];
  const present = new Set(docs.map((d) => d.doc_type));
  return REQUIRED.filter((r) => !present.has(r)).length;
}

function DocDownloadButton({ id, filename }: { id: string; filename: string }) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const r = await fetch(`/api/lead-documents/${id}`, { credentials: "include" });
          const j = await r.json();
          if (j.ok && j.url) {
            const a = document.createElement("a");
            a.href = j.url;
            a.download = filename;
            a.target = "_blank";
            a.rel = "noopener";
            document.body.appendChild(a);
            a.click();
            a.remove();
          }
        } finally {
          setPending(false);
        }
      }}
      className="text-[11px] uppercase tracking-wider px-2 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg disabled:opacity-50"
    >
      {pending ? "…" : "View"}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Footer composers                                                            */
/* -------------------------------------------------------------------------- */

type ComposerMode = "email" | "sms" | "torrent" | null;

/**
 * CallButton — click-to-call action (2026-05-25, CC ask).
 *
 * Uses `tel:` as the universal click-to-call protocol — Kixie's
 * PowerCall Chrome extension intercepts `tel:` URIs when configured
 * as the operator's default phone handler (their recommended setup
 * per Kixie docs). Without Kixie installed, the OS falls back to its
 * default dialer / softphone. Either path gives the operator a
 * working call action without dashboard-side per-integration code.
 *
 * The original implementation used a `kixie:call?number=...` custom
 * protocol; switched to `tel:` 2026-05-25 self-review after
 * confirming the custom scheme is unverified and `tel:` is what
 * Kixie's setup docs route through.
 *
 * Disabled state when there's no phone on the record.
 */
/**
 * Kixie alley-oop call button. Phase 3 of TT + Kixie embedding (2026-06-01).
 *
 * Posts to /api/leads/[id]/call which:
 *   1. Resolves the acting employee's Kixie agent email (user override →
 *      user_profiles.email → tenant default).
 *   2. Rings their Kixie line first (the alley-oop).
 *   3. Bridges to the lead's phone once they pick up.
 *
 * Replaces the prior tel:-based handler. The new path runs server-side
 * so it works from any device (mobile too), persists a call_initiated
 * interaction row immediately, and gets the full Kixie webhook lifecycle
 * (start/answer/end/disposition/recording) attributed via customField1.
 */
function CallButton({ recordId, phone }: { recordId: string; phone: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const dialable = (() => {
    if (!phone) return null;
    const raw = String(phone).trim();
    const digits = raw.replace(/\D+/g, "");
    if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    return null;
  })();

  if (!dialable) {
    return (
      <button
        type="button"
        disabled
        title="No phone on this record"
        className="flex-1 text-[12px] font-semibold px-3 py-2 rounded-md bg-bg-elev border border-bg-border text-fg-dim opacity-50 cursor-not-allowed inline-flex items-center justify-center gap-1.5"
      >
        <Phone className="w-3 h-3" />
        Call
      </button>
    );
  }

  async function startCall() {
    setBusy(true);
    setError(null);
    setFlash(null);
    try {
      const r = await fetch(`/api/leads/${recordId}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        agent_email?: string;
        target_phone?: string;
        error?: string;
      };
      if (!r.ok || !body.ok) {
        setError(body.message || body.error || `call_failed:${r.status}`);
        return;
      }
      setFlash(body.message || `Calling ${body.target_phone} via ${body.agent_email}`);
      // Auto-clear flash after 4s so it doesn't hang on the footer.
      setTimeout(() => setFlash(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "call_failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col items-stretch">
      <button
        type="button"
        onClick={startCall}
        disabled={busy}
        title={`Kixie alley-oop call to ${dialable} — your Kixie line rings first, then bridges to the lead`}
        className="text-[12px] font-semibold px-3 py-2 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-60 inline-flex items-center justify-center gap-1.5"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Phone className="w-3 h-3" />}
        Call
      </button>
      {error && (
        <div className="text-[10.5px] text-red-300 mt-1 leading-tight" title={error}>
          {error.length > 60 ? `${error.slice(0, 60)}…` : error}
        </div>
      )}
      {flash && (
        <div className="text-[10.5px] text-emerald-300 mt-1 leading-tight">
          {flash.length > 60 ? `${flash.slice(0, 60)}…` : flash}
        </div>
      )}
    </div>
  );
}

function DrawerFooter({
  recordId,
  entity,
  recordData,
  onChange,
}: {
  recordId: string;
  entity: "lead" | "application";
  recordData: Record<string, unknown>;
  onChange?: () => void | Promise<void>;
}) {
  const [mode, setMode] = useState<ComposerMode>(null);
  return (
    <div className="border-t border-bg-border bg-bg-elev/40">
      {mode === null ? (
        <div className="flex items-stretch gap-2 p-3">
          <button
            type="button"
            onClick={() => setMode("email")}
            className="flex-1 text-[12px] font-semibold px-3 py-2 rounded-md bg-bg-elev border border-bg-border text-fg hover:bg-bg-elev/80"
          >
            Send Email
          </button>
          <button
            type="button"
            onClick={() => setMode("sms")}
            className="flex-1 text-[12px] font-semibold px-3 py-2 rounded-md bg-bg-elev border border-bg-border text-fg hover:bg-bg-elev/80"
          >
            Send SMS
          </button>
          {/* Kixie alley-oop click-to-call (Phase 3 of TT + Kixie
              embedding, 2026-06-01). POSTs to /api/leads/[id]/call
              which resolves the acting employee's Kixie agent email
              (per-user override → user_profiles.email → tenant default),
              rings their Kixie line first, then bridges to the lead.
              Replaces the prior tel:-based handler. Disabled when
              there's no phone on the record. */}
          <CallButton recordId={recordId} phone={str(recordData.phone)} />
          <button
            type="button"
            onClick={() => setMode("torrent")}
            className="flex-1 text-[12px] font-semibold px-3 py-2 rounded-md bg-accent/15 border border-accent/40 text-accent hover:bg-accent/25"
          >
            Text Torrent
          </button>
        </div>
      ) : mode === "email" ? (
        <EmailComposer
          recordId={recordId}
          entity={entity}
          toEmail={str(recordData.email)}
          onClose={() => setMode(null)}
          onChange={onChange}
        />
      ) : mode === "sms" ? (
        <SmsComposer
          recordId={recordId}
          toPhone={str(recordData.phone)}
          onClose={() => setMode(null)}
          onChange={onChange}
        />
      ) : (
        <TextTorrentPicker
          leadId={entity === "lead" ? recordId : null}
          onClose={() => setMode(null)}
        />
      )}
    </div>
  );
}

function EmailComposer({
  recordId,
  entity,
  toEmail,
  onClose,
  onChange,
}: {
  recordId: string;
  entity: "lead" | "application";
  toEmail: string | null;
  onClose: () => void;
  onChange?: () => void | Promise<void>;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!toEmail) {
    return (
      <ComposerShell title="Email" onClose={onClose}>
        <div className="text-xs text-fg-dim italic">No email on this {entity}.</div>
      </ComposerShell>
    );
  }
  // POSTs to /api/leads/[id]/email which queues the send via
  // lead_interactions(status=queued) + emits the dashboard-queued event
  // for send_gateway.py to pick up. The drawer is fully decoupled from
  // SMTP credentials — the daemon side does the actual delivery.
  return (
    <ComposerShell title={`Email · ${toEmail}`} onClose={onClose}>
      <input
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        maxLength={200}
        className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Message"
        rows={5}
        maxLength={32000}
        className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg resize-none"
      />
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-fg-dim">
          {status
            ? status
            : body.length > 0
              ? `${body.length.toLocaleString()} / 32,000`
              : "Ready when you are"}
        </div>
        <button
          type="button"
          disabled={pending || !subject.trim() || !body.trim()}
          onClick={async () => {
            setPending(true);
            setStatus(null);
            try {
              const r = await fetch(`/api/leads/${recordId}/email`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                  to_email: toEmail,
                  subject,
                  body,
                }),
              });
              const j = await r.json().catch(() => ({}));
              if (r.ok && j.ok) {
                setStatus(
                  j.stage_bumped
                    ? `Queued · stage → ${j.stage_bumped}`
                    : "Queued",
                );
                setSubject("");
                setBody("");
                if (onChange) await onChange();
              } else {
                setStatus(j.error || `Failed (${r.status})`);
              }
            } catch (e) {
              setStatus(String((e as Error).message || e));
            } finally {
              setPending(false);
            }
          }}
          className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
        >
          {pending ? "Queueing…" : "Queue send"}
        </button>
      </div>
    </ComposerShell>
  );
}

function SmsComposer({
  recordId,
  toPhone,
  onClose,
  onChange,
}: {
  recordId: string;
  toPhone: string | null;
  onClose: () => void;
  onChange?: () => void | Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!toPhone) {
    return (
      <ComposerShell title="SMS" onClose={onClose}>
        <div className="text-xs text-fg-dim italic">No phone on this record.</div>
      </ComposerShell>
    );
  }
  return (
    <ComposerShell title={`SMS · ${toPhone}`} onClose={onClose}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Message"
        rows={3}
        maxLength={1600}
        className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg resize-none"
      />
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-fg-dim">
          {status || `${body.length}/1600`}
        </div>
        <button
          type="button"
          disabled={pending || !body}
          onClick={async () => {
            setPending(true);
            setStatus(null);
            try {
              const r = await fetch("/api/sms/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ to: toPhone, body }),
              });
              const j = await r.json().catch(() => ({}));
              if (r.ok && j.ok !== false) {
                // Fire-and-forget the stage transition. /api/sms/send
                // doesn't yet emit it server-side; we publish from the
                // client so SMS counts as outbound contact same as
                // queued email. Safe even if the lead is past
                // sent_application — engine guards block re-entry.
                fetch(`/api/leads/${recordId}/stage-event`, {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ type: "outbound_email_sent" }),
                }).catch(() => undefined);
                setStatus("Sent");
                setBody("");
                if (onChange) await onChange();
              } else {
                setStatus(j.error || `Failed (${r.status})`);
              }
            } catch (e) {
              setStatus(String((e as Error).message || e));
            } finally {
              setPending(false);
            }
          }}
          className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </div>
    </ComposerShell>
  );
}

type SequenceOption = { id: string; name: string; enabled: boolean };

function TextTorrentPicker({
  leadId,
  onClose,
}: {
  leadId: string | null;
  onClose: () => void;
}) {
  const [sequences, setSequences] = useState<SequenceOption[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/sequences", { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        const list = Array.isArray(j.sequences) ? j.sequences : [];
        setSequences(
          list
            .map((s: Record<string, unknown>) => ({
              id: String(s.id ?? ""),
              name: String(s.name ?? "Untitled sequence"),
              enabled: s.enabled !== false,
            }))
            .filter((s: SequenceOption) => s.id && s.enabled),
        );
      })
      .catch(() => {
        if (alive) setSequences([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!leadId) {
    return (
      <ComposerShell title="Text Torrent" onClose={onClose}>
        <div className="text-xs text-fg-dim italic">
          Open this drawer on a lead to enroll in a sequence.
        </div>
      </ComposerShell>
    );
  }

  return (
    <ComposerShell title="Text Torrent · enroll" onClose={onClose}>
      {sequences === null ? (
        <div className="text-xs text-fg-dim italic">Loading sequences…</div>
      ) : sequences.length === 0 ? (
        <div className="text-xs text-fg-dim italic leading-relaxed">
          No enabled sequences. Build one at{" "}
          <Link href="/sequences" className="underline text-fg-muted hover:text-fg">
            /sequences
          </Link>{" "}
          and toggle it on first.
        </div>
      ) : (
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full text-xs px-2 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg"
        >
          <option value="">Choose a sequence…</option>
          {sequences.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-fg-dim">{status}</div>
        <button
          type="button"
          disabled={pending || !selected}
          onClick={async () => {
            setPending(true);
            setStatus(null);
            try {
              const r = await fetch(`/api/sequences/${selected}/enroll`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ lead_id: leadId }),
              });
              const j = await r.json().catch(() => ({}));
              if (r.ok && j.ok) {
                setStatus(
                  j.scheduled_for
                    ? `Enrolled — fires ${new Date(j.scheduled_for).toLocaleString()}`
                    : "Enrolled",
                );
              } else if (r.status === 409 && j.error === "already_enrolled") {
                setStatus("Already enrolled (one-per-lead)");
              } else {
                setStatus(j.error || `Failed (${r.status})`);
              }
            } catch (e) {
              setStatus(String((e as Error).message || e));
            } finally {
              setPending(false);
            }
          }}
          className="text-[12px] font-semibold px-3 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
        >
          {pending ? "Enrolling…" : "Enroll"}
        </button>
      </div>
    </ComposerShell>
  );
}

function ComposerShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-fg-muted">{title}</div>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-fg-dim hover:text-fg"
        >
          Cancel
        </button>
      </div>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header sub-components: stat tiles + owner/assigned-to                       */
/* -------------------------------------------------------------------------- */

function StatTiles({
  record,
  application,
}: {
  record: Record<string, unknown>;
  application: { id: string; data: Record<string, unknown> } | null;
}) {
  const requested =
    record.requested_amount ?? application?.data?.requested_amount ?? null;
  const monthly = record.monthly_revenue ?? record.avg_monthly_revenue ?? null;
  const paperGrade = str(record.paper_grade) || str(record.leverage_grade);
  const nsf = record.nsf_avg ?? record.nsf_count ?? null;
  const openPositions =
    record.open_mca_positions ?? application?.data?.open_mca_positions ?? null;
  const bestOffer = application?.data?.best_offer ?? null;

  return (
    <div className="grid grid-cols-4 gap-2">
      <StatTile
        label="Request"
        primary={requested != null ? fmtMoney(requested) : "—"}
        secondary={paperGrade ? `paper ${paperGrade}` : null}
      />
      <StatTile
        label="Rev / mo"
        primary={monthly != null ? fmtMoney(monthly) : "—"}
        secondary={nsf != null ? `NSF ${nsf}` : null}
      />
      <StatTile
        label="Leverage"
        primary={openPositions != null ? `${openPositions}` : "—"}
        secondary={openPositions != null ? `${openPositions} open pos` : null}
      />
      <StatTile
        label="Best offer"
        primary={bestOffer != null ? fmtMoney(bestOffer) : "—"}
        secondary={null}
      />
    </div>
  );
}

function StatTile({
  label,
  primary,
  secondary,
}: {
  label: string;
  primary: string;
  secondary: string | null;
}) {
  // Empty tiles (primary === "—") get a softer treatment so the stark
  // em-dash doesn't read as broken UI when a lead hasn't been graded yet.
  // 2026-06-08: refined per CC's "less blocky" pass — softer border,
  // rounded-lg, faded primary on empty, tighter label letter-spacing.
  const isEmpty = primary === "—";
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 transition-colors ${
        isEmpty
          ? "border-bg-border/40 bg-bg-deep/20"
          : "border-bg-border/70 bg-bg-deep/40"
      }`}
    >
      <div className="text-[9.5px] uppercase tracking-[0.08em] text-fg-dim/80 leading-tight">
        {label}
      </div>
      <div
        className={`text-[14px] font-bold leading-tight mt-1 ${
          isEmpty ? "text-fg-dim/60" : "text-fg"
        }`}
      >
        {primary}
      </div>
      {secondary && (
        <div className="text-[9.5px] text-fg-dim mt-0.5 truncate">{secondary}</div>
      )}
    </div>
  );
}

function OwnerAssignedRow({ record }: { record: Record<string, unknown> }) {
  const ownerName = str(record.contact_name) || str(record.owner_name) || "—";
  const ownerPhone = str(record.phone) || str(record.contact_phone);
  const ownerEmail = str(record.email) || str(record.contact_email);
  const assignedName =
    str(record.assigned_to_name) ||
    str(record.assigned_to) ||
    str(record.owner_assigned) ||
    null;
  const lastTouchIso = lastTouchIsoFlat(record);

  // 2026-06-08 refinement (CC "less blocky" pass): softer label weight,
  // tighter line-height, vertical stack for the contact lines so phone +
  // email don't smash into each other on long values.
  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="min-w-0">
        <div className="text-[9.5px] uppercase tracking-[0.08em] text-fg-dim/80 mb-1.5">
          Owner / Signer
        </div>
        <div className="text-[13px] font-medium text-fg leading-tight">{ownerName}</div>
        <div className="mt-1 space-y-0.5">
          {ownerPhone && (
            <div className="text-[11px] text-fg-muted/90 inline-flex items-center gap-1.5">
              <Phone className="w-3 h-3 opacity-70" />
              <span className="truncate">{ownerPhone}</span>
            </div>
          )}
          {ownerEmail && (
            <div className="text-[11px] text-fg-muted/90 truncate inline-flex items-center gap-1.5 w-full">
              <Mail className="w-3 h-3 opacity-70 shrink-0" />
              <span className="truncate">{ownerEmail}</span>
            </div>
          )}
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[9.5px] uppercase tracking-[0.08em] text-fg-dim/80 mb-1.5">
          Assigned to
        </div>
        <div className="text-[13px] font-medium text-fg leading-tight">{assignedName || "Unassigned"}</div>
        {lastTouchIso && (
          <div className="text-[10.5px] text-fg-dim mt-1.5">
            <span className="uppercase tracking-wider mr-1">Last touch</span>
            {relTime(lastTouchIso)}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Owner tab — signer + business cards                                         */
/* -------------------------------------------------------------------------- */

function OwnerTab({ record }: { record: Record<string, unknown> }) {
  const signerName = str(record.contact_name) || str(record.owner_name) || "—";
  const signerRole = str(record.contact_role) || str(record.owner_role) || "CEO";
  const ownership =
    record.ownership_pct != null ? `${record.ownership_pct}` : "100";
  const dob = str(record.owner_dob) || str(record.contact_dob);
  const citizenship = str(record.owner_citizenship) || str(record.contact_citizenship);
  const ssnLast4 = str(record.owner_ssn_last4) || str(record.ssn_last4);
  const credit = record.credit_score ?? record.owner_credit_score ?? null;
  const phone = str(record.phone) || str(record.contact_phone);
  const email = str(record.email) || str(record.contact_email);

  // Owner address — Phase 3 of Jordan/Oasis 2026-05-23 restructure.
  // Lives on the application JSONB (or on the lead for legacy rows that
  // captured it pre-application).
  const addrLine1 = str(record.owner_address_line1);
  const addrLine2 = str(record.owner_address_line2);
  const addrCity = str(record.owner_address_city);
  const addrState = str(record.owner_address_state);
  const addrZip = str(record.owner_address_zip);
  const addressLines: string[] = [];
  if (addrLine1) addressLines.push(addrLine1);
  if (addrLine2) addressLines.push(addrLine2);
  const cityStateZip = [addrCity, [addrState, addrZip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  if (cityStateZip) addressLines.push(cityStateZip);
  const hasAddress = addressLines.length > 0;

  const legalName = str(record.legal_name) || str(record.business_name);
  const dba = str(record.dba) || legalName;
  const ein = str(record.ein) || str(record.tax_id);
  const state = str(record.state) || str(record.business_state);
  const industry = str(record.industry);
  const subIndustry = str(record.sub_industry);
  const tib = str(record.time_in_business);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-bg-border bg-bg-deep/40 p-3.5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold mb-1">
              Signer / Guarantor
            </div>
            <div className="text-[14px] font-bold text-fg">{signerName}</div>
            <div className="text-[11px] text-fg-dim">{signerRole}</div>
          </div>
          <div className="text-right">
            <div className="text-[9.5px] uppercase tracking-wider text-fg-dim">Ownership</div>
            <div className="text-lg font-bold text-fg leading-tight">
              {ownership}
              <span className="text-fg-dim text-xs font-normal">%</span>
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11.5px]">
          <KvRow label="Date of birth" value={dob} />
          <KvRow label="Citizenship" value={citizenship} />
          <KvRow label="SSN" value={ssnLast4 ? `••• •• ${ssnLast4}` : null} />
          <KvRow label="Credit score" value={credit != null ? String(credit) : null} />
          <KvRow label="Phone" value={phone} />
          <KvRow label="Email" value={email} />
        </dl>
        <div className="mt-3 pt-3 border-t border-bg-border">
          <div className="text-[9.5px] uppercase tracking-wider text-fg-dim mb-1.5">
            Owner address
          </div>
          {hasAddress ? (
            <div className="text-[12px] text-fg leading-relaxed font-medium">
              {addressLines.map((line, idx) => (
                <div key={idx}>{line}</div>
              ))}
            </div>
          ) : (
            <div className="text-[12px] text-fg-dim italic">—</div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-bg-border bg-bg-deep/40 p-3.5">
        <div className="text-[10px] uppercase tracking-wider text-fg-dim font-semibold mb-3">
          Business
        </div>
        <dl className="space-y-2 text-[12px]">
          <KvRow label="Legal name" value={legalName} fullWidth />
          <KvRow label="DBA" value={dba} fullWidth />
          <KvRow label="EIN" value={ein} fullWidth highlight />
          <KvRow label="State" value={state} fullWidth />
          <KvRow
            label="Industry"
            value={[industry, subIndustry].filter(Boolean).join(" · ") || null}
            fullWidth
          />
          <KvRow label="Time in business" value={tib} fullWidth />
        </dl>
      </div>
    </div>
  );
}

function KvRow({
  label,
  value,
  fullWidth,
  highlight,
}: {
  label: string;
  value: string | null;
  fullWidth?: boolean;
  highlight?: boolean;
}) {
  if (fullWidth) {
    return (
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-fg-muted">{label}</dt>
        <dd className={`font-medium text-right ${highlight ? "text-amber-300" : "text-fg"}`}>
          {value || "—"}
        </dd>
      </div>
    );
  }
  return (
    <div>
      <dt className="text-[9.5px] uppercase tracking-wider text-fg-dim">{label}</dt>
      <dd className="text-fg font-medium mt-0.5">{value || "—"}</dd>
    </div>
  );
}
