"use client";

/**
 * DealDetailsAccordion — plan §5 (Phase 1, the only fully-built ContextPanel
 * sub-component). 2-col label/value grid sourced straight from the
 * /api/leads/[id]/detail payload LeadFileBody already fetches.
 *
 * Note on `missing_info[]`: the plan names this field, but there is no
 * stored `missing_info` array on the record — "missing_info" is actually a
 * pipeline STAGE name in this codebase (lib/manifest/data.ts). The real
 * "what's still needed" signal is the same computed required-doc gap
 * LeadDetailDrawer's DocsSummary uses (bank statements / driver's license /
 * void cheque vs what's on file), so that's what renders here as amber
 * "Stips outstanding" chips.
 */
import { ChevronDown } from "lucide-react";
import { Tag } from "@/components/Card";
import { formatMoney } from "@/lib/format-helpers";

const REQUIRED_DOCS: { key: string; label: string }[] = [
  { key: "bank_statements_3mo", label: "Bank statements" },
  { key: "drivers_license", label: "Driver's license" },
  { key: "void_cheque", label: "Void cheque" },
];

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] uppercase tracking-[0.08em] text-fg-dim/80">{label}</div>
      <div className={`text-[13px] font-medium mt-0.5 truncate ${value ? "text-fg" : "text-fg-dim/60"}`}>
        {value ?? "—"}
      </div>
    </div>
  );
}

export function DealDetailsAccordion({
  record,
  documents,
  application,
  open,
  onToggle,
}: {
  record: Record<string, unknown>;
  documents: { doc_type: string }[];
  application: { data: Record<string, unknown> } | null;
  open: boolean;
  onToggle: () => void;
}) {
  const isOpen = open;

  const funding = record.requested_amount ?? application?.data?.requested_amount ?? null;
  const monthlyRevenue = record.monthly_revenue ?? record.avg_monthly_revenue ?? null;
  const nsf = record.nsf_avg ?? record.nsf_count ?? null;
  const openPositions = record.open_mca_positions ?? application?.data?.open_mca_positions ?? null;
  const leverage = record.leverage_ratio ?? null;
  const stage = str(record.stage) || str(record.status);

  const present = new Set(documents.map((d) => d.doc_type));
  const missing = REQUIRED_DOCS.filter((d) => !present.has(d.key));

  return (
    <div className="rounded-lg border border-bg-border bg-bg-elev/40 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-left"
      >
        <span className="text-[11px] font-bold uppercase tracking-wider text-fg-muted">Deal details</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-fg-dim transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <div className="px-3.5 pb-3.5 space-y-3">
            <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
              <Row label="Funding amount" value={funding != null ? formatMoney(funding) : null} />
              <Row label="Open MCA positions" value={openPositions != null ? String(openPositions) : null} />
              <Row label="Monthly revenue" value={monthlyRevenue != null ? formatMoney(monthlyRevenue) : null} />
              <Row label="NSF / mo" value={nsf != null ? String(nsf) : null} />
              <Row label="Leverage ratio" value={leverage != null ? String(leverage) : null} />
              <div className="min-w-0">
                <div className="text-[9.5px] uppercase tracking-[0.08em] text-fg-dim/80 mb-1">Stage</div>
                {stage ? <Tag tone="accent">{stage.replace(/_/g, " ")}</Tag> : <span className="text-[13px] text-fg-dim/60">—</span>}
              </div>
            </div>
            {missing.length > 0 && (
              <div>
                <div className="text-[9.5px] uppercase tracking-[0.08em] text-fg-dim/80 mb-1.5">
                  Stips outstanding
                </div>
                <div className="flex flex-wrap gap-1">
                  {missing.map((m) => (
                    <span
                      key={m.key}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-semibold"
                    >
                      {m.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
