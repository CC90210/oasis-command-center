"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

/**
 * Business Layer — the operator's brand identity wrapped around the
 * agent. Docks BEHIND the figure as a rotating data ring with brand-
 * pillar tags (Brand · Voice · Audience · Goals). Represents the fact
 * that every agent in OASIS is trained on the operator's real business
 * data — not a generic model.
 *
 * Phase 9 (was: not previously rendered).
 */
export function BusinessLayer(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 360 }}
      from={{ x: -440, y: 360, rotate: 0, scale: 0.4 }}
      via={{ x: -120, y: 360 }}
      burstColor="rgba(167, 139, 250, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        {/* Wide oval data ring around the figure's torso */}
        <ellipse
          cx={0}
          cy={0}
          rx={160}
          ry={92}
          fill="none"
          stroke="rgba(167, 139, 250, 0.42)"
          strokeWidth={1.1}
          strokeDasharray="6 8"
        />
        <ellipse
          cx={0}
          cy={0}
          rx={140}
          ry={78}
          fill="none"
          stroke="rgba(167, 139, 250, 0.28)"
          strokeWidth={0.7}
        />

        {/* Four brand-pillar tags pinned at compass points on the ring */}
        {[
          { x: -158, y: 0, label: "BRAND" },
          { x: 158, y: 0, label: "VOICE" },
          { x: 0, y: -90, label: "AUDIENCE" },
          { x: 0, y: 92, label: "GOALS" },
        ].map((tag) => (
          <g key={tag.label} transform={`translate(${tag.x} ${tag.y})`}>
            <rect x={-22} y={-7} width={44} height={14} rx={2} fill="rgba(7, 18, 15, 0.92)" stroke="rgba(167, 139, 250, 0.7)" strokeWidth={0.8} />
            <text
              x={0}
              y={3}
              fontSize="6.5"
              fill="rgba(216, 180, 254, 0.95)"
              fontFamily="ui-monospace, monospace"
              textAnchor="middle"
              letterSpacing="0.18em"
            >
              {tag.label}
            </text>
          </g>
        ))}

        {/* Four small data dots between the tags for visual rhythm */}
        {[45, 135, 225, 315].map((angle) => {
          const rad = (angle * Math.PI) / 180;
          const x = Math.cos(rad) * 158;
          const y = Math.sin(rad) * 90;
          return (
            <circle
              key={angle}
              cx={x}
              cy={y}
              r={2}
              fill="rgba(216, 180, 254, 0.85)"
            />
          );
        })}
      </g>
    </AssemblyModule>
  );
}
