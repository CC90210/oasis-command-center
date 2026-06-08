/**
 * MCAProfilePanel — surfaces MCA-specific lead fields in the SunBiz
 * pipeline detail view.
 *
 * Adon's MCA follow-up architecture brief (2026-06-08) added a richer
 * data shape per merchant than the legacy SunBiz lead schema modeled:
 * multi-position funding history, named current funders with payment
 * schedules, SSN-last-4, EIN, DOB, multi-phone with type/network
 * metadata, address. The legacy schema put a few of these in jsonb
 * but never rendered them.
 *
 * This panel reads those keys from the lead's `data` blob and renders
 * the ones that exist. Missing keys render nothing — so legacy leads
 * imported before the brief look identical to before, and new MCA-style
 * leads get the richer view.
 *
 * PII handling: SSN is rendered as last-4 only (`data.ssn_last4`). Full
 * SSN is never written to the data blob from the importer — the source
 * data is hashed/truncated at parse time. DOB is rendered as-is since
 * it's needed for underwriting but isn't a Tier-1 secret.
 *
 * The whole panel is wrapped in a CollapsibleSection so it doesn't bloat
 * the drawer for leads that have no MCA history.
 */

import { CollapsibleSection } from "./CollapsibleSection";

type CurrentFunder = {
  funder?: string;
  frequency?: string; // "daily" | "weekly" | "monthly"
  payment?: number;
  notes?: string;
};

type MultiPhone = {
  number?: string;
  type?: string;    // "Mobile" | "Landline" | "VoIP" | "Toll-Free"
  network?: string; // "PCS" | "RBOC" | "ICO" | "WIRELESS" | "IPES" | "CLEC"
};

type MCALeadData = {
  // MCA-specific
  mca_positions?: number;            // 1-4+
  current_funders?: CurrentFunder[]; // structured funder array
  current_funders_text?: string;     // raw "Bizfund weekly $1,917, Forward Financing weekly $1,762.50"
  annual_revenue?: number | string;
  ssn_last4?: string;
  ein?: string;
  dob?: string;
  // Address
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  // Multi-phone
  phone?: string;
  phones?: MultiPhone[];
  // Import provenance
  source?: string;
  source_date_range?: string;
};

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,]/g, "").trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatMoney(v: unknown): string | null {
  const n = asNumber(v);
  if (n === null) return null;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function hasMCAFields(data: Record<string, unknown>): boolean {
  const d = data as MCALeadData;
  return Boolean(
    d.mca_positions ||
      d.current_funders?.length ||
      d.current_funders_text ||
      d.ssn_last4 ||
      d.ein ||
      d.dob ||
      d.phones?.length ||
      d.address ||
      d.city,
  );
}

export function MCAProfilePanel({ data }: { data: Record<string, unknown> }) {
  if (!hasMCAFields(data)) return null;

  const d = data as MCALeadData;
  const revenue = formatMoney(d.annual_revenue);
  const positions = d.mca_positions;
  const funders = d.current_funders ?? [];
  const fundersText = d.current_funders_text;
  const phones = d.phones ?? [];

  const previewBits: string[] = [];
  if (positions) previewBits.push(`${positions} position${positions === 1 ? "" : "s"}`);
  if (revenue) previewBits.push(`${revenue}/yr`);
  if (d.state) previewBits.push(d.state);
  const preview = previewBits.join(" · ");

  return (
    <CollapsibleSection
      title="MCA Profile"
      subtitle={d.source_date_range ? `Source: ${d.source ?? "unknown"} · ${d.source_date_range}` : undefined}
      storageKey={`sunbiz.mca-profile.collapsed.${d.ssn_last4 ?? d.ein ?? "default"}`}
      defaultCollapsed={false}
      collapsedPreview={preview || undefined}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        {/* Financial */}
        <Stat label="Annual Revenue" value={revenue} />
        <Stat
          label="Current MCA Positions"
          value={positions !== undefined ? String(positions) : null}
        />

        {/* Identity */}
        <Stat label="EIN" value={d.ein} mono />
        <Stat
          label="SSN (last 4)"
          value={d.ssn_last4 ? `••• •• ${d.ssn_last4}` : null}
          mono
        />
        <Stat label="Date of Birth" value={d.dob} />

        {/* Address */}
        <Stat
          label="Address"
          value={
            [d.address, [d.city, d.state].filter(Boolean).join(", "), d.zip]
              .filter(Boolean)
              .join(" ") || null
          }
        />
      </div>

      {/* Multi-phone — only render if we have secondary numbers */}
      {phones.length > 0 && (
        <div className="mt-5">
          <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-fg-dim mb-2">
            Additional Phones
          </h4>
          <ul className="space-y-1.5 text-sm">
            {phones.map((p, idx) => (
              <li key={idx} className="flex items-center gap-3">
                <span className="font-mono text-fg">{p.number || "—"}</span>
                {p.type && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-bg-elev text-fg-muted">
                    {p.type}
                  </span>
                )}
                {p.network && (
                  <span className="text-xs text-fg-dim">{p.network}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Current funders — structured rendering preferred; falls back to
          the raw text dump if the importer couldn't parse the funder line */}
      {(funders.length > 0 || fundersText) && (
        <div className="mt-5">
          <h4 className="text-[11px] font-bold uppercase tracking-[0.14em] text-fg-dim mb-2">
            Current Funders &amp; Payment Obligations
          </h4>
          {funders.length > 0 ? (
            <ul className="space-y-2">
              {funders.map((f, idx) => {
                const payment = formatMoney(f.payment);
                return (
                  <li
                    key={idx}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-bg-elev/60 text-sm"
                  >
                    <span className="font-medium text-fg truncate">
                      {f.funder || "(unnamed funder)"}
                    </span>
                    <span className="text-fg-muted whitespace-nowrap">
                      {payment ? `${payment} ${f.frequency ?? ""}` : f.frequency ?? "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs text-fg-muted leading-relaxed whitespace-pre-wrap font-mono">
              {fundersText}
            </p>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}

function Stat({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-fg-dim mb-0.5">
        {label}
      </div>
      <div
        className={`text-fg ${mono ? "font-mono" : ""} truncate`}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </div>
    </div>
  );
}
