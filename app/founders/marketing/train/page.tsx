/**
 * /founders/marketing/train — teach Maven.
 *
 * Adon, 2026-08-02: "The dashboard is really just going to be putting your full
 * power in a dashboard and really making it seem as if I'm able to train you in
 * large quantities that will be automatically ingested by you over a reasonable
 * period of time. That's the majority of what this Marketing tab is going to be for."
 *
 * So this is the centre of the feature, not a utility page.
 */

import { notFound } from "next/navigation";
import { Card, PageHeader } from "@/components/Card";
import { safe } from "@/lib/api-helpers";
import { resolveFounder } from "@/lib/founders/gate";
import { getCorpusItems, getCorpusStats } from "@/lib/founders/marketing-queries";
import { ingestStateCopy, type IngestState } from "@/lib/founders/ingest-core";
import { TrainDropzone } from "@/components/founders/TrainDropzone";
import { MarketingEmpty } from "@/components/founders/marketing-shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Train · Marketing · OASIS" };

const TONE: Record<string, string> = {
  pending: "#A8B5C2",
  active: "#7AE8F0",
  done: "#8CE8B0",
  bad: "#FFB4AC",
};

export default async function TrainPage() {
  const founder = await resolveFounder();
  if (!founder) notFound();

  const [stats, items] = await Promise.all([
    safe("marketing.corpus.stats", getCorpusStats(founder.tenantId), {
      total: 0, queued: 0, extracting: 0, indexed: 0, failed: 0,
      exemplars: 0, counter_examples: 0,
    }),
    safe("marketing.corpus.items", getCorpusItems(founder.tenantId, 40), []),
  ]);

  const pending = stats.queued + stats.extracting;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Train Maven"
        subtitle="Drop in what good looks like, and what bad looks like. She learns from both."
      />

      <Card
        title="Feed her something"
        subtitle="A reel, a YouTube video, a repo, an article. Drag it in or paste a batch."
      >
        <TrainDropzone />
      </Card>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MiniStat label="Learned" value={stats.indexed} accent />
        <MiniStat label="In progress" value={pending} hint={pending ? "processing in the background" : undefined} />
        <MiniStat label="Do more of this" value={stats.exemplars} />
        <MiniStat label="Never again" value={stats.counter_examples} hint="worth more than exemplars" />
      </section>

      <section>
        <div className="mb-3 flex items-baseline justify-between gap-4 px-1">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
            The corpus
          </span>
          {stats.total > 0 && (
            <span className="text-xs text-fg-dim">{stats.total} item{stats.total === 1 ? "" : "s"}</span>
          )}
        </div>

        {items.length === 0 ? (
          <MarketingEmpty
            headline="Nothing in the corpus yet"
            detail="Every link you drop above becomes something Maven can draw on when she writes. Reference reels teach form; your rejections teach the boundary."
            hint="Ingestion is asynchronous — drop 40 links, walk away, come back to them processed."
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
                        {it.label === "counter_example" && <span style={{ color: "#F5D48A" }}>· never again</span>}
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
      </section>
    </div>
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
