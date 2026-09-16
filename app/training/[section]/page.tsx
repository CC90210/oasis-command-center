/**
 * `/training/[section]` — one section: what it promises, the lessons, and the
 * way into its drill.
 *
 * An unknown slug 404s rather than rendering an empty section. A page that
 * silently shows nothing for a typo looks identical to a section somebody
 * forgot to write.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Card, PageHeader } from "@/components/Card";
import { resolveSessionContext } from "@/lib/api-auth";
import { mayViewTraining } from "@/lib/training/access";
import { SECTIONS, sectionBySlug } from "@/lib/training/curriculum";
import { itemsForSection } from "@/lib/training/items";

export const dynamic = "force-dynamic";

export default async function TrainingSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const [session, { section: slug }] = await Promise.all([resolveSessionContext(), params]);
  if (!session.ok) redirect(`/auth/login?next=/training/${slug}`);
  if (!mayViewTraining(session)) redirect("/");

  const section = sectionBySlug(slug);
  if (!section) notFound();

  const items = itemsForSection(section.slug);
  const index = SECTIONS.findIndex((s) => s.slug === section.slug);
  const nextSection = SECTIONS[index + 1];

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <Link
        href="/training"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-fg-muted transition hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" />
        Training
      </Link>

      <PageHeader
        title={section.title}
        subtitle={section.promise}
        action={
          items.length > 0 ? (
            <Link
              href={`/training/${section.slug}/drill`}
              className="inline-block rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
            >
              Drill this ({items.length})
            </Link>
          ) : undefined
        }
      />

      <div className="space-y-4">
        {section.lessons.map((lesson) => (
          <Card key={lesson.id} title={lesson.heading}>
            {lesson.body.map((para, i) => (
              <p key={i} className="mb-3 text-sm leading-relaxed text-fg last:mb-0">
                {para}
              </p>
            ))}
            {lesson.lines && lesson.lines.length > 0 && (
              <div className="mt-4 space-y-2 border-l-2 border-accent/30 pl-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-accent">
                  Words you can actually use
                </p>
                {lesson.lines.map((line) => (
                  <p key={line} className="text-sm leading-relaxed text-fg-muted">
                    &ldquo;{line}&rdquo;
                  </p>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {items.length > 0 && (
          <Link
            href={`/training/${section.slug}/drill`}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
          >
            Drill this section
          </Link>
        )}
        {nextSection && (
          <Link
            href={`/training/${nextSection.slug}`}
            className="rounded-md border border-bg-border px-3 py-1.5 text-sm font-medium text-fg-muted transition hover:border-accent/50 hover:text-fg"
          >
            Next: {nextSection.title}
          </Link>
        )}
      </div>

      <p className="mt-6 text-xs text-fg-dim">Source: {section.source}.</p>
    </div>
  );
}
