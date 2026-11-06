"use client";

import Link from "next/link";
import {
  Sparkles, Target, Mail, FileText, TrendingUp, Activity,
  Users, DollarSign, Phone, Calendar, ArrowRight,
} from "lucide-react";
import type { QuickAction } from "@/lib/quick-actions";
import { getAgentInfo } from "@/lib/agents";
import { askDepartment, departmentForAgent, departmentLabel, type AskDepartmentSlug } from "@/lib/os/chat-href";

const ICON_MAP = {
  Sparkles, Target, Mail, FileText, TrendingUp, Activity,
  Users, DollarSign, Phone, Calendar,
} as const;

/** What a group of actions is headed with: a name and its one-line description. */
export type QuickActionHeading = { label: string; tagline: string };

/**
 * Renders curated quick actions per agent. Click -> opens the department that
 * answers for the agent (lib/os/chat-href.ts askDepartment) with the prompt in
 * `?ask=`. The department's composer prefills it once and cleans the URL; the
 * person reviews it and presses Send. Nothing is sent on their behalf.
 *
 * `headings` is what the page decided this viewer calls each group, by agent
 * slug (lib/os/agent-names.ts: its department, for anyone but OASIS's
 * founders). Without it a group is headed by the agent's own name, which only
 * the operator's /reasoning page leaves it to do. With `byDepartment` the
 * groups are the departments the actions open, and `headings` is keyed by
 * department slug: a page that heads its groups with departments would
 * otherwise draw one heading twice for two agents of the same department.
 */
export function QuickActionsGrid({
  actions,
  headings,
  byDepartment = false,
}: {
  actions: QuickAction[];
  headings?: Readonly<Record<string, QuickActionHeading>>;
  byDepartment?: boolean;
}) {
  // Group by agent so the page reads as "what each agent can do for you", or
  // by the department each action opens.
  const groupOf = (agent: string): string => (byDepartment ? departmentForAgent(agent) : agent);
  const byAgent = actions.reduce<Record<string, QuickAction[]>>((acc, q) => {
    const group = groupOf(q.agent);
    if (!acc[group]) acc[group] = [];
    acc[group].push(q);
    return acc;
  }, {});

  // Stable order: preferred sequence first, then any other agents in the
  // order they appeared. Lets new agent packs (Solara/Helios, etc.) render
  // without each one being hand-added here.
  const PREFERRED_ORDER = ["bravo", "atlas", "maven", "aura", "hermes", "lumen", "life-preservation", "solara", "helios"];
  const seen = new Set<string>();
  const agentOrder: string[] = [];
  for (const slug of PREFERRED_ORDER) {
    const group = groupOf(slug);
    if (byAgent[group]?.length && !seen.has(group)) {
      agentOrder.push(group);
      seen.add(group);
    }
  }
  for (const q of actions) {
    const group = groupOf(q.agent);
    if (!seen.has(group)) {
      agentOrder.push(group);
      seen.add(group);
    }
  }

  return (
    <div className="space-y-6">
      {agentOrder
        .filter((slug) => byAgent[slug]?.length)
        .map((slug) => {
          const info = getAgentInfo(byAgent[slug][0].agent);
          const heading =
            headings?.[slug] ??
            (byDepartment ? { label: departmentLabel(slug as AskDepartmentSlug), tagline: "" } : { label: info.label, tagline: info.tagline });
          return (
            <div key={slug as string}>
              <div className="flex items-baseline gap-2 mb-2.5">
                <span className={`font-bold uppercase tracking-[0.14em] text-sm ${info.textClass}`}>
                  {heading.label}
                </span>
                <span className="text-xs text-fg-muted">{heading.tagline}</span>
              </div>
              <div className="grid sm:grid-cols-2 gap-2.5">
                {byAgent[slug].map((q) => {
                  const Icon = ICON_MAP[q.icon] || Sparkles;
                  const href = askDepartment(departmentForAgent(q.agent), q.prompt);
                  return (
                    <Link
                      key={`${q.agent}:${q.title}`}
                      href={href}
                      className="group rounded-lg border border-bg-border bg-bg-elev/40 hover:border-accent/50 hover:bg-accent/5 transition-all p-3.5 flex items-start gap-3"
                    >
                      <div className={`w-8 h-8 rounded-md flex items-center justify-center bg-bg-elev border border-bg-border ${info.textClass} flex-shrink-0`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold text-fg">{q.title}</span>
                          <ArrowRight className="hover-reveal-cue w-3.5 h-3.5 text-fg-dim transition-opacity" />
                        </div>
                        <div className="text-xs text-fg-muted mt-1 leading-snug">
                          {q.description}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
    </div>
  );
}
