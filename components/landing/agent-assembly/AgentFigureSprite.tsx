"use client";

import { type ReactNode } from "react";
import { motion, useTime, useTransform, type MotionValue } from "framer-motion";

/**
 * HolographicAgent — pure-SVG, fully-owned holographic humanoid.
 *
 * Replaces the third-party PNG slices. Every pixel is generated from
 * primitives we control: 10 install groups map 1:1 to the OASIS subsystem
 * manifest, then a compaction beat locks the figure into its "system online"
 * state. The figure is parametric — colour, stroke weight, glow, anatomy
 * coords all live in this file.
 *
 * Sizing contract: render at the natural viewBox aspect (2:3); the scene
 * wrapper constrains the OUTER container to viewport height so this never
 * overflows.
 *
 * Motion philosophy: install motion is confident (snap-in, gentle settle).
 * Once a layer is installed, it LOCKS — no idle wobble, no cursor float.
 * Aliveness comes from light travelling along connection lines and the
 * central reasoning-core pulse, not from anatomical drift.
 */

export const SPRITE_LAYER_COUNT = 10;

const VB_W = 480;
const VB_H = 720;

const C = {
  primary: "#86efac",
  primarySoft: "rgba(134,239,172,0.55)",
  primaryFaint: "rgba(134,239,172,0.18)",
  accent: "#5eead4",
  accentSoft: "rgba(94,234,212,0.5)",
  warm: "#fcd34d",
  warmSoft: "rgba(252,211,77,0.55)",
  shell: "rgba(167,243,208,0.92)",
  bg: "#03070a",
} as const;

type Props = {
  installProgresses: MotionValue<number>[];
  compactionProgress: MotionValue<number>;
  forceInstalled?: boolean;
  className?: string;
};

export function AgentFigureSprite({
  installProgresses,
  compactionProgress,
  forceInstalled = false,
  className,
}: Props) {
  if (installProgresses.length !== SPRITE_LAYER_COUNT) {
    throw new Error(
      `AgentFigureSprite expects ${SPRITE_LAYER_COUNT} installProgresses, got ${installProgresses.length}`,
    );
  }

  const [
    reasoningCore,
    statePulse,
    memorySpine,
    browserOptics,
    bridgeTools,
    guardShield,
    outputChannels,
    securityMesh,
    businessLayer,
    commandCentre,
  ] = installProgresses;

  return (
    <div className={className} style={{ position: "relative", width: "100%", aspectRatio: `${VB_W} / ${VB_H}` }}>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        height="100%"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block", overflow: "visible" }}
      >
        <Defs />

        {/* WHOLE-FIGURE LOCK CLICK — a 6% scale punch at the compaction
            midpoint reads as the pieces "snapping together" mechanically. */}
        <LockClickGroup compactionProgress={compactionProgress} forceInstalled={forceInstalled}>
          {/* PAINT ORDER (bottom → top). Anatomy stacks behind, HUD on top. */}
          <Wireframe compactionProgress={compactionProgress} forceInstalled={forceInstalled} />

          <InstallGroup progress={commandCentre} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: -20, y: 80, rotate: -4, scale: 0.7 }}>
            <ActivationPlatform compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
          </InstallGroup>

          <InstallGroup progress={memorySpine} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: -60, y: 40, rotate: -6, scale: 0.7 }}>
            <MemorySpine compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
          </InstallGroup>

          <InstallGroup progress={outputChannels} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: -110, y: -30, rotate: -10, scale: 0.6 }}>
            <Arms compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
          </InstallGroup>

          <InstallGroup progress={statePulse} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: 95, y: -20, rotate: 9, scale: 0.55 }}>
            <StatePulse compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
          </InstallGroup>

          <InstallGroup progress={guardShield} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: 80, y: 60, rotate: 7, scale: 0.55 }}>
            <GuardShield compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
          </InstallGroup>

          <InstallGroup progress={bridgeTools} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: -130, y: 30, rotate: -14, scale: 0.45 }}>
            <BridgeTools compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
          </InstallGroup>

          <InstallGroup progress={businessLayer} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: -70, y: -50, rotate: -8, scale: 0.4 }}>
            <BusinessBadge />
          </InstallGroup>

          <InstallGroup progress={reasoningCore} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: 50, y: -110, rotate: 8, scale: 0.5 }}>
            <ReasoningCore compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
          </InstallGroup>

          <InstallGroup progress={browserOptics} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: 90, y: -70, rotate: 12, scale: 0.6 }}>
            <BrowserOptics compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
          </InstallGroup>

          <InstallGroup progress={securityMesh} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: 0, y: 0, rotate: 6, scale: 1.18 }}>
            <SecurityMesh />
          </InstallGroup>

          <InstallGroup progress={commandCentre} compactionProgress={compactionProgress} forceInstalled={forceInstalled} from={{ x: 30, y: -40, rotate: 4, scale: 0.92 }}>
            <HudFrame compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
          </InstallGroup>

          <CompactionLinks compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
        </LockClickGroup>

        <Scanline forceInstalled={forceInstalled} compactionProgress={compactionProgress} />
        <LockInFlash compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
      </svg>
    </div>
  );
}

