"use client";

/**
 * EnrichmentTab — the lead drawer's unified "Enrichment" tab (the tab key stays
 * "bgc" for URL/deep-link stability; only the label and contents changed).
 *
 * It brings together the two enrichment sources that were previously split
 * across the app, and pins a compact critical-flags summary at the top so an
 * operator sees risk the moment they open the tab:
 *
 *   1. Background check (merchant_background_checks) — court cases, UCC filings,
 *      liens, bankruptcies, MCA defaults. The actionable run / re-run / manual
 *      entry UI is the existing <BackgroundCheckTab/>, unchanged.
 *   2. CLAIR · Thomson Reuters CLEAR (clair_reports) — the manual, billable,
 *      permissible-use phone/address enrichment. The existing <ClairReportPanel/>
 *      (which keeps CLEAR data separate from the application record) is now
 *      surfaced here in the drawer, not only on the pipeline page. It is
 *      independent of the automated lookup: both may run on the same lead.
 *
 * The pinned summary reads BOTH sources read-only; the two panels below own all
 * writes and their own polling. The summary polls only while a background check
 * is in flight, and re-reads when either panel reports activity (onChanged →
 * refreshKey), so a freshly-pulled number or a completed check surfaces at top
 * without the operator leaving the tab.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldQuestion, Phone, PhoneOff } from "lucide-react";

import { hasUsablePhone } from "@/lib/clair/eligibility";

import { BackgroundCheckTab } from "./BackgroundCheckTab";
import { ClairReportPanel } from "./ClairReportPanel";
import { PhoneLookupPanel } from "./PhoneLookupPanel";

type RiskFlag =
  | "none"
  | "court_case"
  | "mca_default"
  | "ucc"
  | "lien"
  | "bankruptcy"
  | "unknown";

type BgCheck = {
  status: "pending" | "running" | "completed" | "error" | "needs_assist";
  risk_flag: RiskFlag;
  findings: unknown[] | null;
  findings_summary: string | null;
  created_at: string;
} | null;

type ClairReport = {
  status: "pending" | "completed" | "no_results" | "error";
  result_count: number | null;
  phones: { number?: string }[] | null;
  created_at: string;
} | null;

const RISK_LABEL: Record<RiskFlag, string> = {
  none: "Background clear",
  court_case: "Court case",
  mca_default: "MCA default",
  ucc: "Active UCC",
  lien: "Tax lien",
  bankruptcy: "Bankruptcy",
  unknown: "Unverified",
};

// The flags that make the whole summary box read as "high visibility". These
// are the ones an operator must not miss before advancing a deal.
const CRITICAL: ReadonlySet<RiskFlag> = new Set([
  "court_case",
  "mca_default",
  "ucc",
  "lien",
  "bankruptcy",
]);

function riskColor(flag: RiskFlag): string {
  if (flag === "none") return "#1f7a4d";
  if (flag === "mca_default") return "#b42318";
  if (flag === "unknown") return "#667085";
  return "#b54708"; // court / ucc / lien / bankruptcy
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** One rounded pill with an optional leading dot in a semantic color. */
function Chip({
  color,
  muted,
  children,
}: {
  color?: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
        muted
          ? "border-bg-border/60 text-fg-dim"
          : "border-bg-border text-fg"
      }`}
    >
      {color && (
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      )}
      {children}
    </span>
  );
}

/**
 * The pinned "small box" of critical flags. Deliberately terse: risk posture +
 * whether a phone number is on file, and when each was last determined. The
 * detail lives in the panels below.
 */
function EnrichmentSummary({
  leadId,
  refreshKey,
  leadData,
}: {
  leadId: string;
  refreshKey: number;
  leadData: Record<string, unknown>;
}) {
  const [bg, setBg] = useState<BgCheck>(null);
  const [clair, setClair] = useState<ClairReport>(null);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    // Read-only, and a failure here must never break the tab — the actionable
    // panels below are the source of truth and surface their own errors.
    const [bgRes, clairRes] = await Promise.allSettled([
      fetch(`/api/leads/${leadId}/background-check/latest`, { cache: "no-store" }).then((r) => r.json()),
      fetch(`/api/leads/${leadId}/clair-report`, { cache: "no-store" }).then((r) => r.json()),
    ]);
    if (bgRes.status === "fulfilled") setBg(bgRes.value?.check ?? null);
    if (clairRes.status === "fulfilled") setClair(clairRes.value?.reports?.[0] ?? null);
    setLoaded(true);
  }, [leadId]);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, refreshKey]);

  // Poll only while a background check is actually in flight, so a completing
  // check flips the summary without the operator switching tabs.
  useEffect(() => {
    if (bg && (bg.status === "pending" || bg.status === "running")) {
      timer.current = setTimeout(() => void load(), 5000);
      return () => {
        if (timer.current) clearTimeout(timer.current);
      };
    }
  }, [bg, load]);

  if (!loaded) {
    return (
      <div className="h-16 rounded-lg border border-bg-border/60 bg-bg-elev/30 animate-pulse" aria-hidden />
    );
  }

  const phoneCount = clair?.status === "completed" ? clair.phones?.length ?? 0 : 0;
  const isCritical = Boolean(bg && bg.status === "completed" && CRITICAL.has(bg.risk_flag));

  // Background chip — mirrors the risk semantics of the panel below.
  let bgChip: React.ReactNode;
  if (!bg) {
    bgChip = <Chip muted>No background check</Chip>;
  } else if (bg.status === "pending" || bg.status === "running") {
    bgChip = <Chip muted>Background check running…</Chip>;
  } else if (bg.status === "error") {
    bgChip = <Chip color={riskColor("mca_default")}>Background check error</Chip>;
  } else if (bg.status === "needs_assist") {
    bgChip = <Chip color={riskColor("unknown")}>Needs manual run</Chip>;
  } else {
    bgChip = <Chip color={riskColor(bg.risk_flag)}>{RISK_LABEL[bg.risk_flag]}</Chip>;
  }

  // Phone chips. The two sources are INDEPENDENT enrichments and both may have
  // run on the same lead, so each gets its own chip rather than competing for
  // one slot. Collapsing them into a single chip is what used to make a CLEAR
  // pull look like it did nothing on a lead the automated lookup had already
  // answered.
  const lookupStatus = String(leadData.phone_lookup_status ?? "");
  let tpsChip: React.ReactNode;
  if (lookupStatus === "found" || (hasUsablePhone(leadData) && !lookupStatus)) {
    tpsChip = (
      <Chip color="#1f7a4d">
        <Phone className="h-3 w-3" /> Phone on file — automated lookup
      </Chip>
    );
  } else if (lookupStatus === "pending" || lookupStatus === "running" || lookupStatus === "queued") {
    tpsChip = <Chip muted>Automated lookup running…</Chip>;
  } else if (lookupStatus === "manual_review") {
    tpsChip = (
      <Chip color={riskColor("unknown")}>
        <PhoneOff className="h-3 w-3" /> Automated lookup failed
      </Chip>
    );
  } else if (lookupStatus) {
    tpsChip = (
      <Chip muted>
        <PhoneOff className="h-3 w-3" /> Automated lookup: no match
      </Chip>
    );
  } else {
    tpsChip = (
      <Chip muted>
        <PhoneOff className="h-3 w-3" /> Automated lookup not run
      </Chip>
    );
  }

  // Only rendered once a CLEAR report exists — an absent chip means "never
  // pulled", which is different from "pulled and empty".
  let clairChip: React.ReactNode = null;
  if (clair?.status === "completed") {
    clairChip =
      phoneCount > 0 ? (
        <Chip color="#1f7a4d">
          <Phone className="h-3 w-3" /> CLAIR: {phoneCount} phone{phoneCount === 1 ? "" : "s"}
        </Chip>
      ) : (
        <Chip muted>
          <PhoneOff className="h-3 w-3" /> CLAIR: no numbers
        </Chip>
      );
  } else if (clair?.status === "no_results") {
    clairChip = (
      <Chip muted>
        <PhoneOff className="h-3 w-3" /> CLAIR: no match
      </Chip>
    );
  } else if (clair?.status === "error") {
    clairChip = (
      <Chip color={riskColor("mca_default")}>
        <PhoneOff className="h-3 w-3" /> CLAIR: error
      </Chip>
    );
  } else if (clair?.status === "pending") {
    clairChip = <Chip muted>CLAIR report pending…</Chip>;
  }

  const HeadIcon = isCritical ? ShieldAlert : bg?.risk_flag === "none" ? ShieldCheck : ShieldQuestion;

  return (
    <section
      aria-label="Enrichment summary"
      className={`rounded-lg border p-3 ${
        isCritical
          ? "border-status-warm/50 bg-status-warm/[0.06]"
          : "border-bg-border bg-bg-elev/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <HeadIcon
          className="h-4 w-4 shrink-0"
          style={{ color: isCritical ? "#b54708" : "var(--fg-dim, #667085)" }}
        />
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-dim">
          Enrichment summary
        </div>
        <div className="ml-auto text-[10px] text-fg-dim">
          {fmtWhen(bg?.created_at ?? clair?.created_at ?? null)}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {bgChip}
        {tpsChip}
        {clairChip}
      </div>

      {bg?.findings_summary && (
        <p className="mt-2 text-[11px] leading-relaxed text-fg-muted line-clamp-2">
          {bg.findings_summary}
        </p>
      )}
    </section>
  );
}

