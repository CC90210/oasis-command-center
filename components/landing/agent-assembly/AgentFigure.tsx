"use client";

import type { ReactNode } from "react";
import {
  motion,
  useSpring,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { AgentEye } from "./AgentEye";

type AgentFigureProps = {
  children?: ReactNode;
  cursorX: MotionValue<number>;
  cursorY: MotionValue<number>;
  className?: string;
};

const HEAD_SPRING = {
  stiffness: 120,
  damping: 22,
  mass: 0.45,
};

// Softer spring for arms so they trail the head slightly — feels organic,
// like the body catching up to where the gaze has already shifted.
const ARM_SPRING = {
  stiffness: 80,
  damping: 26,
  mass: 0.6,
};

export function AgentFigure({
  children,
  cursorX,
  cursorY,
  className,
}: AgentFigureProps) {
  const headRotate = useSpring(useTransform(cursorX, [-1, 1], [-4, 4]), HEAD_SPRING);
  const headPitch = useSpring(useTransform(cursorY, [-1, 1], [2, -2]), HEAD_SPRING);
  const headX = useSpring(useTransform(cursorX, [-1, 1], [-1.8, 1.8]), HEAD_SPRING);
  const headY = useSpring(useTransform(cursorY, [-1, 1], [-1.2, 1.2]), HEAD_SPRING);

  // Arms drift toward the cursor with a softer, slower spring. Left arm
  // pivots subtly inward on right-cursor (and vice-versa) so the agent
  // looks like it's reaching toward the pointer.
  const leftArmX = useSpring(useTransform(cursorX, [-1, 1], [-2.5, 1.5]), ARM_SPRING);
  const leftArmY = useSpring(useTransform(cursorY, [-1, 1], [-1, 1.5]), ARM_SPRING);
  const leftArmRotate = useSpring(useTransform(cursorX, [-1, 1], [1.5, -2.2]), ARM_SPRING);
  const rightArmX = useSpring(useTransform(cursorX, [-1, 1], [-1.5, 2.5]), ARM_SPRING);
  const rightArmY = useSpring(useTransform(cursorY, [-1, 1], [-1, 1.5]), ARM_SPRING);
  const rightArmRotate = useSpring(useTransform(cursorX, [-1, 1], [-2.2, 1.5]), ARM_SPRING);

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 420 560"
      className={className}
    >
      <defs>
        <radialGradient id="agent-core-gradient" cx="50%" cy="45%" r="70%">
          <stop offset="0%" stopColor="#d1fae5" stopOpacity="0.92" />
          <stop offset="44%" stopColor="#34d399" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#064e3b" stopOpacity="0.05" />
        </radialGradient>
        <linearGradient id="agent-body-gradient" x1="0%" x2="100%" y1="0%" y2="100%">
          <stop offset="0%" stopColor="#10231f" />
          <stop offset="52%" stopColor="#081411" />
          <stop offset="100%" stopColor="#03100e" />
        </linearGradient>
        <linearGradient id="agent-edge-gradient" x1="0%" x2="100%">
          <stop offset="0%" stopColor="rgba(52, 211, 153, 0.18)" />
          <stop offset="50%" stopColor="rgba(167, 243, 208, 0.74)" />
          <stop offset="100%" stopColor="rgba(52, 211, 153, 0.18)" />
        </linearGradient>
        <filter id="agent-soft-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="7" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="0 0 0 0 0.1 0 0 0 0 0.9 0 0 0 0 0.62 0 0 0 0.48 0"
          />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="agent-gold-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="6" result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 0.78 0 0 0 0 0.18 0 0 0 0.55 0"
          />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <clipPath id="agent-torso-clip">
          <path d="M143 254 L181 227 H239 L277 254 L263 420 L226 470 H194 L157 420 Z" />
        </clipPath>
      </defs>

      <g opacity={0.42}>
        <ellipse cx={210} cy={514} rx={116} ry={18} fill="rgba(52,211,153,0.18)" />
        <ellipse cx={210} cy={514} rx={72} ry={8} fill="rgba(252,211,77,0.12)" />
      </g>

      <g>
        {/* LEFT arm group — pivots at the shoulder (140, 250) so subtle
            rotation reads as the arm swinging toward the cursor. */}
        <motion.g
          style={{
            x: leftArmX,
            y: leftArmY,
            rotate: leftArmRotate,
            transformBox: "view-box",
            transformOrigin: "140px 250px",
          }}
        >
          <path
            d="M128 273 C115 306 111 359 122 421 L147 411 C141 357 145 311 160 279 Z"
            fill="#07120f"
            stroke="rgba(52,211,153,0.18)"
            strokeWidth={1.2}
          />
          <path
            d="M111 264 C128 232 162 216 184 226 L167 277 C143 276 124 273 111 264 Z"
            fill="url(#agent-body-gradient)"
            stroke="rgba(52,211,153,0.26)"
            strokeWidth={1.4}
          />
        </motion.g>

        {/* RIGHT arm group — mirrored pivot at (280, 250). */}
        <motion.g
          style={{
            x: rightArmX,
            y: rightArmY,
            rotate: rightArmRotate,
            transformBox: "view-box",
            transformOrigin: "280px 250px",
          }}
        >
          <path
            d="M292 273 C305 306 309 359 298 421 L273 411 C279 357 275 311 260 279 Z"
            fill="#07120f"
            stroke="rgba(52,211,153,0.18)"
            strokeWidth={1.2}
          />
          <path
            d="M309 264 C292 232 258 216 236 226 L253 277 C277 276 296 273 309 264 Z"
            fill="url(#agent-body-gradient)"
            stroke="rgba(52,211,153,0.26)"
            strokeWidth={1.4}
          />
        </motion.g>
        <path
          d="M143 254 L181 227 H239 L277 254 L263 420 L226 470 H194 L157 420 Z"
          fill="url(#agent-body-gradient)"
          stroke="rgba(167,243,208,0.24)"
          strokeWidth={1.6}
        />
        <path
          d="M165 267 L188 247 H232 L255 267 L245 393 L222 441 H198 L175 393 Z"
          fill="rgba(3, 7, 10, 0.5)"
          stroke="rgba(52,211,153,0.20)"
          strokeWidth={1.1}
        />
        <path
          d="M189 249 L210 282 L231 249"
          fill="none"
          stroke="url(#agent-edge-gradient)"
          strokeWidth={1.4}
          strokeLinecap="round"
        />
        <path
          d="M174 336 H246 M181 389 H239"
          fill="none"
          stroke="rgba(52,211,153,0.18)"
          strokeLinecap="round"
          strokeWidth={1}
        />

        {/* Articulated armour plates — overlapping segments with glowing
            seam lines between them. Reads as a sleek futuristic suit
            rather than a flat torso outline. */}
        <g clipPath="url(#agent-torso-clip)">
          <g opacity={0.26}>
            <path
              d="M128 290 H292 M128 322 H292 M128 354 H292 M128 386 H292 M128 418 H292"
              fill="none"
              stroke="rgba(167,243,208,0.35)"
              strokeWidth={0.8}
            />
            <path
              d="M154 236 V457 M186 226 V482 M218 226 V482 M250 236 V457"
              fill="none"
              stroke="rgba(52,211,153,0.16)"
              strokeWidth={0.8}
            />
          </g>
          {/* Glowing seam lines */}
          <path
            d="M155 270 L155 415 M265 270 L265 415"
            fill="none"
            stroke="rgba(134,239,172,0.45)"
            strokeWidth={0.8}
          />
          {/* Diagonal pectoral plates */}
          <path
            d="M165 270 L205 296 L205 332 L165 318 Z"
            fill="rgba(52,211,153,0.05)"
            stroke="rgba(134,239,172,0.32)"
            strokeWidth={0.9}
          />
          <path
            d="M255 270 L215 296 L215 332 L255 318 Z"
            fill="rgba(52,211,153,0.05)"
            stroke="rgba(134,239,172,0.32)"
            strokeWidth={0.9}
          />
          {/* Lower abdomen plates */}
          <path
            d="M170 360 H250 L246 396 H174 Z"
            fill="rgba(52,211,153,0.04)"
            stroke="rgba(134,239,172,0.28)"
            strokeWidth={0.9}
          />
        </g>

        {/* OASIS tree-of-life chest emblem — pulsing low-opacity insignia
            on the upper chest plate. References the OASIS brand mark
            (circuit-tree icon) without competing with the assembly modules.
            Opacity intentionally low so the docked modules at the chest
            (ReasoningCore, StatePulse) stay foregrounded. */}
        <g opacity={0.32}>
          {/* Roots */}
          <path
            d="M205 358 L200 366 M210 358 L210 368 M215 358 L220 366"
            fill="none"
            stroke="rgba(167,243,208,0.55)"
            strokeLinecap="round"
            strokeWidth={0.9}
          />
          {/* Trunk */}
          <line x1={210} y1={328} x2={210} y2={358} stroke="rgba(167,243,208,0.62)" strokeWidth={1.1} strokeLinecap="round" />
          {/* Branches */}
          <path
            d="M210 338 L199 326 M210 338 L221 326 M210 332 L201 320 M210 332 L219 320"
            fill="none"
            stroke="rgba(167,243,208,0.50)"
            strokeLinecap="round"
            strokeWidth={0.8}
          />
          {/* Canopy nodes — three small leaves */}
          <circle cx={199} cy={326} r={1.6} fill="rgba(134,239,172,0.85)" />
          <circle cx={221} cy={326} r={1.6} fill="rgba(134,239,172,0.85)" />
          <circle cx={210} cy={318} r={2.0} fill="rgba(252,211,77,0.78)" />
          {/* Crown shimmer */}
          <circle cx={210} cy={318} r={4.2} fill="none" stroke="rgba(252,211,77,0.45)" strokeWidth={0.7} />
        </g>

        {/* Shoulder pauldron accent strokes — adds futuristic articulation
            to the shoulder caps so they read as armoured, not painted on. */}
        <g opacity={0.7}>
          <path
            d="M120 248 C133 232 154 222 175 230"
            fill="none"
            stroke="rgba(134,239,172,0.42)"
            strokeWidth={1}
            strokeLinecap="round"
          />
          <path
            d="M300 248 C287 232 266 222 245 230"
            fill="none"
            stroke="rgba(134,239,172,0.42)"
            strokeWidth={1}
            strokeLinecap="round"
          />
          {/* Shoulder rivet nodes */}
          <circle cx={146} cy={247} r={1.4} fill="rgba(252,211,77,0.65)" />
          <circle cx={274} cy={247} r={1.4} fill="rgba(252,211,77,0.65)" />
        </g>
      </g>

      <motion.g
        style={{
          x: headX,
          y: headY,
          rotate: headRotate,
          rotateX: headPitch,
          transformBox: "view-box",
          transformOrigin: "210px 163px",
          transformPerspective: 900,
        }}
      >
        <path
          d="M157 154 C157 111 179 82 210 82 C241 82 263 111 263 154 V183 C263 202 249 222 228 231 H192 C171 222 157 202 157 183 Z"
          fill="url(#agent-body-gradient)"
          stroke="rgba(167,243,208,0.32)"
          strokeWidth={1.7}
        />
        <path
          d="M171 142 L190 127 H230 L249 142 L242 181 L225 203 H195 L178 181 Z"
          fill="rgba(3, 7, 10, 0.42)"
          stroke="rgba(52,211,153,0.18)"
          strokeWidth={1.2}
        />
        <path
          d="M176 139 H244"
          fill="none"
          stroke="rgba(167,243,208,0.45)"
          strokeLinecap="round"
          strokeWidth={2}
        />
        <path
          d="M181 199 C194 207 226 207 239 199"
          fill="none"
          stroke="rgba(252,211,77,0.44)"
          strokeLinecap="round"
          strokeWidth={1.4}
        />
        <path
          d="M173 116 C184 100 196 94 210 94 C224 94 236 100 247 116"
          fill="none"
          stroke="rgba(52,211,153,0.28)"
          strokeLinecap="round"
          strokeWidth={1.2}
        />
        {/* Helmet crown — thin emerald rim across the top, with two
            golden focal nodes flanking the centre. Reads as helmet
            articulation without obscuring the cursor-tracking eyes. */}
        <path
          d="M165 110 C182 92 196 84 210 84 C224 84 238 92 255 110"
          fill="none"
          stroke="rgba(134,239,172,0.55)"
          strokeLinecap="round"
          strokeWidth={1.4}
        />
        <circle cx={186} cy={101} r={1.4} fill="rgba(252,211,77,0.72)" />
        <circle cx={234} cy={101} r={1.4} fill="rgba(252,211,77,0.72)" />
        {/* Cheek panel seams */}
        <path
          d="M170 165 L165 195 M250 165 L255 195"
          fill="none"
          stroke="rgba(167,243,208,0.32)"
          strokeWidth={0.9}
          strokeLinecap="round"
        />
        <AgentEye cx={190} cy={165} cursorX={cursorX} cursorY={cursorY} />
        <AgentEye cx={230} cy={165} cursorX={cursorX} cursorY={cursorY} />
        <path
          d="M204 183 H216"
          stroke="rgba(209,250,229,0.36)"
          strokeLinecap="round"
          strokeWidth={1.2}
        />
        {/* Chin guard accent */}
        <path
          d="M198 209 L210 218 L222 209"
          fill="none"
          stroke="rgba(134,239,172,0.42)"
          strokeWidth={1}
          strokeLinecap="round"
        />
      </motion.g>

      {children}
    </svg>
  );
}
