"use client";

import type { ModuleProps } from "../AssemblyModule";
import { AssemblyModule } from "../AssemblyModule";

/**
 * Tool Bridge — holographic interface palettes that float beside each
 * forearm. Represents the 21-tool registry in bravo_cli/bridge_tools.py
 * + the 115 CLI scripts under scripts/. Deliberately does NOT redraw
 * the figure's arms (those already exist in AgentFigure) — instead it
 * "attaches" floating data panels with a grid of tool-glyph dots.
 *
 * Dock anchors on the figure's centre so left/right tool palettes
 * symmetric-frame the body. Translucent emerald-amber palette so they
 * distinguish from the green body silhouette.
 */
export function ToolLimbs(props: ModuleProps) {
  return (
    <AssemblyModule
      {...props}
      dock={{ x: 210, y: 340 }}
      from={{ x: 0, y: -320, rotate: 0, scale: 0.6 }}
      via={{ x: 120, y: 80 }}
      burstColor="rgba(252, 211, 77, 0.92)"
    >
      <g>
        {/* Two interface panels — left forearm + right forearm.
            Each is a small rounded-rect with a 3x4 dot grid suggesting
            an open tool palette. Wrist tether line connects each panel
            to the forearm. */}
        {[-1, 1].map((side) => {
          const panelX = side * 122;
          return (
            <g key={side}>
              {/* Tether from forearm to panel */}
              <line
                x1={side * 92}
                y1={6}
                x2={panelX - side * 22}
                y2={-4}
                stroke="rgba(252,211,77,0.55)"
                strokeWidth={0.9}
                strokeDasharray="3 3"
              />
              {/* Panel frame */}
              <rect
                x={panelX - 22}
                y={-26}
                width={44}
                height={52}
                rx={6}
                fill="rgba(7, 18, 15, 0.88)"
                stroke="rgba(252,211,77,0.55)"
                strokeWidth={1.1}
              />
              {/* Inner divider */}
              <line
                x1={panelX - 18}
                y1={-12}
                x2={panelX + 18}
                y2={-12}
                stroke="rgba(252,211,77,0.32)"
                strokeWidth={0.6}
              />
              {/* Header dot row */}
              <circle cx={panelX - 14} cy={-19} r={1.4} fill="rgba(252,211,77,0.8)" />
              <circle cx={panelX - 8}  cy={-19} r={1.4} fill="rgba(252,211,77,0.55)" />
              <circle cx={panelX - 2}  cy={-19} r={1.4} fill="rgba(252,211,77,0.45)" />
              {/* 3 rows of 5 tool glyphs each = 15 visible tools per panel
                  (the bridge actually exposes 21 tools, but 15 is the
                  visible density that reads cleanly at this scale) */}
              {[0, 1, 2].map((row) =>
                [0, 1, 2, 3, 4].map((col) => (
                  <circle
                    key={`${row}-${col}`}
                    cx={panelX - 16 + col * 8}
                    cy={-5 + row * 9}
                    r={1.5}
                    fill={
                      (row + col) % 3 === 0
                        ? "rgba(167,243,208,0.78)"
                        : "rgba(252,211,77,0.42)"
                    }
                  />
                )),
              )}
              {/* Wrist gauntlet ring — subtle accent on the forearm
                  where the tool palette docks */}
              <circle
                cx={side * 92}
                cy={6}
                r={6}
                fill="none"
                stroke="rgba(252,211,77,0.62)"
                strokeWidth={1}
              />
              <circle cx={side * 92} cy={6} r={2} fill="rgba(252,211,77,0.72)" />
            </g>
          );
        })}
      </g>
    </AssemblyModule>
  );
}
