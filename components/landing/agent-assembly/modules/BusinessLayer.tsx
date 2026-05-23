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
        {/* Four brand-pillar tags anchored at body landmarks with thin
            connector lines back to the figure. Replaces the previous
            big orbital ring that competed with the GuardShield +
            SecurityMesh wraps. Each tag attaches to a specific anchor
            point so it reads as DOCKED to the body, not floating. */}
        {[
          { x: -184, y: -44, anchorX: -50, anchorY: -36, label: "BRAND" },
          { x: 184, y: -44, anchorX: 50, anchorY: -36, label: "VOICE" },
          { x: -184, y: 72, anchorX: -50, anchorY: 60, label: "AUDIENCE" },
          { x: 184, y: 72, anchorX: 50, anchorY: 60, label: "GOALS" },
        ].map((tag) => (
          <g key={tag.label}>
            {/* Thin connector line from body anchor to tag */}
            <line
              x1={tag.anchorX}
              y1={tag.anchorY}
              x2={tag.x + (tag.x > 0 ? -22 : 22)}
              y2={tag.y}
              stroke="rgba(167, 139, 250, 0.42)"
              strokeWidth={0.8}
              strokeDasharray="2 3"
            />
            {/* Anchor dot on the body */}
            <circle
              cx={tag.anchorX}
              cy={tag.anchorY}
              r={1.6}
              fill="rgba(216, 180, 254, 0.95)"
            />
            {/* Tag badge */}
            <g transform={`translate(${tag.x} ${tag.y})`}>
              <rect
                x={-22}
                y={-7}
                width={44}
                height={14}
                rx={2}
                fill="rgba(7, 18, 15, 0.94)"
                stroke="rgba(167, 139, 250, 0.7)"
                strokeWidth={0.9}
              />
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
          </g>
        ))}
      </g>
    </AssemblyModule>
  );
}
