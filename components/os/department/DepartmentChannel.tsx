"use client";

/**
 * DepartmentChannel — the main column of a department tab.
 *
 * The channel IS components/agents/AgentChat.tsx (plan pillar 2: channels are
 * built on AgentChat, never on the 4,170-line operator ChatWidget), bound to the
 * department's agent by the server (./channel.ts). The header it draws carries
 * the DEPARTMENT's name, never the agent's: clients address "Sales", not a
 * persona (design doc §(b)).
 *
 * When the channel cannot answer, it says why and who can fix it, instead of
 * rendering a composer whose first message would fail.
 *
 * PREFILL. AgentChat keeps its draft in its own state and takes no initial
 * value, and it is not this workstream's file. Until it grows an `initialInput`
 * prop (requested in the workstream report), a draft from the Ask composer or a
 * Suggested ask is written into its textarea the way a person typing would be:
 * the native value setter plus an `input` event, which React's onChange reads.
 * It never submits. If AgentChat's markup changes and no textarea is found,
 * nothing is filled and nothing breaks.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { PlugZap } from "lucide-react";
import { AgentChat } from "@/components/agents/AgentChat";
import { useComposer } from "./ComposerContext";
import type { ChannelState } from "./channel";
import { brainLine } from "@/lib/ai/department-brain";

function fillComposer(root: HTMLElement | null, text: string): void {
  const box = root?.querySelector("textarea");
  if (!box || box.disabled) return;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setValue) return;
  setValue.call(box, text);
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.focus();
  box.setSelectionRange(text.length, text.length);
}

export function DepartmentChannel({ label, state }: { label: string; state: ChannelState }) {
  const { draft } = useComposer();
  const root = useRef<HTMLElement>(null);
  const nonce = draft?.nonce ?? 0;
  const text = draft?.text ?? "";

  useEffect(() => {
    if (state.kind === "ready" && nonce > 0 && text) fillComposer(root.current, text);
  }, [nonce, text, state.kind]);

  if (state.kind !== "ready") {
    return (
      <section
        aria-label={`${label} channel`}
        className="flex min-h-[18rem] flex-col items-start justify-center gap-3 rounded-xl border border-hairline bg-bg-panel p-6"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-fg">
          <PlugZap className="h-4 w-4 text-fg-dim" strokeWidth={1.75} aria-hidden />
          {state.kind === "unknown" ? "Couldn’t check this channel" : "Channel not connected"}
        </div>
        <p className="max-w-prose text-sm leading-[1.55] text-fg-muted">{state.reason}</p>
        {state.kind === "not_connected" && state.action && (
          <Link href={state.action.href} prefetch={false} className="btn-primary">
            {state.action.label}
          </Link>
        )}
      </section>
    );
  }

  return (
    <section ref={root} aria-label={`${label} channel`}>
      {/* No tenant slug: the route takes the workspace from the session. The
          department makes the route answer AS the department (its label in
          the stream, its identity lock), never as the agent behind it. */}
      <AgentChat
        department={state.department}
        agentSlug={state.agentSlug}
        agentName={label}
        agentSubtitle="Department channel"
        greeting={state.greeting}
        canManageAi={state.canManageAi}
        initialFailure={state.lastTurn.kind === "failed" ? state.lastTurn.code : null}
        // Owners and admins: the people who choose it in Settings > AI brain.
        poweredBy={state.canManageAi && state.brain ? brainLine(state.brain) : null}
      />
    </section>
  );
}
