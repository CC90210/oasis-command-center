"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import {
  INDUSTRY_AUTOMATIONS,
  matchIndustryAutomationGroup,
  type AutomationBuildType,
} from "@/lib/industry-automations";

const TYPES: readonly AutomationBuildType[] = ["Website", "Website + workflow", "Custom build"];

export function IndustryAutomationGuide({ initialIndustry }: { initialIndustry?: string | null }) {
  const initial = matchIndustryAutomationGroup(initialIndustry);
  const [industryId, setIndustryId] = useState(initial.id);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<AutomationBuildType | "All">("All");
  const group = INDUSTRY_AUTOMATIONS.find((item) => item.id === industryId) ?? initial;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return group.automations.filter((item) =>
      (type === "All" || item.buildType === type) &&
      (!needle || `${item.name} ${item.outcome} ${item.discovery}`.toLowerCase().includes(needle)),
    );
  }, [group, query, type]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" aria-label="Choose an industry">
        {INDUSTRY_AUTOMATIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={item.id === group.id}
            onClick={() => setIndustryId(item.id)}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors motion-reduce:transition-none ${
              item.id === group.id
                ? "border-accent/60 bg-accent/15 text-accent"
                : "border-bg-border bg-bg-elev/40 text-fg-muted hover:border-accent/30 hover:text-fg"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
        <label className="relative block">
          <span className="sr-only">Search automation opportunities</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-fg-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${group.label.toLowerCase()} opportunities`}
            className="w-full rounded-lg border border-bg-border bg-bg-elev/50 py-2 pl-9 pr-3 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent/50"
          />
        </label>
        <div className="flex flex-wrap gap-2" aria-label="Filter by build type">
          {(["All", ...TYPES] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={type === item}
              onClick={() => setType(item)}
              className={`rounded-lg border px-3 py-2 text-xs ${type === item ? "border-accent/50 text-accent" : "border-bg-border text-fg-muted"}`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-bold text-fg">{group.label}</h3>
        <span className="text-xs text-fg-muted">{visible.length} opportunities</span>
      </div>
      {visible.length === 0 ? (
        <p className="rounded-lg border border-bg-border p-4 text-sm text-fg-muted">No opportunities match that search.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((item) => (
            <article key={item.name} className="rounded-xl border border-bg-border bg-bg-elev/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <h4 className="text-sm font-bold text-fg">{item.name}</h4>
                <span className="shrink-0 rounded-full border border-bg-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                  {item.buildType}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{item.outcome}</p>
              <div className="mt-3 border-t border-bg-border pt-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-fg-muted">Ask this</p>
                <p className="mt-1 text-sm font-medium leading-relaxed text-fg">&ldquo;{item.discovery}&rdquo;</p>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="text-xs leading-relaxed text-fg-muted">
        Use these as discovery paths, not promises. Confirm the current process and business impact; CC or Adon confirms feasibility, integrations, scope, compliance, and price.
      </p>
    </div>
  );
}
