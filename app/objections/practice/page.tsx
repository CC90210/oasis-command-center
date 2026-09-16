/**
 * `/objections/practice` — the trainer a rep drills on.
 *
 * READS THE LIVE CATALOG, approved rows only, through the same
 * `fetchApprovedCatalog` the battle card uses. That is deliberate: a trainer
 * built on its own copy of the objections starts drifting the day somebody
 * edits one, and a rep would be practising sentences the product no longer
 * serves. One source, so training and the live card cannot disagree.
 *
 * An objection with no approved answer is dropped rather than shown, because
 * the two drills that reveal an answer would have nothing to reveal. That is
 * the same rule the console applies, and it is why `/objections` warns when an
 * objection has none.
 */

import { redirect } from "next/navigation";

import { PageHeader } from "@/components/Card";
import { PracticeTrainer } from "@/components/objections/PracticeTrainer";
import { resolveSessionContext } from "@/lib/api-auth";
import { mayViewObjectionLibrary } from "@/lib/web-leads/objections/admin-access";
import { fetchApprovedCatalog } from "@/lib/web-leads/objections/catalog";
import { isObjectionPosture } from "@/lib/web-leads/objections/types";
import type { PracticeObjection } from "@/lib/web-leads/objections/practice";

export const dynamic = "force-dynamic";

export default async function PracticePage() {
  const session = await resolveSessionContext();
  if (!session.ok) redirect("/auth/login?next=/objections/practice");
  if (!mayViewObjectionLibrary(session)) redirect("/");

  let pool: PracticeObjection[] = [];
  let readError: string | null = null;
  try {
    const catalog = await fetchApprovedCatalog();
    pool = catalog.flatMap((o) => {
      // The default is the one a rep is shown first on the card, so it is the
      // one to practise against. Falling back to the first approved answer
      // covers an objection whose default was retired without a replacement
      // being promoted.
      const answer = o.answers.find((a) => a.isDefault) ?? o.answers[0];
      if (!answer || !isObjectionPosture(answer.posture)) return [];
      return [
        {
          slug: o.slug,
          says: o.says,
          meaning: o.meaning,
          prevent: o.prevent,
          family: o.family,
          posture: answer.posture,
          answer: answer.body,
        },
      ];
    });
  } catch (err) {
    readError = err instanceof Error ? err.message : "unknown";
    console.error("[objections/practice] catalog read failed", readError);
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Practice"
        subtitle={
          readError
            ? "The objections could not be loaded, so there is nothing to drill right now."
            : "Drill the objections you actually hear. Nobody sees your answers."
        }
      />
      <PracticeTrainer pool={pool} readError={readError} />
    </div>
  );
}
