"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

/**
 * Reasoning Core — multi-provider AI brain. Eight-pointed star with a
 * radiant core, three nested orbital rings, and six satellite nodes
 * around the perimeter representing the available providers (Anthropic,
 * OpenAI, OpenRouter, Groq, Ollama, local Claude Code). Moved higher
 * in the chest so it doesn't overlap State Pulse + Memory Spine below.
 */
export function ReasoningCore(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 268 }}
      from={{ x: -190, y: 640, rotate: -148, scale: 0.36 }}
      via={{ x: 54, y: 414 }}
      burstColor="rgba(252, 211, 77, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        {/* Outermost orbital ring */}
        <circle r={42} fill="none" stroke="rgba(167, 243, 208, 0.32)" strokeWidth={0.9} strokeDasharray="2 4" />
        {/* Eight-pointed star frame */}
        <path
          d="M0 -39 L12 -27 H30 V-8 L41 0 L30 8 V27 H12 L0 39 L-12 27 H-30 V8 L-41 0 L-30 -8 V-27 H-12 Z"
          fill="rgba(6, 78, 59, 0.7)"
          stroke="rgba(252, 211, 77, 0.88)"
          strokeWidth={1.8}
        />
        {/* Mid orbital ring */}
        <circle r={32} fill="none" stroke="rgba(252, 211, 77, 0.45)" strokeWidth={0.7} />
        {/* Bright core */}
        <circle r={27} fill="url(#agent-core-gradient)" />
        <circle r={14} fill="rgba(252, 211, 77, 0.82)" />
        <circle r={6} fill="#fff7ed" />
        {/* Crosshair detail */}
        <path
          d="M-21 -2 H-10 M10 -2 H21 M-2 -21 V-10 M-2 10 V21"
          stroke="rgba(3, 7, 10, 0.55)"
          strokeLinecap="round"
          strokeWidth={2.4}
        />
        {/* Six satellite provider nodes around the perimeter */}
        {[0, 60, 120, 180, 240, 300].map((angle) => {
          const rad = (angle * Math.PI) / 180;
          const x = Math.cos(rad) * 38;
          const y = Math.sin(rad) * 38;
          return (
            <g key={angle}>
              <circle cx={x} cy={y} r={2.2} fill="rgba(167, 243, 208, 0.95)" />
              <circle cx={x} cy={y} r={4} fill="none" stroke="rgba(167, 243, 208, 0.35)" strokeWidth={0.6} />
            </g>
          );
        })}
      </g>
    </AssemblyModule>
  );
}
