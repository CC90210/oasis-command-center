import { requirePlaybookReader } from "@/lib/playbook-access";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card, PageHeader, Tag } from "@/components/Card";
import { ArrowLeft } from "lucide-react";
import {
  SECURITY_MODEL_VERIFIED,
  SECURITY_SECTIONS,
  SECURITY_SUMMARY,
  SECURITY_VERIFY_COMMANDS,
} from "@/lib/playbook/security-model";

export const dynamic = "force-dynamic";

/**
 * /playbook/security - the security model an operator may repeat to a client.
 *
 * Rendered from lib/playbook/security-model.ts, the same source the Business
 * documentation hub's "Security model" document copies and downloads, so the
 * two cannot disagree. Rewritten 2026-09-30: the previous page described the
 * retired stack (per-row database policies, a key on the old host, commands
 * that no longer run). tests/playbook-copy-drift.test.ts keeps those claims
 * out of every Playbook page and markdown file.
 */
export default async function SecurityPage() {
  // OASIS members only (lib/playbook-access.ts); everyone else gets the 404.
  await requirePlaybookReader();
  return (
    <div className="space-y-6 animate-fade-in">
      <Link
        href="/playbook"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-accent transition-colors"
      >
        <ArrowLeft size={14} /> Playbook
      </Link>

      <PageHeader
        title="Security model"
        subtitle="How workspaces are kept apart, how secrets are stored, and how the desktop bridge authenticates. What you may tell a client, and what you may not."
        action={<Tag tone="accent">verified {SECURITY_MODEL_VERIFIED}</Tag>}
      />

      <Card title="The one-paragraph version" subtitle="Read this if you have 30 seconds.">
        <p className="text-sm text-fg-muted leading-relaxed">{SECURITY_SUMMARY}</p>
      </Card>

      {SECURITY_SECTIONS.map((section) => (
        <Card key={section.key} title={section.title} subtitle={section.subtitle}>
          <div className="prose prose-invert prose-sm max-w-none prose-p:text-fg-muted prose-li:text-fg-muted prose-strong:text-fg prose-code:text-accent">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.body}</ReactMarkdown>
          </div>
        </Card>
      ))}

      <Card title="Verify it yourself" subtitle="Read-only checks against live state and the code.">
        <pre className="bg-bg-deep border border-bg-border rounded p-3 text-xs font-mono text-fg overflow-x-auto whitespace-pre">{SECURITY_VERIFY_COMMANDS}</pre>
        <p className="text-xs text-fg-dim pt-3">
          The same document, with Copy and Download, is in{" "}
          <Link href="/playbook/business/security-model" className="text-accent hover:text-accent-bright">
            Business documentation
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
