/**
 * TemplatePicker — "New teammate" starting points for owners and admins.
 *
 * Each template opens the existing builder (components/marketplace/
 * CustomAgentBuilder.tsx at /t/<slug>/marketplace/new) with `?template=<key>`,
 * and the builder opens prefilled from it (templates.ts templateDraft): the
 * name, category, summary, and this brief in its "Describe what this agent
 * should do" field. The card shows the brief so the owner can read it first.
 *
 * Server component. A plain list, not an icon grid.
 */

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { TEAMMATE_TEMPLATES } from "./templates";

export function TemplatePicker({ builderHref }: { builderHref: string }) {
  return (
    <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-bg-panel">
      {TEAMMATE_TEMPLATES.map((t) => (
        <li key={t.key} className="px-4 py-3">
          <details className="group">
            <summary className="flex cursor-pointer list-none items-start justify-between gap-3 [&::-webkit-details-marker]:hidden">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold text-fg">{t.name}</span>
                  <span className="text-xs text-fg-dim">{t.department}</span>
                </div>
                <p className="text-[13px] leading-5 text-fg-muted">{t.summary}</p>
              </div>
              <span className="shrink-0 pt-0.5 text-xs text-fg-dim group-open:hidden">Show brief</span>
              <span className="hidden shrink-0 pt-0.5 text-xs text-fg-dim group-open:inline">Hide brief</span>
            </summary>
            <div className="mt-3 space-y-2.5">
              <p className="text-xs leading-4 text-fg-dim">The builder opens with this description filled in:</p>
              <p className="rounded-lg border border-hairline bg-bg-deep px-3 py-2 text-[13px] leading-5 text-fg-muted">
                {t.brief}
              </p>
              <Link
                href={`${builderHref}?template=${encodeURIComponent(t.key)}`}
                prefetch={false}
                className="btn-secondary inline-flex items-center gap-1.5"
              >
                Open the builder
                <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              </Link>
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
