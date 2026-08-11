"use client";

/**
 * SequenceTemplatesView — the single-screen inventory of EVERY drip template.
 *
 * For each sequence (live DB rows — the actual send source, not the seed
 * files): trigger stage, status, email class, and every step in send order
 * with its landing time (cumulative), channel, sender label, subject, full
 * body, and the complete A/B variant pools the executor samples from (which
 * the step editor previously never displayed). A sample-lead render toggle
 * shows the copy as a merchant would receive it.
 */

import { useMemo, useState } from "react";
import { InterchangeLockProvider } from "./interchange-lock";
import Link from "next/link";
import {
  ChevronDown,
  ChevronRight,
  Edit3,
  Mail,
  MessageSquareText,
  Search,
  WandSparkles,
} from "lucide-react";
import type { DripStep } from "@/lib/drips/types";
import type { PoolTemplate } from "@/lib/drips/template-pool";
import type { BrandKey } from "@/lib/email/brands";
import { TemplateInterchange } from "./TemplateInterchange";
import {
  cumulativeSchedule,
  formatDelayMinutes,
  renderSample,
  sequenceSearchText,
} from "@/lib/drips/template-inventory";

export type TemplatesViewRow = {
  id: string;
  name: string;
  description: string | null;
  trigger_filter: Record<string, unknown>;
  steps: DripStep[];
  enabled: boolean;
  email_class?: string;
};

function triggerStage(row: TemplatesViewRow): string {
  const f = (row.trigger_filter || {}) as { to?: unknown };
  return typeof f.to === "string" && f.to ? f.to : "—";
}


/** Which brand this sequence speaks as. An absent marker resolves to SunBiz,
 *  matching lib/drips/brand-routing's safe default: a cold lead mis-sent as
 *  SunBiz costs reputation on a domain that can absorb it, the reverse is a
 *  confusing first impression on one that cannot. */
function rowBrand(row: TemplatesViewRow): BrandKey {
  const f = (row.trigger_filter || {}) as { brand?: unknown };
  return String(f.brand ?? "").toLowerCase() === "bluerise" ? "bluerise" : "sunbiz";
}

function CopyBlock({ label, text, sample }: { label?: string; text: string; sample: boolean }) {
  return (
    <div>
      {label && (
        <div className="text-[10px] font-bold uppercase tracking-wider text-fg-dim">{label}</div>
      )}
      <pre className="mt-0.5 whitespace-pre-wrap break-words rounded-md border border-bg-border bg-bg-deep/60 px-3 py-2 font-sans text-[12px] leading-relaxed text-fg-muted">
        {sample ? renderSample(text) : text}
      </pre>
    </div>
  );
}

