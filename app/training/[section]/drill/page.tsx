/**
 * `/training/[section]/drill` — the drill for one section.
 *
 * The drill itself is built client-side from the curriculum, which is static
 * data, so there is nothing to fetch. This page exists to prove permission and
 * resolve the slug before any of it renders.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/Card";
import { DrillRunner } from "@/components/training/DrillRunner";
import { resolveSessionContext } from "@/lib/api-auth";
import { mayViewTraining } from "@/lib/training/access";
import { sectionBySlug } from "@/lib/training/curriculum";

export const dynamic = "force-dynamic";

export default async function TrainingDrillPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const [session, { section: slug }] = await Promise.all([resolveSessionContext(), params]);
  if (!session.ok) redirect(`/auth/login?next=/training/${slug}/drill`);
  if (!mayViewTraining(session)) redirect("/");

  const section = sectionBySlug(slug);
  if (!section) notFound();

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <Link
        href={`/training/${section.slug}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-fg-muted transition hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" />
        {section.title}
      </Link>

      <PageHeader title="Drill" subtitle={section.promise} />

      <DrillRunner sectionSlug={section.slug} sectionTitle={section.title} />
    </div>
  );
}