/* ─────────────────────────────  install wrapper  ───────────────────────── */

/**
 * InstallGroup — wraps a subsystem with the install + compaction motion.
 *
 * Two-phase motion:
 *   1. INSTALL — piece fades in AT its scattered "from" offset (mild bob
 *      from 1.8x → 1.0x of the offset). It does NOT travel to home yet.
 *   2. COMPACTION — once compactionProgress > 0, piece smoothly converges
 *      from its scattered resting position toward home (0, 0, 0, 1).
 *      At compaction = 1, all pieces are at exact anatomical positions.
 *
 * The result: during scroll the figure reads as scattered fragments
 * gradually materialising; at the compaction beat they visibly snap
 * together into a coherent humanoid.
 */
function InstallGroup({
  progress,
  compactionProgress,
  forceInstalled,
  from,
  children,
}: {
  progress: MotionValue<number>;
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
  from: { x: number; y: number; rotate: number; scale: number };
  children: ReactNode;
}) {
  const opacity = useTransform(progress, [0, 0.18, 0.55, 1], [0, 0.45, 0.92, 1]);

  // Scattered resting position the piece settles into after install.
  const restX = useTransform(progress, [0, 0.6, 1], [from.x * 1.8, from.x * 1.1, from.x]);
  const restY = useTransform(progress, [0, 0.6, 1], [from.y * 1.8, from.y * 1.1, from.y]);
  const restRot = useTransform(progress, [0, 0.6, 1], [from.rotate * 1.8, from.rotate * 1.1, from.rotate]);
  const restScale = useTransform(progress, [0, 0.6, 1], [from.scale * 0.78, from.scale * 1.04, from.scale]);

  // Ease-in-out the compaction lerp so the merger feels mechanical, not linear.
  const c = useTransform(compactionProgress, (v) => {
    const t = v as number;
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  });

  const x = useTransform([restX, c] as const, ([rx, ce]) => (rx as number) * (1 - (ce as number)));
  const y = useTransform([restY, c] as const, ([ry, ce]) => (ry as number) * (1 - (ce as number)));
  const rotate = useTransform([restRot, c] as const, ([rr, ce]) => (rr as number) * (1 - (ce as number)));
  const scale = useTransform([restScale, c] as const, ([rs, ce]) => {
    const s = rs as number;
    const e = ce as number;
    return s + (1 - s) * e;
  });

  if (forceInstalled) return <g>{children}</g>;

  return (
    <motion.g
      style={{
        opacity,
        x,
        y,
        rotate,
        scale,
        transformBox: "fill-box",
        transformOrigin: "center",
      }}
    >
      {children}
    </motion.g>
  );
}

