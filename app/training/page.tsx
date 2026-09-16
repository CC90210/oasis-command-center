/**
 * `/training` — the hub.
 *
 * Eight sections in the order a call happens, each showing whether this rep has
 * finished it. Progress is read server-side so the page is right on first
 * paint rather than flashing empty and filling in.
 *
 * A read failure renders an explicit message rather than an empty hub. Those
 * two states look identical otherwise, and one of them is a lie.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, PageHeader } from "@/components/Card";
import { resolveSessionContext } from "@/lib/api-auth";
import { mayViewTraining, repIdFor } from "@/lib/training/access";
import { SECTIONS } from "@/lib/training/curriculum";
import { ITEMS } from "@/lib/training/items";
import { fetchCompletions, fetchProgress } from "@/lib/training/progress";

export const dynamic = "force-dynamic";

export default async function TrainingPage() {
  const session = await resolveSessionContext();
  if (!session.ok) redirect("/auth/login?next=/training");
  if (!mayViewTraining(session)) redirect("/");

  const repUserId = repIdFor(session);

  let completedSlugs = new Set<string>();
  let rightBySection = new Map<string, number>();
  let readError: string | null = null;

  if (repUserId) {
    try {
      const [progress, completions] = await Promise.all([
        fetchProgress(repUserId),
        fetchCompletions(repUserId),
      ]);
      completedSlugs = new Set(completions.map((c) => c.sectionSlug));
      rightBySection = progress.reduce((m, p) => {
        if (p.rightCount > 0) m.set(p.sectionSlug, (m.get(p.sectionSlug) ?? 0) + 1);
        return m;
      }, new Map<string, number>());
    } catch (err) {
      readError = err instanceof Error ? err.message : "unknown";
      console.error("[training] progress read failed", readError);
    }
  }

  const done = completedSlugs.size;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Training"
        subtitle={
          readError
            ? "Your progress could not be read, so the marks below are not the real state."
            : `Eight sections, in the order a call actually happens. ${done} of ${SECTIONS.length} finished.`
        }
      />

      <Card
        title="Start here"
        subtitle="You are not memorising scripts. You are learning to say it in your own words."
      >
        <p className="text-sm leading-relaxed text-fg-muted">
          Work through the sections in order the first time. Each one tells you what you will be able to do,
          explains it, and then drills you on the parts that have a right answer. The drills cover every item
          rather than a sample, because the ones you would skip are the ones you need.
        </p>
      </Card>

      <ul className="mt-4 space-y-3">
        {SECTIONS.map((section, i) => {
          const itemCount = ITEMS.filter((it) => it.section === section.slug).length;
          const finished = completedSlugs.has(section.slug);
          const known = rightBySection.get(section.slug) ?? 0;
          return (
            <li key={section.slug}>
              <Link
                href={`/training/${section.slug}`}
                className="block rounded-lg border border-bg-border bg-bg-raised/60 p-4 transition hover:border-accent/50"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <span className="mt-0.5 font-mono text-xs text-fg-dim">{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-fg">{section.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-fg-muted">{section.promise}</p>
                  </div>
                  {finished && (
                    <span className="rounded-full border border-accent/40 px-2 py-0.5 text-[11px] font-medium text-accent">
                      Finished
                    </span>
                  )}
                </div>
                <p className="mt-2 pl-8 text-[11px] text-fg-dim">
                  {section.lessons.length} to read
                  {itemCount > 0 ? ` · ${itemCount} to drill` : " · nothing to drill yet"}
                  {known > 0 ? ` · ${known} you have got right` : ""}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="mt-6">
        <Card title="Where the objection work lives" subtitle="Section 6 uses it, and it is a tab of its own.">
          <p className="text-sm leading-relaxed text-fg-muted">
            The fifteen objections, what each one really means, and the practice trainer are under{" "}
            <Link href="/objections" className="text-accent underline">
              Objections
            </Link>
            . Everything there is approved before a rep sees it.
          </p>
        </Card>
      </div>
    </div>
  );
}
