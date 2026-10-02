/**
 * /founders/marketing/train - Training: what the marketing agent learns from.
 *
 * Adon, 2026-08-02: "The dashboard is really just going to be putting your full
 * power in a dashboard and really making it seem as if I'm able to train you in
 * large quantities that will be automatically ingested by you over a reasonable
 * period of time. That's the majority of what this Marketing tab is going to be for."
 *
 * PLAIN WORDS (2026-10-01). CC: "Training Corpus, which honestly I don't even
 * know what that does". The tab said "Train" and the page "Train Maven", a
 * persona name that is internal. The tab is Training now, and the page says
 * what the material is, what is in it and how to add to it. Every fact it
 * states is the pipeline's: the ingest route queues a link in marketing_corpus;
 * Business-Empire-Agent's ingest_training_link.py (the "Training Corpus Ingest"
 * job, every five minutes) reads it, writes a style note (hook, pacing, tone)
 * that the marketing agent draws on, and marks the row indexed ("Learned").
 *
 * TOOLS GO ABOVE THE TRAINING MATERIAL. The Train tools track adds a "Tools"
 * section (scripts as buttons) as its own <section>, between the header and
 * the training material section below; nothing renders there until then.
 *
 * The add box needs no data and renders with the frame; the counts and the
 * list are the only reads, so they stream in behind <Suspense>, and a failed
 * read says so instead of showing an empty list.
 */

import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Card, PageHeader } from "@/components/Card";
import { safe } from "@/lib/api-helpers";
import { resolveFounder } from "@/lib/founders/gate";
import { EMPTY_CORPUS_STATS, getCorpusItems, getCorpusStats } from "@/lib/founders/marketing-queries";
import { ingestStateCopy, type IngestState } from "@/lib/founders/ingest-core";
import { TrainDropzone } from "@/components/founders/TrainDropzone";
import { MarketingEmpty } from "@/components/founders/marketing-shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Training · Content · OASIS" };

const TONE: Record<string, string> = {
  pending: "#A8B5C2",
  active: "#7AE8F0",
  done: "#8CE8B0",
  bad: "#FFB4AC",
};

export default async function TrainPage() {
  const founder = await resolveFounder();
  if (!founder) notFound();

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Training"
        subtitle="What the marketing agent learns from, what is in it, and how to add to it."
      />

      {/* TOOLS: the Train tools track's own <section> goes here, above the
          training material. Nothing renders in this place until it lands. */}

      <section aria-labelledby="training-material" className="space-y-6">
        <div className="space-y-2 px-1">
          <h2 id="training-material" className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
            Training material
          </h2>
          <p className="max-w-3xl text-sm leading-6 text-fg-muted">
            The links you add here are what the marketing agent learns from: reels, TikToks, YouTube
            videos, GitHub repos and articles. Every five minutes a background job reads each new link
            and writes down its hook, pacing and tone as a style note, and the agent draws on those
            notes when it writes. A link shows Learned once its note is written.
          </p>
        </div>

        <Card
          title="Add examples"
          subtitle="Paste or drop links, several at once, then say what the batch is: Do more of this, Never do this, or Just context."
        >
          <TrainDropzone />
        </Card>

        <Suspense fallback={<TrainingLoading />}>
          <TrainingContents tenantId={founder.tenantId} />
        </Suspense>
      </section>
    </div>
  );
}

/** Shapes and one plain line while the counts load; never a number. */
function TrainingLoading() {
  return (
    <div className="space-y-3" aria-busy="true" aria-live="polite">
      <p className="px-1 text-sm text-fg-muted">Loading what is in it...</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 rounded-xl border border-bg-border bg-bg-elev/60 animate-pulse-slow" />
        ))}
      </div>
    </div>
  );
}

/** What is in it: the counts and the newest 40 links. The page's only reads. */
async function TrainingContents({ tenantId }: { tenantId: string }) {
  const [stats, items] = await Promise.all([
    safe("marketing.corpus.stats", getCorpusStats(tenantId), { ...EMPTY_CORPUS_STATS, degraded: true }),
    safe("marketing.corpus.items", getCorpusItems(tenantId, 40), []),
  ]);

  // A failed count is not an empty corpus: the list below would read "nothing
  // in it yet" about material that is there.
  if (stats.degraded) {
    return (
      <MarketingEmpty
        headline="Couldn't read the training material"
        detail="The counts and the list did not load, so this is not an empty list. Nothing has been lost. Refresh; if it persists the server log has the reason under [marketing:corpus.stats]."
      />
    );
  }

  const pending = stats.queued + stats.extracting;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MiniStat label="Learned" value={stats.indexed} accent />
        <MiniStat label="Being read" value={pending} hint={pending ? "in the background, every five minutes" : undefined} />
        <MiniStat label="Do more of this" value={stats.exemplars} />
        <MiniStat label="Never do this" value={stats.counter_examples} />
      </div>

      <div>
        <div className="mb-3 flex items-baseline justify-between gap-4 px-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
            What is in it
          </span>
          {stats.total > 0 && (
            <span className="text-xs text-fg-dim">{stats.total} item{stats.total === 1 ? "" : "s"}</span>
          )}
        </div>

        {items.length === 0 ? (
          <MarketingEmpty
            headline="Nothing in it yet"
            detail="Every link you add above becomes a style note the marketing agent can draw on. Examples to copy teach it the shape; examples to avoid teach it the limits."
            hint="Reading happens in the background: add 40 links, come back later, and they are done."
          />
        ) : (
          <Card noPadding>
            <ul className="divide-y divide-bg-border">
              {items.map((it) => {
                const c = ingestStateCopy((it.state as IngestState) || "queued");
                return (
                  <li key={it.id} className="flex items-center gap-4 px-5 py-3.5">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: TONE[c.tone] }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-fg">{it.title || it.source_url}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-fg-dim">
                        <span>{c.label}</span>
                        {it.label === "exemplar" && <span style={{ color: "#7AE8F0" }}>· do more of this</span>}
                        {it.label === "counter_example" && <span style={{ color: "#F5D48A" }}>· never do this</span>}
                        {it.source_url && (
                          <a
                            href={it.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate hover:text-fg-muted"
                          >
                            {it.source_url.replace(/^https?:\/\/(www\.)?/, "")}
                          </a>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

function MiniStat({
  label,
  value,
  hint,
  accent = false,
}: {
  label: string;
  value: number;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel px-4 py-3.5">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">{label}</div>
      <div
        className="mt-1.5 text-2xl font-bold tabular-nums"
        style={accent ? { color: "#1FE3F0" } : undefined}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] leading-snug text-fg-dim">{hint}</div>}
    </div>
  );
}
