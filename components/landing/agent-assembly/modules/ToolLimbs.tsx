"use client";

import { motion } from "framer-motion";
import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

type ToolGauntletProps = ModuleProps & {
  side: "left" | "right";
};

const TOOL_GLYPHS = [
  { label: "hammer", Glyph: HammerGlyph },
  { label: "driver", Glyph: ScrewdriverGlyph },
  { label: "laptop", Glyph: LaptopGlyph },
  { label: "wrench", Glyph: WrenchGlyph },
  { label: "scope", Glyph: ScopeGlyph },
];

/**
 * Bridge Tools — forearm-mounted gauntlets for the local bridge.
 *
 * Each side is rendered inside AgentFigure's corresponding motion.g arm slot,
 * so the cuff + suspended tool belt follows the cursor-driven arm swing.
 * This represents bravo_cli/bridge_tools.py and the local script library as
 * actual physical capabilities bolted onto the agent instead of floating UI.
 */
export function ToolGauntlet({ side, ...props }: ToolGauntletProps) {
  const isLeft = side === "left";
  const dock = isLeft ? { x: 110, y: 410 } : { x: 310, y: 410 };
  const panelX = isLeft ? -108 : 36;
  const connectorEndX = isLeft ? -32 : 32;
  const travelX = isLeft ? -320 : 320;
  const travelRotate = isLeft ? -18 : 18;

  return (
    <AssemblyModule
      {...props}
      dock={dock}
      from={{ x: dock.x + travelX, y: dock.y - 210, rotate: travelRotate, scale: 0.62 }}
      via={{ x: dock.x + travelX * 0.35, y: dock.y - 40 }}
      burstColor="rgba(252, 211, 77, 0.92)"
    >
      <g filter="url(#agent-gold-glow)">
        <line
          x1={isLeft ? 20 : -20}
          y1={0}
          x2={connectorEndX}
          y2={28}
          stroke="rgba(252,211,77,0.62)"
          strokeWidth={1.1}
          strokeDasharray="3 3"
        />

        <g>
          <rect
            x={-26}
            y={-15}
            width={52}
            height={30}
            rx={5}
            fill="rgba(7,18,15,0.96)"
            stroke="rgba(252,211,77,0.78)"
            strokeWidth={1.2}
          />
          <path
            d="M-18 -8 H18 M-18 0 H18 M-18 8 H18"
            stroke="rgba(252,211,77,0.28)"
            strokeWidth={0.8}
            strokeLinecap="round"
          />
          <circle cx={isLeft ? 21 : -21} cy={0} r={4.4} fill="rgba(252,211,77,0.18)" stroke="rgba(252,211,77,0.66)" strokeWidth={0.9} />
          <circle cx={isLeft ? 21 : -21} cy={0} r={1.8} fill="rgba(252,211,77,0.85)" />
        </g>

        <motion.g
          animate={props.forceInstalled ? undefined : { y: [0, -2.2, 0] }}
          transition={{ duration: 3.8, repeat: Infinity, ease: "easeInOut" }}
        >
          <rect
            x={panelX}
            y={26}
            width={74}
            height={54}
            rx={7}
            fill="rgba(5,16,14,0.94)"
            stroke="rgba(252,211,77,0.58)"
            strokeWidth={1}
          />
          <text
            x={panelX + 37}
            y={38}
            fontSize="4.2"
            textAnchor="middle"
            fill="rgba(254,240,138,0.78)"
            fontFamily="ui-monospace, monospace"
            letterSpacing="0.18em"
          >
            BRIDGE TOOLS
          </text>
          <line
            x1={panelX + 8}
            y1={43}
            x2={panelX + 66}
            y2={43}
            stroke="rgba(252,211,77,0.24)"
            strokeWidth={0.6}
          />

          {TOOL_GLYPHS.map(({ label, Glyph }, index) => (
            <g
              key={label}
              transform={`translate(${panelX + 11 + index * 13} 58)`}
            >
              <circle
                cx={0}
                cy={0}
                r={5.4}
                fill="rgba(252,211,77,0.10)"
                stroke="rgba(252,211,77,0.32)"
                strokeWidth={0.65}
              />
              <Glyph />
            </g>
          ))}

          <path
            d={`M${isLeft ? -24 : 24} 14 C ${isLeft ? -34 : 34} 24, ${panelX + (isLeft ? 74 : 0)} 20, ${panelX + (isLeft ? 62 : 12)} 28`}
            fill="none"
            stroke="rgba(252,211,77,0.44)"
            strokeWidth={0.8}
            strokeDasharray="2 3"
          />
        </motion.g>
      </g>
    </AssemblyModule>
  );
}

function HammerGlyph() {
  return (
    <g stroke="rgba(254,240,138,0.92)" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M-2 -3 L5 4" />
      <path d="M-5 -4 L0 -9 L5 -4 L2 -1 L-2 -5 Z" />
    </g>
  );
}

function ScrewdriverGlyph() {
  return (
    <g stroke="rgba(167,243,208,0.92)" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M-5 5 L4 -4" />
      <path d="M4 -4 L7 -7" />
      <path d="M-8 8 L-5 5" strokeWidth={2.2} />
    </g>
  );
}

function LaptopGlyph() {
  return (
    <g stroke="rgba(186,230,253,0.9)" strokeWidth={0.95} strokeLinejoin="round" fill="none">
      <rect x={-6} y={-7} width={12} height={8} rx={1.2} />
      <path d="M-8 5 H8 L5 1 H-5 Z" />
    </g>
  );
}

function WrenchGlyph() {
  return (
    <g stroke="rgba(254,240,138,0.9)" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M5 -7 C2 -7 0 -5 0 -2 L-7 5 L-5 7 L2 0 C5 0 7 -2 7 -5" />
      <path d="M4 -7 L7 -4" />
    </g>
  );
}

function ScopeGlyph() {
  return (
    <g stroke="rgba(167,243,208,0.92)" strokeWidth={1.1} strokeLinecap="round" fill="none">
      <circle cx={-2} cy={-2} r={4.2} />
      <path d="M1 1 L7 7" />
      <path d="M-2 -6 V2 M-6 -2 H2" opacity={0.65} />
    </g>
  );
}
