/**
 * `/training/roleplay` — pick who you are calling.
 *
 * Every business here is invented. That is a data fence, not a content choice:
 * a role-play built on a real lead would put a real business into a model
 * prompt, and it trains worse, because a rep should practise a SITUATION they
 * will meet many times rather than burn one lead they could have called.
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Card, PageHeader } from "@/components/Card";
import { resolveSessionContext } from "@/lib/api-auth";
import { mayViewTraining } from "@/lib/training/access";
import { DISPOSITION_LABEL, SCENARIOS } from "@/lib/training/roleplay/scenarios";

export const dynamic = "force-dynamic";

const DIFFICULTY_LABEL: Record<string, string> = {
  starter: "Start here",
  harder: "Harder",
  hardest: "Hardest",
};

export default async function RoleplayIndexPage() {
  const session = await resolveSessionContext();
  if (!session.ok) redirect("/auth/login?next=/training/roleplay");
  if (!mayViewTraining(session)) redirect("/");

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
        title="Practice calls"
        subtitle="Ring an owner who pushes back. Nothing is scored and nobody sees it."
      />

      <Card title="How this works">
        <p className="text-sm leading-relaxed text-fg-muted">
          You get a business, what you would be able to see about it before ringing, and an owner who behaves
          like one. They will not make it easy, and they will end the call if you give them a reason to. When
          you are done you can ask how it went.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          Say your line out loud before you type it. The typing is a record of what you said, not the practice.
        </p>
      </Card>

      <ul className="mt-4 space-y-3">
        {SCENARIOS.map((s) => (
          <li key={s.id}>
            <Link
              href={`/training/roleplay/${s.id}`}
              className="block rounded-lg border border-bg-border bg-bg-raised/60 p-4 transition hover:border-accent/50"
            >
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-fg">{s.business}</p>
                  <p className="mt-0.5 text-xs text-fg-muted">{s.trade}</p>
                </div>
                <span className="rounded-full border border-bg-border px-2 py-0.5 text-[11px] text-fg-dim">
                  {DIFFICULTY_LABEL[s.difficulty] ?? s.difficulty}
                </span>
              </div>
              <p className="mt-2 text-xs text-fg-dim">{DISPOSITION_LABEL[s.disposition]}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