function StepCard({
  scheduled,
  sample,
  sequenceId,
  steps,
  brand,
  stage,
  pool,
}: {
  scheduled: { step: DripStep; index: number; cumulativeMinutes: number };
  sample: boolean;
  sequenceId: string;
  steps: DripStep[];
  brand: BrandKey;
  stage: string;
  pool: PoolTemplate[];
}) {
  const { step, index, cumulativeMinutes } = scheduled;
  const isEmail = step.channel === "email";
  const bodyVariants = step.body_variants || [];
  const subjectVariants = step.subject_variants || [];
  const [showVariants, setShowVariants] = useState(false);

  return (
    <div className="rounded-lg border border-bg-border bg-bg-elev/30 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-bold ${
          isEmail
            ? "border-accent/30 bg-accent/10 text-accent"
            : "border-status-engaged/30 bg-status-engaged/10 text-status-engaged"
        }`}>
          {isEmail ? <Mail className="h-3 w-3" /> : <MessageSquareText className="h-3 w-3" />}
          Step {index + 1} · {isEmail ? "Email" : "SMS"}
        </span>
        <span className="text-fg-muted">
          lands <b className="text-fg">{formatDelayMinutes(cumulativeMinutes)}</b> after stage entry
          <span className="text-fg-dim"> (+{formatDelayMinutes(step.delay_minutes)} wait)</span>
        </span>
        {step.from_label && <span className="text-fg-dim">from “{step.from_label}”</span>}
        {step.from_number && <span className="font-mono text-fg-dim">{step.from_number}</span>}
        {step.body_html && (
          <span className="rounded-md border border-status-warm/30 bg-status-warm/10 px-1.5 py-0.5 text-[10px] font-bold text-status-warm">
            custom HTML
          </span>
        )}
      </div>

      <div className="mt-2 space-y-2">
        {isEmail && <CopyBlock label="Subject" text={step.subject || ""} sample={sample} />}
        <CopyBlock label={isEmail ? "Body" : undefined} text={step.body} sample={sample} />
      </div>

      <TemplateInterchange
        sequenceId={sequenceId}
        stepIndex={index}
        step={step}
        steps={steps}
        brand={brand}
        stage={stage}
        pool={pool}
      />

      {(bodyVariants.length > 0 || subjectVariants.length > 0) && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowVariants((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-bold text-status-warm hover:text-status-warm/80"
          >
            {showVariants ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <WandSparkles className="h-3 w-3" />
            A/B pool: {bodyVariants.length > 0 ? `${bodyVariants.length + 1} bodies` : ""}
            {bodyVariants.length > 0 && subjectVariants.length > 0 ? " · " : ""}
            {subjectVariants.length > 0 ? `${subjectVariants.length + 1} subjects` : ""}
            <span className="font-normal text-fg-dim">(one is picked per lead at send time)</span>
          </button>
          {showVariants && (
            <div className="mt-2 space-y-2 border-l-2 border-status-warm/30 pl-3">
              {subjectVariants.map((sv, i) => (
                <CopyBlock key={`sv-${i}`} label={`Subject variant ${i + 2}`} text={sv} sample={sample} />
              ))}
              {bodyVariants.map((bv, i) => (
                <CopyBlock key={`bv-${i}`} label={`Body variant ${i + 2}`} text={bv} sample={sample} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SequenceCard({ row, sample, query, pool }: { row: TemplatesViewRow; sample: boolean; query: string; pool: PoolTemplate[] }) {
  const schedule = useMemo(() => cumulativeSchedule(row.steps || []), [row.steps]);
  const big = schedule.length > 6;
  const [open, setOpen] = useState(!big);
  const emails = schedule.filter((s) => s.step.channel === "email").length;

  return (
    <section className="rounded-xl border border-bg-border bg-bg-panel">
      <header className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-2 text-left"
        >
          {open ? <ChevronDown className="h-4 w-4 text-fg-dim" /> : <ChevronRight className="h-4 w-4 text-fg-dim" />}
          <span className="text-sm font-bold text-fg">{row.name}</span>
        </button>
        <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[10px] font-bold text-accent">
          stage → {triggerStage(row)}
        </span>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
          row.enabled
            ? "border-status-engaged/40 bg-status-engaged/10 text-status-engaged"
            : "border-bg-border bg-bg-elev text-fg-dim"
        }`}>
          {row.enabled ? "Live" : "Paused"}
        </span>
        <span className="text-[11px] text-fg-dim">
          {schedule.length} steps · {emails} email / {schedule.length - emails} SMS
          {row.email_class ? ` · ${row.email_class}` : ""}
        </span>
        <Link
          href={`/sequences/${row.id}/edit`}
          className="ml-auto inline-flex items-center gap-1 text-xs font-bold text-accent hover:text-accent-bright"
        >
          <Edit3 className="h-3 w-3" />
          Edit templates
        </Link>
      </header>
      {open && (
        <div className="space-y-2 border-t border-bg-border px-4 py-3">
          {row.description && <p className="text-xs text-fg-muted">{row.description}</p>}
          {schedule.length === 0 && <p className="text-xs text-fg-dim">No steps defined.</p>}
          {schedule
            .filter((s) => {
              if (!query) return true;
              const hay = `${s.step.subject || ""}\n${s.step.body}\n${(s.step.body_variants || []).join("\n")}\n${(s.step.subject_variants || []).join("\n")}`.toLowerCase();
              return hay.includes(query);
            })
            .map((s) => (
              <StepCard
                key={s.index}
                scheduled={s}
                sample={sample}
                sequenceId={row.id}
                steps={row.steps}
                brand={rowBrand(row)}
                stage={triggerStage(row)}
                pool={pool}
              />
            ))}
        </div>
      )}
    </section>
  );
}

export function SequenceTemplatesView({ rows, pool = [] }: { rows: TemplatesViewRow[]; pool?: PoolTemplate[] }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sample, setSample] = useState(false);
  const query = searchQuery.trim().toLowerCase();

  const filtered = useMemo(
    () =>
      rows.filter((r) => !query || sequenceSearchText(r.name, r.steps || []).includes(query)),
    [rows, query],
  );

  const totals = useMemo(() => {
    let steps = 0;
    let emails = 0;
    for (const r of rows) {
      steps += (r.steps || []).length;
      emails += (r.steps || []).filter((s) => s.channel === "email").length;
    }
    return { sequences: rows.length, steps, emails };
  }, [rows]);

  return (
    // resetKey={rows} — a NEW object on every server re-render, which is the
    // real signal that a saved swap is now reflected in props. Until it lands,
    // every interchange on the page stays locked so a second swap cannot PATCH
    // the stale array and revert the first.
    <InterchangeLockProvider resetKey={rows}>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-dim" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search all drip templates"
            placeholder="Search every subject and body across all campaigns..."
            className="w-full rounded-lg border border-bg-border bg-bg-deep py-2 pl-9 pr-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-dim focus:border-accent/50"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            checked={sample}
            onChange={(e) => setSample(e.target.checked)}
            className="rounded accent-accent"
          />
          Render with sample lead
        </label>
        <span className="text-[11px] text-fg-dim">
          {totals.sequences} campaigns · {totals.steps} templates ({totals.emails} email)
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-8 text-center text-sm text-fg-muted">
          No templates match that search.
        </div>
      ) : (
        filtered.map((row) => (
          <SequenceCard key={row.id} row={row} sample={sample} query={query} pool={pool} />
        ))
      )}
    </div>
    </InterchangeLockProvider>
  );
}
