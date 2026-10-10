"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ENGINE_SETTINGS_HREF, spendTag, type EngineLabel } from "@/lib/ai/agent-engine";

/**
 * The header of a channel conversation: who it is, a plan-mode badge, and what
 * powers it. Shared by components/agents/AgentChat.tsx (a direct agent chat)
 * and components/agents/DepartmentChat.tsx (a department channel), moved here
 * from AgentChat unchanged so the two cannot drift.
 */
export function ChannelHeader({
  agentName,
  agentSubtitle,
  planMode,
  onExitPlan,
  poweredBy,
  modelLabel,
  canManageAi,
  actions,
}: {
  agentName: string;
  agentSubtitle?: string;
  planMode: "plan" | "build";
  /** Click on the plan-mode badge: back to build (same as /build). */
  onExitPlan: () => void;
  poweredBy: EngineLabel | null;
  /** The model an `agent` event named (the verified operator only). */
  modelLabel: string | null;
  canManageAi: boolean;
  /** Buttons that belong to the conversation (past chats, new chat). */
  actions?: React.ReactNode;
}) {
  return (
    <div className="border-b border-bg-border px-5 py-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="leading-tight">
          <div className="font-bold text-sm text-fg">{agentName}</div>
          {agentSubtitle && (
            <div className="text-[10px] uppercase tracking-[0.16em] text-fg-dim">
              {agentSubtitle}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {actions}
        {planMode === "plan" && (
          // Plan-mode badge — click to /build. Mirrors ChatWidget's
          // badge in shape + behavior so the operator's muscle memory
          // from the /agents page transfers to the tenant preview.
          <button
            type="button"
            onClick={onExitPlan}
            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-bold px-2 py-1 rounded-md border border-status-warm/40 bg-status-warm/10 text-status-warm hover:bg-status-warm/20 transition-colors"
            title="Plan mode active — agent restricted to read/research. Click to exit (same as /build)."
          >
            ● PLAN MODE
          </button>
        )}
        {poweredBy ? (
          // The one source: what powers your agents, as AI brain shows and
          // switches it. A click opens that choice (Settings > AI brain).
          <Link
            href={ENGINE_SETTINGS_HREF}
            prefetch={false}
            data-testid="channel-engine"
            title={`${poweredBy.note ? `${poweredBy.note} ` : ""}Change what powers your agents in Settings > AI brain.`}
            className="min-w-0 max-w-[16rem] sm:max-w-[22rem] truncate text-right text-[11px] leading-tight text-fg-dim hover:text-fg underline-offset-2 hover:underline"
          >
            {poweredBy.line}
            <span className="block text-[10px] text-fg-dim/80">
              {poweredBy.note ? "Fallback in use" : spendTag(poweredBy.spend)}
            </span>
          </Link>
        ) : (
          modelLabel &&
          // The engine choice is an owner's or admin's (Settings > AI brain
          // answers anyone else with a 404), so a member sees the label only.
          (canManageAi ? (
            <Link
              href={ENGINE_SETTINGS_HREF}
              prefetch={false}
              title="Change what powers your agents in Settings > AI brain"
              className="text-[10px] uppercase tracking-[0.16em] text-fg-dim font-mono hover:text-fg"
            >
              {modelLabel}
            </Link>
          ) : (
            <span className="text-[10px] uppercase tracking-[0.16em] text-fg-dim font-mono">{modelLabel}</span>
          ))
        )}
      </div>
    </div>
  );
}
