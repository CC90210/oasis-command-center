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

const CLIENT_CATEGORIES: PromptCategory[] = [
  "client_setup",
  "client_optimization",
  "client_handoff",
];

export default function PromptsLibraryPage() {
  // Operator section: prompts tagged "operator" + the "shared" ones that
  // are universally useful (override syntax, health checks, end-of-day).
  const operatorPrompts = PROMPTS_LIBRARY.filter((p) => p.audience === "operator");
  // Client deployment section: prompts tagged "client" + the shared ones
  // (operator runs them when SSH'd into a client's machine).
  const clientPrompts = PROMPTS_LIBRARY.filter((p) => p.audience === "client");
  const sharedPrompts = PROMPTS_LIBRARY.filter((p) => p.audience === "shared");

  // Total count for the header tag — the filter component computes
  // filtered counts client-side, but the page header shows the full
  // library size so the operator knows the scope.
  const totalPrompts = PROMPTS_LIBRARY.length;

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
            {totalPrompts} prompts · {operatorPrompts.length} operator · {clientPrompts.length} client · {sharedPrompts.length} universal
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

      {/* Client-side filter — single input narrows the whole library
          (operator + client sections) by title, description, tag, or
          category label. Lives in a small client island so the SSR
          page stays static and the filter UX is instant. */}
      <PromptsLibraryFilter
        prompts={PROMPTS_LIBRARY}
        operatorCategories={OPERATOR_CATEGORIES}
        clientCategories={CLIENT_CATEGORIES}
        categoryDefs={PROMPT_CATEGORIES}
      />
    </div>
  );
}
