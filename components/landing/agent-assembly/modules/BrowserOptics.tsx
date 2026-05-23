"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

/**
 * Browser Optics — futuristic visor that sits OVER the eyes (the
 * figure's eyes are at y=165). Previously docked at y=176, which
 * placed the visor BELOW the eyes — visually wrong. Now docked at
 * y=164 so the visor straddles the eye line. Slim lens cutouts let
 * the cursor-tracking pupils show through.
 */
export function BrowserOptics(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 164 }}
      from={{ x: 562, y: -166, rotate: -86, scale: 0.42 }}
      via={{ x: 368, y: 52 }}
      burstColor="rgba(153, 246, 228, 0.95)"
    >
      <g filter="url(#agent-soft-glow)">
        {/* Outer visor frame — sleeker silhouette, less bulky than before */}
        <path
          d="M-58 -10 L-50 -14 H-22 L-15 -6 H15 L22 -14 H50 L58 -10 V8 L52 14 H22 L14 8 H-14 L-22 14 H-52 L-58 8 Z"
          fill="rgba(15, 118, 110, 0.14)"
          stroke="rgba(153, 246, 228, 0.82)"
          strokeWidth={1.4}
        />
        {/* Lens cutouts — translucent so the eye pupils show through */}
        <ellipse cx={-20} cy={1} rx={14} ry={6} fill="rgba(153, 246, 228, 0.12)" stroke="rgba(153, 246, 228, 0.65)" strokeWidth={0.8} />
        <ellipse cx={20} cy={1} rx={14} ry={6} fill="rgba(153, 246, 228, 0.12)" stroke="rgba(153, 246, 228, 0.65)" strokeWidth={0.8} />
        {/* HUD scan reticles inside each lens */}
        <path d="M-26 1 H-14 M-20 -5 V7" stroke="rgba(153, 246, 228, 0.55)" strokeWidth={0.5} strokeLinecap="round" />
        <path d="M14 1 H26 M20 -5 V7" stroke="rgba(153, 246, 228, 0.55)" strokeWidth={0.5} strokeLinecap="round" />
        {/* Bridge accent + side temple tips */}
        <path d="M-8 1 H8" stroke="rgba(209, 250, 229, 0.78)" strokeLinecap="round" strokeWidth={1.2} />
        <path d="M-58 -2 L-66 -4 M58 -2 L66 -4" stroke="rgba(252, 211, 77, 0.62)" strokeLinecap="round" strokeWidth={1.2} />
        {/* Forward HUD beam projection — emanates downward from the visor */}
        <path
          d="M-30 12 L-44 32 M30 12 L44 32"
          stroke="rgba(153, 246, 228, 0.28)"
          strokeLinecap="round"
          strokeWidth={0.8}
          strokeDasharray="3 4"
        />
        {/* Top status pin */}
        <circle cx={0} cy={-12} r={1.6} fill="rgba(252, 211, 77, 0.9)" />
      </g>
    </AssemblyModule>
  );
}
