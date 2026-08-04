import Link from "next/link";
import { Card, PageHeader, Tag } from "@/components/Card";
import {
  PROMPT_CATEGORIES,
  PROMPTS_LIBRARY,
  type PromptCategory,
} from "@/lib/prompts-library";
import { ArrowLeft } from "lucide-react";
import { PromptsLibraryFilter } from "@/components/playbook/PromptsLibraryFilter";

export const dynamic = "force-dynamic";

const OPERATOR_CATEGORIES: PromptCategory[] = [
  "ops_daily",
  "ops_review",
  "system_override",
  "system_health",
  "system_integration",
];

export default function PromptsLibraryPage() {
  // Client-deployment prompts are hidden from the operator page (2026-08-04
  // consolidation audit). They're the "SSH'd into a client's machine"
  // toolkit — 17 entries that pushed CC's own daily prompts below the fold
  // on the surface he opens every morning. The entries are NOT deleted:
  // they stay in PROMPTS_LIBRARY and a client deployment surfaces them
  // through its own tenant-scoped manifest view.
  const visiblePrompts = PROMPTS_LIBRARY.filter((p) => p.audience !== "client");

  // Operator section: prompts tagged "operator". Shared ones render in
  // their own "Universal prompts" block below (override syntax, health
  // checks, end-of-day, the prompt translator).
  const operatorPrompts = visiblePrompts.filter((p) => p.audience === "operator");
  const sharedPrompts = visiblePrompts.filter((p) => p.audience === "shared");

  // Header tag counts what's actually on this page — the filter component
  // computes filtered counts client-side, but the header shows the scope
  // the operator can see, not the full library size (which would promise
  // 17 prompts that never render here).
  const totalPrompts = visiblePrompts.length;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Breadcrumb — clicking lands back on the Playbook hub. Plain
          Next Link so the dashboard layout's sidebar stays mounted
          and the in-flight SSR cache is reused. */}
      <Link
        href="/playbook"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Playbook</span>
      </Link>

      <PageHeader
        title="Prompts Library"
        subtitle="Current, reusable system messages. Open one in chat or copy it unchanged for your IDE."
        action={
          <Tag tone="accent">
            {totalPrompts} prompts · {operatorPrompts.length} operator · {sharedPrompts.length} universal
          </Tag>
        }
      />

      <Card title="Operator override syntax" subtitle="When you need the agent to break out of its normal behavior, start with [OVERRIDE].">
        <div className="text-sm text-fg-muted leading-relaxed space-y-2">
          <p>
            Most messages route through the agent&apos;s standard reasoning. When you need to <strong className="text-fg">force a specific mode</strong> — pause crons, draft-only, private, voice-shift, correct a mistake — start the message with <code className="bg-bg-elev px-1.5 py-0.5 rounded text-accent">[OVERRIDE]</code> on its own line, then a context line, then the request.
          </p>
          <pre className="bg-bg-deep border border-bg-border rounded p-3 text-xs font-mono text-fg overflow-x-auto whitespace-pre">{`[OVERRIDE]
Context: pause autonomous agent activity for the next 24h.

Disable every cron in vercel.json by setting it to a date in the past...`}</pre>
          <p className="text-xs">
            The agent treats <code className="text-accent">[OVERRIDE]</code> messages as imperative + non-conversational. Foundational override prompts (badged below) are hard-coded and always available across both operator + client deployments.
          </p>
        </div>
      </Card>

      {/* Client-side filter — single input narrows the operator + universal
          sections by title, description, tag, or category label. Lives in a
          small client island so the SSR page stays static and the filter UX
          is instant. clientCategories is empty here: the client-deployment
          prompts are filtered out upstream, so the section never renders. */}
      <PromptsLibraryFilter
        prompts={visiblePrompts}
        operatorCategories={OPERATOR_CATEGORIES}
        clientCategories={[]}
        categoryDefs={PROMPT_CATEGORIES}
      />
    </div>
  );
}