export function EnrichmentTab({
  leadId,
  record,
  onReload,
}: {
  leadId: string;
  // In the lead drawer, `record` IS the flattened lead data object (the same
  // value ClairReportPanel expects as `leadData` and clairAdvisory reads).
  record: Record<string, unknown>;
  /** Refetch the lead record from the drawer. */
  onReload?: () => void | Promise<void>;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  // A finished lookup writes to the LEAD (phone, phone_lookup_status), not just
  // to its own table, and `record` is a prop owned by the drawer. Bumping only
  // the local key would refresh the summary's own fetches while leaving every
  // consumer of `record` — including clairAdvisory, which tells the operator
  // whether a billable pull would be redundant — reading pre-lookup data until
  // someone manually reopened the drawer.
  const bump = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void onReload?.();
  }, [onReload]);

  return (
    <div className="space-y-5">
      <EnrichmentSummary leadId={leadId} refreshKey={refreshKey} leadData={record} />
      <BackgroundCheckTab leadId={leadId} record={record} onChanged={bump} />
      {/* Order is a recommendation, not a lock: the free automated lookup reads
          first because it is the cheaper thing to try. CLAIR sits below it and
          is independently runnable at any time — including on a lead this panel
          has already enriched. */}
      <PhoneLookupPanel leadId={leadId} leadData={record} onChanged={bump} />
      <ClairReportPanel leadId={leadId} leadData={record} onChanged={bump} />
    </div>
  );
}
