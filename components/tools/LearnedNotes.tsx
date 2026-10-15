/**
 * components/tools/LearnedNotes.tsx - what "Learn from a link" has learned so far.
 *
 * The Agent training page was one card and nothing else, so after pressing Learn
 * there was nowhere to see the result. The notes are rows in marketing_corpus,
 * the same rows Content > Training already lists; this puts them on the page
 * that writes them.
 *
 * HONEST ABOUT WHAT HAPPENS NEXT. Today the notes are stored and listed (here and
 * on Training). No agent reads them into its writing yet: per-agent training is
 * the next project (docs/superpowers/specs/2026-10-14-money-automations-agent-
 * training-design.md, section 5). Calling a list of saved links "training" with
 * no consumer would be the same overclaim the design doc names, so the footer
 * says exactly that instead.
 *
 * Presentational and server-safe: the page does the reads and passes them in, so
 * a failed read arrives as `degraded` and says so, never as "nothing yet".
 */
import type { CorpusItems, CorpusStats } from "@/lib/founders/marketing-queries";
import { ingestStateCopy, type IngestState } from "@/lib/founders/ingest-core";

const SHOWN = 15;
export const TRAINING_HREF = "/founders/marketing/train";

/** "Oct 14". Stable for a given instant, so server and client agree. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "America/Toronto" });
}

/** The one line a learned row reads as: its intent, in the words the Learn form used. */
export function intentLabel(label: string): string | null {
  if (label === "exemplar") return "Do more of this";
  if (label === "counter_example") return "Never do this";
  return null;
}

export function learnedSummary(stats: CorpusStats): string {
  const waiting = stats.queued + stats.extracting;
  const parts = [`${stats.indexed} learned`];
  if (waiting > 0) parts.push(`${waiting} being read`);
  if (stats.failed > 0) parts.push(`${stats.failed} couldn't be read`);
  return parts.join(" · ");
}

export function LearnedNotes({ stats, items }: { stats: CorpusStats; items: CorpusItems }) {
  return (
    <section aria-labelledby="learned-notes-title" className="space-y-3" data-testid="learned-notes">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="learned-notes-title" className="text-sm font-semibold text-fg">
          What it has learned
        </h2>
        {!stats.degraded && stats.total > 0 && <span className="text-xs text-fg-muted">{learnedSummary(stats)}</span>}
      </div>

      {stats.degraded ? (
        <p className="rounded-xl border border-bg-border bg-bg-panel p-4 text-sm text-fg-muted">
          Couldn&apos;t read the training material, so this is not an empty list. Nothing has been lost; try again in a minute.
        </p>
      ) : items.degraded ? (
        <p className="rounded-xl border border-bg-border bg-bg-panel p-4 text-sm text-fg-muted">
          The counts above are current, but the list did not load. Nothing has been lost; try again in a minute.
        </p>
      ) : items.rows.length === 0 ? (
        <p className="rounded-xl border border-bg-border bg-bg-panel p-4 text-sm text-fg-muted">
          Nothing learned yet. Paste a link above and it appears here once it has been read.
        </p>
      ) : (
        <ul className="divide-y divide-bg-border rounded-xl border border-bg-border bg-bg-panel">
          {items.rows.slice(0, SHOWN).map((row) => {
            const state = ingestStateCopy((row.state as IngestState) || "queued");
            const intent = intentLabel(row.label);
            const when = shortDate(row.created_at);
            return (
              <li key={row.id} className="space-y-1 px-4 py-3">
                <div className="truncate text-sm text-fg" title={row.title || row.source_url || undefined}>
                  {row.title || row.source_url || "Untitled link"}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-dim">
                  <span className={state.tone === "bad" ? "text-status-warm" : "text-fg-muted"}>{state.label}</span>
                  {intent && <span>· {intent}</span>}
                  {when && <span>· {when}</span>}
                  {row.source_url && (
                    <a
                      href={row.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 max-w-full truncate hover:text-fg-muted"
                    >
                      {row.source_url.replace(/^https?:\/\/(www\.)?/, "")}
                    </a>
                  )}
                </div>
                {state.tone === "bad" && row.last_error && (
                  <div className="text-[11px] text-status-warm">{row.last_error.slice(0, 160)}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {items.rows.length > SHOWN && (
        <p className="text-xs text-fg-dim">
          Showing the newest {SHOWN} of {stats.total}.{" "}
          <a href={TRAINING_HREF} className="underline underline-offset-2 hover:text-fg-muted">
            See all on Training
          </a>
        </p>
      )}

      <p className="text-xs leading-5 text-fg-dim">
        Each link is read in the background and saved as a style note, listed here and on{" "}
        <a href={TRAINING_HREF} className="underline underline-offset-2 hover:text-fg-muted">
          Content &gt; Training
        </a>
        . No agent reads these notes into its writing yet; training a specific agent on them is the next step.
      </p>
    </section>
  );
}
