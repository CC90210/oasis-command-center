import { requirePlaybookReader } from "@/lib/playbook-access";
import { notFound } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, PageHeader, Tag } from "@/components/Card";
import { loadPlaybook, PlaybookNotFoundError, type PlaybookFile } from "@/lib/playbooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIENCE_TONE: Record<string, "accent" | "engaged" | "warm"> = {
  operator: "accent",
  client: "engaged",
  internal: "warm",
};

export default async function PlaybookSlugPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  // OASIS members only (lib/playbook-access.ts); everyone else gets the 404.
  await requirePlaybookReader();
  const { slug } = await params;
  let file: PlaybookFile;
  try {
    file = loadPlaybook(slug);
  } catch (err) {
    // Only "no such playbook" is a 404. Anything else is a real failure and
    // propagates to the error boundary instead of posing as a missing page.
    if (err instanceof PlaybookNotFoundError) notFound();
    throw err;
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader
        title={file.title}
        subtitle={
          <span>
            <Link href="/playbook" className="text-fg-muted hover:text-accent underline-offset-2 hover:underline">
              Playbook index
            </Link>
            <span className="text-fg-dim"> · {file.updated ? `Updated ${file.updated}` : "Update date not recorded"}</span>
          </span>
        }
        action={<Tag tone={AUDIENCE_TONE[file.audience] ?? "accent"}>{file.audience}</Tag>}
      />
      <Card title="" subtitle="">
        <article className="prose prose-invert prose-headings:text-fg prose-p:text-fg-muted prose-strong:text-fg prose-a:text-accent max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{file.body}</ReactMarkdown>
        </article>
      </Card>
    </div>
  );
}
