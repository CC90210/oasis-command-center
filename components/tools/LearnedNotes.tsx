/**
 * components/tools/LearnedNotes.tsx - what "Learn from a link" has learned so far.
 *
 * The Agent training page was one card and nothing else, so after pressing Learn
 * there was nowhere to see the result. The notes are rows in marketing_corpus,
 * the same rows Content > Training already lists; this puts them on the page
 * that writes them.
 *
 * PER AGENT (2026-10-15). Each note trains one agent, or all of them (lib/training/trains.ts), and that
 * agent reads its newest notes before it answers (lib/os/training-notes.ts, from
 * lib/os/department-agent.ts). The page shows one agent at a time: the list is that agent's notes, each
 * row says who it trains, and the footer says exactly what the agent does with them.
 *
 * Presentational and server-safe: the page does the reads and passes them in, so
 * a failed read arrives as `degraded` and says so, never as "nothing yet".
 */
import type { CorpusItems, CorpusStats } from "@/lib/founders/marketing-queries";
import { ingestStateCopy, type IngestState } from "@/lib/founders/ingest-core";
import { TRAINING_NOTES_MAX, notesTrain, trainsLabel, type Trains } from "@/lib/training/trains";
import type { DepartmentKey } from "@/lib/os/types";
import type { NoteMemory } from "@/lib/os/training-notes";
import { RecallTest } from "@/components/tools/RecallTest";

const SHOWN = 15;
export const TRAINING_HREF = "/founders/marketing/train";
/**
 * How many notes the page reads for the list, on every tab (the All read and an
 * agent's). When a read comes back this full there may be more, so the count
 * says "N+" rather than presenting the cap as a total (audit, 2026-10-26: an
 * agent tab read 40 and said "Showing the newest 15 of 40" whatever it held).
 */
export const LEARNED_NOTES_READ = 200;

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

/** The rows one agent reads (its own, the ones for every agent, and for Marketing the older ones); every row for "all agents". */
export function rowsFor(rows: CorpusItems["rows"], agent: DepartmentKey | null): CorpusItems["rows"] {
  return agent ? rows.filter((r) => notesTrain(r.trains, agent)) : rows;
}

export function LearnedNotes({
  stats,
  items,
  agent = null,
  memory = {},
}: {
  stats: CorpusStats;
  items: CorpusItems;
  agent?: DepartmentKey | null;
  /** What each learned note holds and what it is picked for (lib/os/training-notes.ts noteMemoryFor). */
  memory?: Record<string, NoteMemory>;
}) {
  const rows = rowsFor(items.rows, agent);
  const who = agent ? trainsLabel(agent) : null;
  // The All tab knows its true total (stats counts every row); an agent's tab
  // knows only what its read returned, and a full read may have stopped short.
  const readFull = items.rows.length >= LEARNED_NOTES_READ;
  const agentCount = readFull ? `${rows.length}+` : `${rows.length}`;
  const total = who ? agentCount : `${stats.total}`;
  // The footer says the list is partial whenever it is: more rows than shown, or
  // a full read that may have stopped short of older notes (off Turso, an
  // agent's tab filters the All read, so 15 matches can still be "15+").
  const partial = rows.length > SHOWN || (who !== null && readFull) || (who === null && stats.total > rows.length);
  return (
    <section aria-labelledby="learned-notes-title" className="space-y-3" data-testid="learned-notes">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="learned-notes-title" className="text-sm font-semibold text-fg">
          {who ? `What the ${who} agent has learned` : "What your agents have learned"}
        </h2>
        {!stats.degraded && stats.total > 0 && (
          <span className="text-xs text-fg-muted">{who && !items.degraded ? `${agentCount} for ${who} · ` : ""}{learnedSummary(stats)} in all</span>
        )}
      </div>

      {stats.degraded ? (
        <p className="rounded-xl border border-bg-border bg-bg-panel p-4 text-sm text-fg-muted">
          Couldn&apos;t read the training material, so this is not an empty list. Nothing has been lost; try again in a minute.
        </p>
      ) : items.degraded ? (
        <p className="rounded-xl border border-bg-border bg-bg-panel p-4 text-sm text-fg-muted">
          The counts above are current, but the list did not load. Nothing has been lost; try again in a minute.
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-bg-border bg-bg-panel p-4 text-sm text-fg-muted">
          {who
            ? `Nothing has been taught to the ${who} agent yet. Paste a link above, with ${who} chosen, and it appears here once it has been read.`
            : "Nothing learned yet. Paste a link above and it appears here once it has been read."}
        </p>
      ) : (
        <ul className="divide-y divide-bg-border rounded-xl border border-bg-border bg-bg-panel">
          {rows.slice(0, SHOWN).map((row) => {
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
                  <span>· Trains: {trainsLabel(row.trains as Trains | null)}</span>
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
                {memory[row.id] && <NoteMemoryCard row={row} memory={memory[row.id]} agent={agent} who={who} />}
              </li>
            );
          })}
        </ul>
      )}

      {partial && rows.length > 0 && !items.degraded && !stats.degraded && (
        <p className="text-xs text-fg-dim">
          Showing the newest {Math.min(SHOWN, rows.length)} of {total}.{" "}
          {/* Training lists every agent's notes, newest first, and says how many it shows; it is not this tab's full list. */}
          <a href={TRAINING_HREF} className="underline underline-offset-2 hover:text-fg-muted">
            {who ? "Every agent's notes are on Training" : "Open Training"}
          </a>
        </p>
      )}

      <p className="text-xs leading-5 text-fg-dim">
        Each link is read and saved as a style note for the agent you chose (also listed on{" "}
        <a href={TRAINING_HREF} className="underline underline-offset-2 hover:text-fg-muted">
          Content &gt; Training
        </a>
        ). Before it answers, an agent reads up to {TRAINING_NOTES_MAX} notes as examples of how to write: the ones that best match what it is asked, then its newest: openings, techniques and tone. They never change what it is allowed to do.
      </p>
    </section>
  );
}

/**
 * Under a learned note: what was extracted from the link, the words a question needs for the agent to
 * pick it, and (on one agent's tab) the recall test that proves it.
 */
function NoteMemoryCard({
  row,
  memory,
  agent,
  who,
}: {
  row: CorpusItems["rows"][number];
  memory: NoteMemory;
  agent: DepartmentKey | null;
  who: string | null;
}) {
  const learned = [memory.hook && `Opening: ${memory.hook}`, memory.steal && `Technique: ${memory.steal}`, memory.tone && `Tone: ${memory.tone}`].filter(Boolean) as string[];
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-bg-border bg-bg-deep/30 px-3 py-2">
      {learned.length > 0 && (
        <ul className="space-y-0.5 text-xs text-fg-muted">
          {learned.map((line) => (
            <li key={line} className="line-clamp-2">
              {line}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-fg-dim">
        {memory.topTerms.length > 0
          ? `Picked when a question mentions: ${memory.topTerms.join(", ")}.`
          : "Picked only when nothing else matches the question."}
      </p>
      {agent && who && (
        <RecallTest
          noteId={row.id}
          department={agent}
          agentLabel={who}
          title={row.title || row.source_url || "this note"}
          topTerms={memory.topTerms}
        />
      )}
    </div>
  );
}
