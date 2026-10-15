/**
 * components/automations/guided/SummaryRail.tsx - the choices so far, always in view.
 *
 * Desktop: a column beside the step. Phone: the same content in a closed disclosure above the step, so
 * the page never grows a second column or scrolls sideways. Both copies share one body; only one of them
 * is ever displayed (the other is display:none, which a screen reader skips).
 */
import { summaryRows, type Draft } from "@/lib/automations/guided/view";
import { TAP } from "./ui";

function SummaryBody({ draft }: { draft: Draft }) {
  const rows = summaryRows(draft);
  return (
    <dl className="space-y-3">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-xs font-medium text-fg-dim">{row.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-fg">
            {row.value ?? <span className="text-fg-dim">Not chosen yet</span>}
            {row.lines.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs leading-5 text-fg-muted">
                {row.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SummaryRail({ draft }: { draft: Draft }) {
  const rows = summaryRows(draft);
  const chosen = rows.filter((r) => r.value !== null).length;
  return (
    <aside aria-label="Your choices so far" className="min-w-0">
      <details className="rounded-lg border border-hairline bg-bg-deep lg:hidden">
        <summary className={`flex ${TAP} cursor-pointer items-center justify-between gap-3 px-3 text-sm font-medium text-fg`}>
          <span>Your choices so far</span>
          <span className="text-xs font-normal text-fg-dim">
            {chosen} of {rows.length} chosen
          </span>
        </summary>
        <div className="border-t border-hairline p-3">
          <SummaryBody draft={draft} />
        </div>
      </details>
      <div className="hidden rounded-xl border border-hairline bg-bg-deep p-4 lg:sticky lg:top-4 lg:block">
        <p className="mb-3 text-sm font-semibold text-fg">Your choices so far</p>
        <SummaryBody draft={draft} />
      </div>
    </aside>
  );
}
