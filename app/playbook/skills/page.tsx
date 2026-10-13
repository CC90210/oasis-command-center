import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/Card";
import { PageFrame } from "@/components/os/PageFrame";
import { SkillsTab } from "@/components/playbook/skills/SkillsTab";
import { requirePlaybookFounder } from "@/lib/playbook-access";
import { resolveDocsViewer } from "@/lib/playbook/viewer";
import { skillsDb, skillsPageData } from "@/lib/skills/store";

export const dynamic = "force-dynamic";

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6 animate-fade-in">
      <Link href="/playbook" className="inline-flex min-h-11 items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-fg">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Playbook</span>
      </Link>
      <PageFrame title="Skills" subtitle="Every skill on your computer, what it adds to a prompt, and how often routing finds it. Review held label changes here.">
        {children}
      </PageFrame>
    </div>
  );
}

export default async function SkillsPage({ searchParams }: { searchParams: Promise<{ computer?: string }> }) {
  // OASIS's founders only (lib/playbook-access.ts FOUNDER_PLAYBOOK_PATHS), the same people the
  // founder-only /api/skills admin routes serve; everyone else gets the 404.
  await requirePlaybookFounder();
  const viewer = await resolveDocsViewer();
  if (!viewer.ok) notFound();
  const db = skillsDb();
  if (!db) return <Frame><EmptyState message="Skills storage is not ready on this deployment." /></Frame>;
  const { computer: asked } = await searchParams;
  const data = await skillsPageData(db, viewer.userId, asked);
  if (!data.computer || !data.lib) {
    return <Frame><EmptyState message="No computer is registered yet. Register one, and its first check-in fills this page." /></Frame>;
  }
  return (
    <Frame>
      <SkillsTab lib={data.lib} computer={data.computer} computers={data.computers} changes={data.changes} nowIso={new Date().toISOString()} />
    </Frame>
  );
}
