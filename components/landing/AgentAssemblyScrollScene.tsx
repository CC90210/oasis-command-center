"use client";

/**
 * AgentAssemblyScrollScene — placeholder pending Codex rebuild.
 *
 * The previous implementations (photo crossfade, clip-path reveal,
 * code-driven SVG modules on a photo backdrop) were all rejected. CC's
 * canonical direction (2026-05-22):
 *
 *   - Delete the photo keyframes (no static images of the agent).
 *   - Build an INTERACTIVE agent figure that tracks the user's cursor
 *     (gaze + head orientation follow the mouse pointer).
 *   - Scroll triggers a manufacturing-line assembly where AI parts
 *     (reasoning core, memory spine, browser optics, tool limbs, guard
 *     shield, output halo, security mesh) fly in from the edges like
 *     puzzle pieces and snap into final position on the figure.
 *   - Use framer-motion (or similar) — actual web animation primitives,
 *     not photo crossfade tricks.
 *
 * Codex is being briefed to do the actual implementation per
 * brain/AGENTS.md Rule 8 (CC explicitly asked for Codex delegation on
 * this build). Until that ships, /welcome renders a minimal placeholder
 * so production doesn't break.
 */

import { ChevronDown } from "lucide-react";

export function AgentAssemblyScrollScene() {
  return (
    <section
      id="agent-build"
      className="relative z-10 flex min-h-[80vh] flex-col items-center justify-center px-6 py-24"
    >
      <div className="max-w-2xl text-center">
        <div className="mb-5 inline-flex items-center gap-2 border-l border-emerald-300/[0.45] bg-emerald-300/[0.08] px-3 py-2 text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-100/[0.85]">
          Build the agent first
        </div>
        <h1 className="text-[clamp(2.35rem,4.4vw,4.8rem)] font-black leading-[0.94] tracking-tight text-white">
          Build the agent before you enter.
        </h1>
        <p className="mt-6 text-base leading-7 text-white/[0.66]">
          Before signup, the system assembles a working operator around your business — reasoning, memory, vision, tools, guardrails, and security lock into the body.
        </p>
        <a
          href="#choose-agent"
          className="mt-10 inline-flex items-center gap-2 border border-emerald-200/[0.55] bg-emerald-200/[0.14] px-5 py-3 text-sm font-bold text-emerald-100 backdrop-blur-md transition-all hover:border-emerald-200/[0.85] hover:bg-emerald-200/[0.22]"
        >
          Choose entry
          <ChevronDown className="h-4 w-4" />
        </a>
      </div>
    </section>
  );
}
