"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

const NODES = [-40, -20, 0, 20, 40];

/**
 * Memory Spine — vertical FTS5 + LanceDB column. Moved DOWN to the
 * lower torso / abdomen (y=395) so it stops piling up with the
 * Reasoning Core + State Pulse on the upper chest. Narrower (12px
 * wide vs 24px) so it reads as a precise data column rather than
 * a heavy slab. Each node has a small data-bracket prefix to
 * suggest indexed memory chunks.
 */
export function MemorySpine(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 395 }}
      from={{ x: 218, y: 728, rotate: 72, scale: 0.34 }}
      via={{ x: 146, y: 482 }}
      burstColor="rgba(52, 211, 153, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        {/* Slim vertical column */}
        <path
          d="M-9 -54 H9 L13 -46 V46 L9 54 H-9 L-13 46 V-46 Z"
          fill="rgba(4, 47, 46, 0.85)"
          stroke="rgba(52, 211, 153, 0.7)"
          strokeWidth={1.3}
        />
        {/* Central data line */}
        <path
          d="M0 -48 V48"
          stroke="rgba(167, 243, 208, 0.55)"
          strokeLinecap="round"
          strokeWidth={1}
        />
        {/* 5 memory chunk nodes with data-bracket annotations */}
        {NODES.map((nodeY, idx) => (
          <g key={nodeY} transform={`translate(0 ${nodeY})`}>
            {/* Halo ring */}
            <circle r={7.5} fill="rgba(6, 78, 59, 0.95)" stroke="rgba(167, 243, 208, 0.45)" strokeWidth={0.6} />
            {/* Bright inner node */}
            <circle r={3.4} fill="#6ee7b7" />
            {/* Data brackets on alternating sides */}
            {idx % 2 === 0 ? (
              <g>
                <path d="M-22 -3 L-26 -3 L-26 3 L-22 3" fill="none" stroke="rgba(52, 211, 153, 0.6)" strokeWidth={0.9} strokeLinecap="round" />
                <text x={-32} y={2.5} fontSize="3.4" fill="rgba(167, 243, 208, 0.85)" fontFamily="ui-monospace, monospace" textAnchor="end">
                  {String(idx + 1).padStart(2, "0")}
                </text>
              </g>
            ) : (
              <g>
                <path d="M22 -3 L26 -3 L26 3 L22 3" fill="none" stroke="rgba(52, 211, 153, 0.6)" strokeWidth={0.9} strokeLinecap="round" />
                <text x={32} y={2.5} fontSize="3.4" fill="rgba(167, 243, 208, 0.85)" fontFamily="ui-monospace, monospace">
                  {String(idx + 1).padStart(2, "0")}
                </text>
              </g>
            )}
          </g>
        ))}
      </g>
    </AssemblyModule>
  );
}
