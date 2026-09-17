/**
 * `/training/roleplay/[scenario]` — one practice call.
 *
 * The scenario is resolved here and only its rep-visible half is handed to the
 * client. The temperament and the win condition stay on the server: a rep who
 * could read how the owner is written would be practising against a cheat
 * sheet, and the persona is what the route refuses to take from a client.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/Card";
import { RoleplayCall } from "@/components/training/RoleplayCall";
import { resolveSessionContext } from "@/lib/api-auth";
import { mayViewTraining } from "@/lib/training/access";
import { DISPOSITION_LABEL, scenarioById } from "@/lib/training/roleplay/scenarios";

export const dynamic = "force-dynamic";

export default async function RoleplayScenarioPage({
  params,
}: {
  params: Promise<{ scenario: string }>;
}) {
  const [session, { scenario: id }] = await Promise.all([resolveSessionContext(), params]);
  if (!session.ok) redirect(`/auth/login?next=/training/roleplay/${id}`);
  if (!mayViewTraining(session)) redirect("/");

  const scenario = scenarioById(id);
  if (!scenario) notFound();

  // Only what a rep would legitimately know before ringing. `temperament` and
  // `winsIf` are deliberately NOT sent: they are the answer sheet.
  const forClient = {
    id: scenario.id,
    business: scenario.business,
    trade: scenario.trade,
    visible: scenario.visible,
    disposition: scenario.disposition,
    temperament: "",
    opensWith: "",
    winsIf: "",
    difficulty: scenario.difficulty,
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <Link
        href="/training/roleplay"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-fg-muted transition hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" />
        Practice calls
      </Link>

      <PageHeader title={scenario.business} subtitle={DISPOSITION_LABEL[scenario.disposition]} />

      <RoleplayCall scenario={forClient} />
    </div>
  );
}
