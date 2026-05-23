"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

/**
 * Dashboard Metrics — live business KPIs floating beside the figure.
 * Renders as two small dashboard cards (MRR + Pipeline) with a sparkline
 * and a numeric headline each. Represents the operator's metrics view —
 * the agents act, the dashboard reports.
 *
 * Phase 11 (new — final phase). Floats to the LEFT of the figure at
 * shoulder/torso height so it doesn't crowd the body.
 */
export function DashboardMetrics(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 18, y: 310 }}
      from={{ x: -240, y: 420, rotate: -10, scale: 0.5 }}
      via={{ x: -60, y: 340 }}
      burstColor="rgba(132, 204, 22, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        {/* Single combined dashboard card — replaces the two stacked cards
            that previously overlapped the figure. Anchored at far-left of
            the viewBox (x=18) so it sits in clear space beside the body. */}
        <rect
          x={-44}
          y={-66}
          width={88}
          height={132}
          rx={3}
          fill="rgba(5, 16, 14, 0.95)"
          stroke="rgba(132, 204, 22, 0.6)"
          strokeWidth={0.9}
        />
        {/* Card header */}
        <text x={-38} y={-56} fontSize="4.4" fill="rgba(217, 249, 157, 0.85)" fontFamily="ui-monospace, monospace" letterSpacing="0.18em">
          LIVE METRICS
        </text>
        <line x1={-38} y1={-52} x2={38} y2={-52} stroke="rgba(132, 204, 22, 0.32)" strokeWidth={0.4} />

        {/* MRR row */}
        <text x={-38} y={-40} fontSize="3.6" fill="rgba(190, 242, 100, 0.7)" fontFamily="ui-monospace, monospace">
          Monthly revenue
        </text>
        <text x={-38} y={-28} fontSize="10" fill="#d9f99d" fontFamily="ui-monospace, monospace" fontWeight="700">
          $5,000
        </text>
        <text x={-38} y={-20} fontSize="3.6" fill="rgba(190, 242, 100, 0.7)" fontFamily="ui-monospace, monospace">
          +18% month over month
        </text>
        {/* Sparkline */}
        <path
          d="M-38 -10 L-30 -14 L-22 -12 L-14 -18 L-6 -22 L2 -26"
          fill="none"
          stroke="rgba(132, 204, 22, 0.85)"
          strokeWidth={1.1}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Divider */}
        <line x1={-38} y1={-2} x2={38} y2={-2} stroke="rgba(132, 204, 22, 0.22)" strokeWidth={0.4} />

        {/* Pipeline row */}
        <text x={-38} y={9} fontSize="3.6" fill="rgba(190, 242, 100, 0.7)" fontFamily="ui-monospace, monospace">
          Pipeline
        </text>
        <text x={-38} y={21} fontSize="10" fill="#d9f99d" fontFamily="ui-monospace, monospace" fontWeight="700">
          42 leads
        </text>
        <text x={-38} y={29} fontSize="3.6" fill="rgba(190, 242, 100, 0.7)" fontFamily="ui-monospace, monospace">
          7 closing this week
        </text>
        {/* Bar chart */}
        {[10, 8, 13, 6, 11, 16].map((h, i) => (
          <rect
            key={i}
            x={-32 + i * 12}
            y={56 - h}
            width={6}
            height={h}
            fill="rgba(132, 204, 22, 0.78)"
            rx={1}
          />
        ))}

        {/* Bottom label */}
        <text x={-38} y={62} fontSize="3.4" fill="rgba(190, 242, 100, 0.55)" fontFamily="ui-monospace, monospace">
          Last 6 weeks
        </text>
      </g>
    </AssemblyModule>
  );
}