/* ─────────────────────────────  lock-click group  ───────────────────────── */

/**
 * Wraps the whole figure. At the compaction midpoint (~50%) it punches up
 * by 6% then settles — the "click" of fragments snapping into one body.
 */
function LockClickGroup({
  compactionProgress,
  forceInstalled,
  children,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
  children: ReactNode;
}) {
  const scale = useTransform(compactionProgress, [0, 0.35, 0.55, 0.75, 1], [1, 1, 1.06, 0.985, 1]);
  if (forceInstalled) return <g>{children}</g>;
  return (
    <motion.g style={{ scale, transformBox: "fill-box", transformOrigin: "center" }}>{children}</motion.g>
  );
}

/* ─────────────────────────────  compaction links  ───────────────────────── */

/**
 * Network of electric lines wiring subsystems together. Pre-compaction:
 * invisible. As compactionProgress crosses 0.2 → 1, each line draws in
 * (stroke-dashoffset) and brightens, reading as the parts "wiring up"
 * into a single integrated agent at the moment of lock-in.
 */
function CompactionLinks({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  // Each line gets its own dash window so they light up in sequence.
  const segs = [
    { d: "M 240 178 L 240 240", start: 0.18, end: 0.4 }, // head → chest
    { d: "M 240 280 L 240 408", start: 0.25, end: 0.5 }, // chest → shield base
    { d: "M 184 320 L 110 420", start: 0.32, end: 0.62 }, // left torso → left hand
    { d: "M 296 320 L 370 420", start: 0.32, end: 0.62 }, // right torso → right hand
    { d: "M 110 420 L 200 690", start: 0.4, end: 0.72 }, // left hand → base
    { d: "M 370 420 L 280 690", start: 0.4, end: 0.72 }, // right hand → base
    { d: "M 240 440 L 240 692", start: 0.5, end: 0.82 }, // spine → platform centre
  ];

  if (forceInstalled) {
    return (
      <g stroke={C.primary} strokeWidth={0.9} fill="none" opacity={0.85} filter="url(#hg-glow)">
        {segs.map((s) => (
          <path key={s.d} d={s.d} />
        ))}
      </g>
    );
  }

  return (
    <g fill="none">
      {segs.map((s) => (
        <CompactionLink key={s.d} d={s.d} start={s.start} end={s.end} compactionProgress={compactionProgress} />
      ))}
    </g>
  );
}

function CompactionLink({
  d,
  start,
  end,
  compactionProgress,
}: {
  d: string;
  start: number;
  end: number;
  compactionProgress: MotionValue<number>;
}) {
  // 0 = full dash hidden, 1 = no dash (line drawn in). Drawn between
  // [start, end] of compactionProgress.
  const drawn = useTransform(compactionProgress, [start, end], [0, 1], { clamp: true });
  const opacity = useTransform(compactionProgress, [start, (start + end) / 2, 1], [0, 0.6, 1]);
  // 200-unit pathLength approximation via dasharray.
  const offset = useTransform(drawn, (v) => 200 - (v as number) * 200);
  return (
    <motion.path
      d={d}
      stroke={C.primary}
      strokeWidth={1}
      strokeLinecap="round"
      pathLength={200}
      strokeDasharray="200 200"
      filter="url(#hg-glow)"
      style={{ strokeDashoffset: offset, opacity }}
    />
  );
}

/* ─────────────────────────────  defs  ──────────────────────────────────── */

function Defs() {
  return (
    <defs>
      <filter id="hg-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.5" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id="hg-glow-soft" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <linearGradient id="hg-spine" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor={C.accent} stopOpacity="0.85" />
        <stop offset="50%" stopColor={C.primary} stopOpacity="0.9" />
        <stop offset="100%" stopColor={C.warm} stopOpacity="0.7" />
      </linearGradient>
      <radialGradient id="hg-core" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
        <stop offset="35%" stopColor={C.primary} stopOpacity="0.9" />
        <stop offset="100%" stopColor={C.primary} stopOpacity="0" />
      </radialGradient>
      <radialGradient id="hg-platform" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor={C.primary} stopOpacity="0.7" />
        <stop offset="80%" stopColor={C.primary} stopOpacity="0.1" />
        <stop offset="100%" stopColor={C.primary} stopOpacity="0" />
      </radialGradient>
      <pattern id="hg-mesh" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="14" stroke={C.primary} strokeWidth="0.5" strokeOpacity="0.32" />
        <line x1="0" y1="0" x2="14" y2="0" stroke={C.primary} strokeWidth="0.5" strokeOpacity="0.32" />
      </pattern>
      <clipPath id="hg-body-clip">
        <BodySilhouettePath />
      </clipPath>
      <linearGradient id="hg-scan" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor={C.primary} stopOpacity="0" />
        <stop offset="50%" stopColor={C.primary} stopOpacity="0.7" />
        <stop offset="100%" stopColor={C.primary} stopOpacity="0" />
      </linearGradient>
    </defs>
  );
}

function BodySilhouettePath() {
  // Coarse humanoid envelope used as clipPath for the security mesh and
  // anywhere we want the overlay to read only inside the body.
  return (
    <path
      d="
        M 240 50
        C 280 50 300 80 300 115
        C 300 140 285 160 268 168
        L 312 215
        L 360 235
        L 388 410
        L 360 432
        L 318 410
        L 305 460
        L 300 600
        L 290 700
        L 258 700
        L 252 600
        L 240 480
        L 228 600
        L 222 700
        L 190 700
        L 180 600
        L 175 460
        L 162 410
        L 120 432
        L 92 410
        L 120 235
        L 168 215
        L 212 168
        C 195 160 180 140 180 115
        C 180 80 200 50 240 50
        Z
      "
    />
  );
}

/* ─────────────────────────────  base wireframe  ─────────────────────────── */

function Wireframe({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  // Always-visible faint outline of the humanoid envelope. Acts as the
  // anchor so the figure has presence pre-scroll. Brightens at compaction.
  const opacity = useTransform(compactionProgress, [0, 1], [0.18, 0.42]);
  const strokeWidth = useTransform(compactionProgress, [0, 1], [0.6, 1.1]);

  if (forceInstalled) {
    return (
      <g stroke={C.primary} strokeWidth={1.1} fill="none" opacity={0.42}>
        <BodySilhouettePath />
      </g>
    );
  }

  return (
    <motion.g style={{ opacity, strokeWidth }} fill="none" stroke={C.primary}>
      <BodySilhouettePath />
    </motion.g>
  );
}

/* ─────────────────────────────  layer: reasoning core (head)  ───────────── */

function ReasoningCore({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const time = useTime();
  // Steady pulse on the central reasoning node — alive but not floating.
  const pulse = useTransform(time, (t) => {
    const s = (t as number) / 1000;
    return 0.78 + Math.sin(s * 2.2) * 0.22;
  });
  const lock = useTransform(compactionProgress, [0, 1], [1, 1.18]);

  // Hexagonal head outline at (240, 110) with circumradius 60.
  const cx = 240;
  const cy = 110;
  const r = 60;
  const hexPath = hexagonPath(cx, cy, r);
  const innerHexPath = hexagonPath(cx, cy, r * 0.62);

  return (
    <g>
      <path d={hexPath} fill="none" stroke={C.primary} strokeWidth={1.6} filter="url(#hg-glow)" />
      <path d={innerHexPath} fill="none" stroke={C.accent} strokeWidth={1} opacity={0.7} />
      {/* Neural cluster — 6 satellites + 1 central node. */}
      {[0, 60, 120, 180, 240, 300].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        const x = cx + Math.cos(rad) * 26;
        const y = cy + Math.sin(rad) * 26;
        return (
          <g key={deg}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke={C.primarySoft} strokeWidth={0.8} />
            <circle cx={x} cy={y} r={2.2} fill={C.primary} />
          </g>
        );
      })}
      {/* Central pulsing core. */}
      {forceInstalled ? (
        <circle cx={cx} cy={cy} r={8} fill="url(#hg-core)" />
      ) : (
        <motion.circle cx={cx} cy={cy} r={8} fill="url(#hg-core)" style={{ opacity: pulse, scale: lock, transformBox: "fill-box", transformOrigin: "center" }} />
      )}
      <circle cx={cx} cy={cy} r={3} fill="#ffffff" />
    </g>
  );
}

function hexagonPath(cx: number, cy: number, r: number) {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return `M ${pts[0]} L ${pts.slice(1).join(" L ")} Z`;
}

/* ─────────────────────────────  layer: state pulse  ─────────────────────── */

function StatePulse({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const time = useTime();
  const dashOffset = useTransform(time, (t) => -((t as number) / 32) % 200);
  const lockOpacity = useTransform(compactionProgress, [0, 1], [0.85, 1]);

  // Heartbeat trace running across the chest, between (170,290) and (310,290).
  const path = "M 170 290 L 200 290 L 210 275 L 220 305 L 235 270 L 250 310 L 265 290 L 310 290";

  return (
    <g style={{ opacity: forceInstalled ? 1 : undefined }}>
      <path d={path} stroke={C.primaryFaint} strokeWidth={2.5} fill="none" />
      {forceInstalled ? (
        <path d={path} stroke={C.primary} strokeWidth={1.6} fill="none" filter="url(#hg-glow)" />
      ) : (
        <motion.path
          d={path}
          stroke={C.primary}
          strokeWidth={1.6}
          fill="none"
          strokeDasharray="20 6"
          filter="url(#hg-glow)"
          style={{ strokeDashoffset: dashOffset, opacity: lockOpacity }}
        />
      )}
      {/* Central pulse node sits at solar plexus. */}
      <circle cx={240} cy={290} r={4} fill={C.warm} filter="url(#hg-glow)" />
    </g>
  );
}

/* ─────────────────────────────  layer: memory spine  ────────────────────── */

function MemorySpine({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const opacity = useTransform(compactionProgress, [0, 1], [0.85, 1]);

  // Spine column from neck (240,180) to pelvis (240,460), 6 stacked rings.
  const ringYs = [200, 240, 280, 320, 360, 400, 440];

  return (
    <motion.g style={{ opacity: forceInstalled ? 1 : opacity }}>
      <line x1={240} y1={180} x2={240} y2={460} stroke="url(#hg-spine)" strokeWidth={1.8} />
      {ringYs.map((y, i) => (
        <g key={y}>
          <ellipse cx={240} cy={y} rx={18} ry={3.2} fill="none" stroke={C.accent} strokeWidth={1} opacity={0.55 + i * 0.04} />
          <circle cx={222} cy={y} r={1.6} fill={C.accent} />
          <circle cx={258} cy={y} r={1.6} fill={C.accent} />
        </g>
      ))}
    </motion.g>
  );
}

/* ─────────────────────────────  layer: browser optics  ──────────────────── */

function BrowserOptics({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const time = useTime();
  // Scan pulse drifts across the visor.
  const dashOffset = useTransform(time, (t) => -((t as number) / 18) % 80);
  const lock = useTransform(compactionProgress, [0, 1], [0.9, 1]);

  return (
    <motion.g style={{ opacity: forceInstalled ? 1 : lock }}>
      {/* Visor band across the head at y ≈ 100. */}
      <rect x={188} y={92} width={104} height={16} rx={2} fill={C.bg} stroke={C.accent} strokeWidth={1.2} />
      {forceInstalled ? (
        <rect x={188} y={92} width={104} height={16} rx={2} fill="none" stroke={C.primary} strokeWidth={1} opacity={0.85} />
      ) : (
        <motion.rect
          x={188}
          y={92}
          width={104}
          height={16}
          rx={2}
          fill="none"
          stroke={C.primary}
          strokeWidth={1}
          strokeDasharray="8 4"
          style={{ strokeDashoffset: dashOffset }}
        />
      )}
      {/* Two eye nodes inside the visor. */}
      <circle cx={216} cy={100} r={3} fill={C.primary} filter="url(#hg-glow)" />
      <circle cx={264} cy={100} r={3} fill={C.primary} filter="url(#hg-glow)" />
    </motion.g>
  );
}

/* ─────────────────────────────  layer: bridge tools  ────────────────────── */

function BridgeTools({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const time = useTime();
  const rot = useTransform(time, (t) => ((t as number) / 28) % 360);
  const lock = useTransform(compactionProgress, [0, 1], [0.9, 1]);

  const leftHand = { x: 96, y: 425 };
  const rightHand = { x: 384, y: 425 };

  const renderCluster = (hx: number, hy: number, key: string) => (
    <g key={key}>
      <circle cx={hx} cy={hy} r={14} fill="none" stroke={C.primary} strokeWidth={1.1} />
      <circle cx={hx} cy={hy} r={6} fill="none" stroke={C.accent} strokeWidth={0.9} opacity={0.75} />
      <circle cx={hx} cy={hy} r={2.2} fill={C.warm} filter="url(#hg-glow)" />
      {forceInstalled ? (
        <g>
          <circle cx={hx + 14} cy={hy} r={1.4} fill={C.primary} />
          <circle cx={hx - 14} cy={hy} r={1.4} fill={C.primary} />
          <circle cx={hx} cy={hy + 14} r={1.4} fill={C.primary} />
        </g>
      ) : (
        <motion.g style={{ rotate: rot, transformBox: "fill-box", transformOrigin: "center" }}>
          <circle cx={hx + 14} cy={hy} r={1.4} fill={C.primary} />
          <circle cx={hx - 14} cy={hy} r={1.4} fill={C.primary} />
          <circle cx={hx} cy={hy + 14} r={1.4} fill={C.primary} />
        </motion.g>
      )}
    </g>
  );

  return (
    <motion.g style={{ opacity: forceInstalled ? 1 : lock }}>
      {renderCluster(leftHand.x, leftHand.y, "left")}
      {renderCluster(rightHand.x, rightHand.y, "right")}
    </motion.g>
  );
}

/* ─────────────────────────────  layer: guard shield  ────────────────────── */

function GuardShield({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const lock = useTransform(compactionProgress, [0, 1], [0.7, 1]);

  // Shield silhouette spanning chest 200..280, 240..400.
  const shield =
    "M 240 240 L 296 256 L 296 340 C 296 372 272 392 240 408 C 208 392 184 372 184 340 L 184 256 Z";

  return (
    <motion.g style={{ opacity: forceInstalled ? 1 : lock }}>
      <path d={shield} fill={C.primaryFaint} stroke={C.primary} strokeWidth={1.4} filter="url(#hg-glow)" />
      <line x1={240} y1={240} x2={240} y2={408} stroke={C.accent} strokeWidth={0.9} />
      <path
        d="M 240 280 L 264 300 L 252 330 L 228 330 L 216 300 Z"
        fill="none"
        stroke={C.warm}
        strokeWidth={1}
        opacity={0.85}
      />
    </motion.g>
  );
}

/* ─────────────────────────────  layer: output (arms + comms)  ───────────── */

function Arms({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const time = useTime();
  // Expanding comm arcs above head.
  const arc1 = useTransform(time, (t) => 0.35 + ((((t as number) / 14) % 60) / 60) * 0.4);
  const arc2 = useTransform(time, (t) => 0.2 + ((((t as number) / 14 + 20) % 60) / 60) * 0.35);
  const lock = useTransform(compactionProgress, [0, 1], [0.9, 1]);

  // Arm polylines: shoulder → elbow → hand.
  const leftArm = "M 168 215 L 130 330 L 96 425";
  const rightArm = "M 312 215 L 350 330 L 384 425";

  return (
    <motion.g style={{ opacity: forceInstalled ? 1 : lock }}>
      <path d={leftArm} fill="none" stroke={C.primary} strokeWidth={2} strokeLinecap="round" filter="url(#hg-glow)" />
      <path d={rightArm} fill="none" stroke={C.primary} strokeWidth={2} strokeLinecap="round" filter="url(#hg-glow)" />
      {/* Joints. */}
      <circle cx={168} cy={215} r={3} fill={C.primary} />
      <circle cx={130} cy={330} r={2.4} fill={C.accent} />
      <circle cx={312} cy={215} r={3} fill={C.primary} />
      <circle cx={350} cy={330} r={2.4} fill={C.accent} />

      {/* Comm arcs above head — three expanding semicircles. */}
      {forceInstalled ? (
        <g fill="none" stroke={C.accent} strokeWidth={1} opacity={0.55}>
          <path d="M 200 80 A 40 40 0 0 1 280 80" />
          <path d="M 184 60 A 56 56 0 0 1 296 60" opacity={0.4} />
        </g>
      ) : (
        <g fill="none" stroke={C.accent} strokeWidth={1}>
          <motion.path d="M 200 80 A 40 40 0 0 1 280 80" style={{ opacity: arc1 }} />
          <motion.path d="M 184 60 A 56 56 0 0 1 296 60" style={{ opacity: arc2 }} />
        </g>
      )}
    </motion.g>
  );
}

/* ─────────────────────────────  layer: security mesh  ───────────────────── */

function SecurityMesh() {
  // Diamond mesh clipped to body silhouette — reads as a security envelope.
  return (
    <g clipPath="url(#hg-body-clip)" opacity={0.7}>
      <rect x={0} y={0} width={VB_W} height={VB_H} fill="url(#hg-mesh)" />
    </g>
  );
}

/* ─────────────────────────────  layer: business badge  ──────────────────── */

function BusinessBadge() {
  // OASIS badge on upper chest.
  return (
    <g>
      <rect x={216} y={224} width={48} height={16} rx={2} fill={C.bg} stroke={C.warm} strokeWidth={1} />
      <text x={240} y={235} textAnchor="middle" fontFamily="monospace" fontSize={9} fill={C.warm} letterSpacing="1.4">
        OASIS
      </text>
    </g>
  );
}

/* ─────────────────────────────  activation platform  ────────────────────── */

function ActivationPlatform({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const time = useTime();
  const pulseScale = useTransform(time, (t) => 1 + Math.sin(((t as number) / 1000) * 1.4) * 0.04);
  const lockGlow = useTransform(compactionProgress, [0, 1], [0.5, 0.95]);

  return (
    <g>
      {/* Glow disc. */}
      <ellipse cx={240} cy={696} rx={150} ry={26} fill="url(#hg-platform)" />
      {/* Three concentric rings. */}
      <ellipse cx={240} cy={702} rx={134} ry={12} fill="none" stroke={C.primary} strokeWidth={1.4} filter="url(#hg-glow)" />
      <ellipse cx={240} cy={702} rx={104} ry={9} fill="none" stroke={C.accent} strokeWidth={1.1} opacity={0.75} />
      {forceInstalled ? (
        <ellipse cx={240} cy={702} rx={70} ry={6} fill="none" stroke={C.warm} strokeWidth={1} opacity={0.85} />
      ) : (
        <motion.ellipse
          cx={240}
          cy={702}
          rx={70}
          ry={6}
          fill="none"
          stroke={C.warm}
          strokeWidth={1}
          style={{ opacity: lockGlow, scale: pulseScale, transformBox: "fill-box", transformOrigin: "center" }}
        />
      )}
      {/* Tick marks around outer ring. */}
      {Array.from({ length: 24 }).map((_, i) => {
        const a = (i / 24) * Math.PI * 2;
        const x1 = 240 + Math.cos(a) * 138;
        const y1 = 702 + Math.sin(a) * 14;
        const x2 = 240 + Math.cos(a) * 146;
        const y2 = 702 + Math.sin(a) * 17;
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.primary} strokeWidth={0.5} opacity={0.55} />;
      })}
    </g>
  );
}

/* ─────────────────────────────  hud frame  ──────────────────────────────── */

function HudFrame({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const lockOpacity = useTransform(compactionProgress, [0, 1], [0.7, 1]);
  // Four L-shaped corner brackets and ONLINE badge at base.
  return (
    <motion.g style={{ opacity: forceInstalled ? 1 : lockOpacity }} stroke={C.primary} strokeWidth={1.4} fill="none">
      {/* Top-left */}
      <path d="M 10 30 L 10 10 L 38 10" />
      {/* Top-right */}
      <path d="M 442 10 L 470 10 L 470 30" />
      {/* Bottom-left */}
      <path d="M 10 690 L 10 710 L 38 710" />
      {/* Bottom-right */}
      <path d="M 442 710 L 470 710 L 470 690" />

      {/* Online status pill. */}
      <g transform="translate(190 660)">
        <rect x={0} y={0} width={100} height={20} rx={2} fill={C.bg} stroke={C.primary} strokeWidth={1} />
        <circle cx={12} cy={10} r={3.2} fill={C.primary} filter="url(#hg-glow)" />
        <text x={22} y={14} fontFamily="monospace" fontSize={9} fill={C.primary} letterSpacing="2">
          SYSTEM ONLINE
        </text>
      </g>
    </motion.g>
  );
}

/* ─────────────────────────────  scanline  ───────────────────────────────── */

function Scanline({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const time = useTime();
  // Sweeps top → bottom every 4.2s. Locks centered after compaction.
  const yPre = useTransform(time, (t) => ((((t as number) / 4200) % 1) * (VB_H + 40)) - 20);
  const y = useTransform([yPre, compactionProgress] as const, ([raw, c]) => {
    if ((c as number) >= 0.95) return VB_H / 2 - 12;
    return raw as number;
  });
  const opacity = useTransform(compactionProgress, [0, 0.95, 1], [0.45, 0.45, 0.15]);

  if (forceInstalled) return null;

  return <motion.rect x={0} width={VB_W} height={24} fill="url(#hg-scan)" style={{ y, opacity }} clipPath="url(#hg-body-clip)" />;
}

/* ─────────────────────────────  lock-in flash  ──────────────────────────── */

function LockInFlash({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  // Three concentric rings expanding from the chest at lock-in,
  // staggered so the burst reads as a "system online" pulse and not a
  // single drifting circle.
  const r1 = useTransform(compactionProgress, [0.35, 0.95], [30, 280]);
  const o1 = useTransform(compactionProgress, [0.35, 0.6, 0.95], [0, 0.7, 0]);
  const r2 = useTransform(compactionProgress, [0.45, 1], [20, 380]);
  const o2 = useTransform(compactionProgress, [0.45, 0.7, 1], [0, 0.55, 0]);
  const r3 = useTransform(compactionProgress, [0.55, 1], [10, 220]);
  const o3 = useTransform(compactionProgress, [0.55, 0.8, 1], [0, 0.45, 0]);

  if (forceInstalled) return null;

  return (
    <g fill="none" stroke={C.primary} filter="url(#hg-glow-soft)">
      <motion.circle cx={240} cy={320} strokeWidth={2.2} style={{ r: r1, opacity: o1 }} />
      <motion.circle cx={240} cy={320} strokeWidth={1.4} style={{ r: r2, opacity: o2 }} stroke={C.accent} />
      <motion.circle cx={240} cy={320} strokeWidth={1.6} style={{ r: r3, opacity: o3 }} stroke={C.warm} />
    </g>
  );
}
