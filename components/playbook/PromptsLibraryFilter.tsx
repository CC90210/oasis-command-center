"use client";

/**
 * Client-side filter + section renderer for /playbook/prompts.
 *
 * The page is SSR'd and passes the full PROMPTS_LIBRARY plus the
 * category ordering down. This island wraps the search input + the
 * filtered category render. Filter is debounceless (the list is ~40
 * items, comparison is O(n) — instant on any laptop) and matches
 * against title, description, tag, category label, and agent name.
 *
 * Empty-state copy when the filter zeroes the list: tells the
 * operator their query, suggests clearing, never hides the input.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Search, ShieldAlert, User as UserIcon, Users, X } from "lucide-react";
import { Card } from "@/components/Card";
import type {
  PromptCategory,
  PromptEntry,
} from "@/lib/prompts-library";

type CategoryDef = { label: string; description: string };

type Props = {
  prompts: PromptEntry[];
  operatorCategories: PromptCategory[];
  clientCategories: PromptCategory[];
  categoryDefs: Record<PromptCategory, CategoryDef>;
};

export function PromptsLibraryFilter({
  prompts,
  operatorCategories,
  clientCategories,
  categoryDefs,
}: Props) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  // Match against the fields the operator's most likely to remember:
  // title (what's on the card), description (the explainer), tags
  // (semantic keywords), category label (e.g. "Daily ops"), agent
  // name. ID intentionally excluded — those are slugs, not user copy.
  const filtered = useMemo(() => {
    if (!q) return prompts;
    return prompts.filter((p) => {
      const haystack = [
        p.title,
        p.description,
        ...(p.tags || []),
        categoryDefs[p.category]?.label,
        p.agent,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [prompts, q, categoryDefs]);

  const operatorPrompts = filtered.filter(
    (p) => p.audience === "operator" || p.audience === "shared",
  );
  const clientPrompts = filtered.filter(
    (p) => p.audience === "client" || p.audience === "shared",
  );

  const hasResults = filtered.length > 0;

  return (
    <div className="space-y-6">
      {/* Search bar — sticky-ish (no real CSS stickiness yet; we may
          add later if the lists get long). Magnifier on the left,
          clear-X on the right when there's a query. */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-dim pointer-events-none" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search prompts by title, description, tag, agent, or category…"
          className="w-full bg-bg-elev/60 border border-bg-border rounded-lg pl-10 pr-10 py-2.5 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent/50 focus:bg-bg-elev transition-colors"
          aria-label="Filter prompts"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear filter"
            className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded text-fg-dim hover:text-fg hover:bg-bg-border transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {q && (
          <div className="mt-2 text-xs text-fg-muted">
            {filtered.length} match{filtered.length === 1 ? "" : "es"} for <span className="font-mono text-accent">{q}</span>
          </div>
        )}
      </div>

      {/* Empty state — only when the operator filtered to zero. The
          unfiltered library is never empty so this only renders for
          a typo'd query. */}
      {!hasResults && (
        <Card title="No matches" subtitle="Try a different keyword, or clear the filter.">
          <div className="text-sm text-fg-muted">
            Nothing matched <span className="font-mono text-accent">{q}</span>. Try a shorter keyword, an agent name (bravo / maven / atlas / aura), or a tag like <code className="text-accent">daily</code>, <code className="text-accent">inbox</code>, <code className="text-accent">handoff</code>, <code className="text-accent">sync</code>.
          </div>
        </Card>
      )}

      {hasResults && (
        <>
          {/* ── YOUR PROMPTS (operator) ────────────────────────── */}
          {operatorPrompts.length > 0 && (
            <div>
              <div className="flex items-baseline gap-2 mb-3">
                <UserIcon className="w-4 h-4 text-accent" />
                <h2 className="text-lg font-bold text-fg">Your prompts</h2>
                <span className="text-xs text-fg-muted">
                  personal to your OASIS AI deployment + universal moves
                </span>
              </div>
              <div className="space-y-4">
                {operatorCategories.map((cat) => {
                  const def = categoryDefs[cat];
                  const list = operatorPrompts.filter((p) => p.category === cat);
                  if (list.length === 0) return null;
                  return (
                    <Card key={cat} title={def.label} subtitle={def.description}>
                      <div className="grid sm:grid-cols-2 gap-2.5">
                        {list.map((p) => (
                          <PromptCard key={p.id} p={p} />
                        ))}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── CLIENT DEPLOYMENT TOOLKIT ──────────────────────── */}
          {clientPrompts.length > 0 && (
            <div>
              <div className="flex items-baseline gap-2 mb-3">
                <Users className="w-4 h-4 text-pink-400" />
                <h2 className="text-lg font-bold text-fg">Client deployment toolkit</h2>
                <span className="text-xs text-fg-muted">
                  run these when setting up a new client&apos;s machine
                </span>
              </div>
              <div className="space-y-4">
                {clientCategories.map((cat) => {
                  const def = categoryDefs[cat];
                  const list = clientPrompts.filter((p) => p.category === cat);
                  if (list.length === 0) return null;
                  return (
                    <Card key={cat} title={def.label} subtitle={def.description}>
                      <div className="grid sm:grid-cols-2 gap-2.5">
                        {list.map((p) => (
                          <PromptCard key={p.id} p={p} />
                        ))}
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PromptCard({ p }: { p: PromptEntry }) {
  const href = `/agents?agent=${encodeURIComponent(p.agent)}&prompt=${encodeURIComponent(p.prompt)}`;
  const isOverride = p.category === "system_override";
  return (
    <Link
      href={href}
      className="group rounded-lg border border-bg-border bg-bg-elev/40 hover:border-accent/50 hover:bg-accent/5 transition-all p-3.5 flex items-start gap-3"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-bold text-fg">{p.title}</span>
          {p.foundational && (
            <span className="text-[9px] uppercase tracking-wider font-bold text-accent bg-accent/10 border border-accent/30 px-1.5 py-0.5 rounded">
              foundational
            </span>
          )}
          <span className="text-[10px] uppercase tracking-wider font-bold text-fg-dim">
            → {p.agent}
          </span>
          <ArrowRight className="hover-reveal-cue w-3.5 h-3.5 text-fg-dim transition-opacity ml-auto" />
        </div>
        <div className="text-xs text-fg-muted mt-1.5 leading-snug">{p.description}</div>
        {isOverride && (
          <div className="text-[10px] text-status-warm font-mono mt-2 inline-flex items-center gap-1">
            <ShieldAlert className="w-3 h-3" /> [OVERRIDE] prompt
          </div>
        )}
      </div>
    </Link>
  );
}
