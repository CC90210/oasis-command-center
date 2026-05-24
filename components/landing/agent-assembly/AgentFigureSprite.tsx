"use client";

import Image from "next/image";
import { type ReactNode } from "react";
import { motion, useTime, useTransform, type MotionValue } from "framer-motion";

/**
 * AgentFigureSprite — photoreal scroll-driven agent assembly.
 *
 * Renders 10 transparent PNG slices of a humanoid agent figure (sliced from
 * the ChatGPT reference render) layered with scatter-then-compact motion:
 *
 *  - INSTALL phase: each slice fades in AT a scattered offset (50-130px
 *    from anatomical home, with mild rotation) and FLOATS continuously in
 *    place (sin/cos drift on its own phase seed). Reads as exploded-view
 *    blueprint fragments suspended in space, alive but unbound.
 *  - COMPACTION phase (last scroll beat): every slice converges from its
 *    scattered + floating position toward home via an ease-in-out lerp;
 *    the whole figure punches +6% scale ("lock click"); 7 connection
 *    lines draw in sequence wiring subsystems together, each chased by a
 *    travelling pulse; a triple-ring burst confirms SYSTEM ONLINE; a
 *    single center shockwave fires as the final exhale; the solid base
 *    PNG fades in for the fully-assembled lock.
 *  - REDUCED-MOTION: forceInstalled short-circuits to a static fully-
 *    assembled view (agent-solid PNG + SYSTEM ONLINE overlay).
 *
 * Sizing: parent constrains by HEIGHT (e.g. h-[min(78vh,620px)]); the
 * figure aspect-ratio (521:1536) yields a narrow humanoid column that
 * always fits the viewport.
 */

export const SPRITE_LAYER_COUNT = 10;

// Source PNG dimensions — used as the SVG overlay viewBox so connection
// lines and lock-in flashes share coordinate space with the figure.
// Updated 2026-05-24 — new figure is the OASIS AI standing humanoid
// (cropped + alpha-cut from the May 24 ChatGPT reference, 540x1435).
const PNG_W = 540;
const PNG_H = 1435;

const C = {
  primary: "#86efac",
  accent: "#5eead4",
  warm: "#fcd34d",
} as const;

type Scatter = { x: number; y: number; rotate: number; scale: number };

type LayerSpec = {
  /** PNG basename (no extension) inside /public/welcome/parts/ */
  file: string;
  /** Index into installProgresses (manifest order: 0=Reasoning Core ... 9=Command Centre). */
  manifestIdx: number;
  /** Offset (in CSS px relative to dock) the slice rests at while scattered. */
  scatter: Scatter;
};

// PAINT ORDER: bottom (activation podium) → top (head). Z-stacking matches
// the original photoreal slice order so foreground parts land last.
// manifestIdx is the SUBSYSTEM order from MODULE_MANIFEST in the scene.
//
// SCATTER LAYOUT (rebuilt 2026-05-24 for new standing-humanoid figure):
// Each slice gets HORIZONTAL displacement only (small ±Y for separation).
// The figure is a tall narrow column; pushing slices SIDEWAYS off the body
// reads cleaner than pushing them up/down (where they'd collide with the
// next slice's dock anyway). X-offsets alternate L/R every step so adjacent
// slices in the body chain go opposite directions — clear orbital read.
// Scales 0.78-0.95 keep parts big and recognizable. Rotations ±13° give
// the field life without anyone looking "tipped over".
const LAYERS: LayerSpec[] = [
  { file: "10-activation",      manifestIdx: 9, scatter: { x: -180, y: 60,   rotate: -6,  scale: 0.85 } }, // podium → bottom-left
  { file: "09-body-pelvis",     manifestIdx: 8, scatter: { x: 200,  y: 40,   rotate: 8,   scale: 0.85 } }, // feet → bottom-right
  { file: "08-ethics-hip",      manifestIdx: 7, scatter: { x: -210, y: -10,  rotate: -9,  scale: 0.88 } }, // calves → mid-bot-left
  { file: "07-communication",   manifestIdx: 6, scatter: { x: 220,  y: 0,    rotate: 10,  scale: 0.90 } }, // thighs → mid-bot-right
  { file: "06-reasoning-torso", manifestIdx: 5, scatter: { x: -220, y: 20,   rotate: -11, scale: 0.92 } }, // hips → mid-left
  { file: "05-sensors",         manifestIdx: 4, scatter: { x: 230,  y: -10,  rotate: 12,  scale: 0.92 } }, // abdomen → mid-right
  { file: "04-memory-ring",     manifestIdx: 3, scatter: { x: -210, y: -20,  rotate: -10, scale: 0.90 } }, // lower chest → upper-left
  { file: "03-neural-disc",     manifestIdx: 2, scatter: { x: 200,  y: 30,   rotate: 11,  scale: 0.88 } }, // upper chest → upper-right
  { file: "02-neural-cube",     manifestIdx: 1, scatter: { x: -160, y: 80,   rotate: -7,  scale: 0.82 } }, // neck → top-left (lower)
  { file: "01-head",            manifestIdx: 0, scatter: { x: 170,  y: 70,   rotate: 9,   scale: 0.85 } }, // head → top-right (lower)
];

// next/image sizes hint — the figure column never exceeds ~25vw on desktop.
const IMG_SIZES = "(max-width: 640px) 70vw, (max-width: 1024px) 30vw, 25vw";

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

  return (
    <div className={className} style={{ position: "relative", width: "100%", height: "100%" }}>
      <SolidLayer compactionProgress={compactionProgress} forceInstalled={forceInstalled} />

      <LockClickWrapper compactionProgress={compactionProgress} forceInstalled={forceInstalled}>
        {LAYERS.map((layer) => (
          <InstallLayer
            key={layer.file}
            layer={layer}
            installProgress={installProgresses[layer.manifestIdx]}
            compactionProgress={compactionProgress}
            forceInstalled={forceInstalled}
          />
        ))}
      </LockClickWrapper>

      {/* SVG overlays — share PNG coordinate space (viewBox 521x1536) so
          connection lines and lock-in rings land on the right anatomy. */}
      <svg
        viewBox={`0 0 ${PNG_W} ${PNG_H}`}
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          overflow: "visible",
        }}
      >
        <Defs />
        <CompactionLinks compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
        <LinkPulses compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
        <LockInFlash compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
        <CenterShockwave compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
        <SystemOnlinePill compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
        <Scanline compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
      </svg>
    </div>
  );
}

/* ────────────────────────  base PNG layers  ─────────────────────────── */

/** Solid compacted figure — held offscreen until the back half of the
 *  compaction beat, then fades in. The user specifically asked that the
 *  figure not be visible (or even faintly silhouetted) until the very end.
 *  On reduced-motion the solid is the only thing visible. */
function SolidLayer({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  // Hold at 0 through the first half of compaction so scattered fragments
  // own the stage, then ramp in over the back half.
  const opacity = useTransform(compactionProgress, [0.5, 0.85, 1], [0, 0.4, 1]);
  const filter = useTransform(
    compactionProgress,
    [0, 1],
    ["brightness(1) drop-shadow(0 0 0 rgba(134,239,172,0))", "brightness(1.12) drop-shadow(0 0 32px rgba(134,239,172,0.5))"],
  );
  if (forceInstalled) {
    return (
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          filter: "brightness(1.12) drop-shadow(0 0 24px rgba(134,239,172,0.4))",
        }}
      >
        <Image
          src="/welcome/parts/agent-solid.png"
          alt=""
          fill
          sizes={IMG_SIZES}
          style={{ objectFit: "contain", objectPosition: "center" }}
          draggable={false}
          priority
        />
      </div>
    );
  }
  return (
    <motion.div aria-hidden style={{ position: "absolute", inset: 0, opacity, filter }}>
      <Image
        src="/welcome/parts/agent-solid.png"
        alt=""
        fill
        sizes={IMG_SIZES}
        style={{ objectFit: "contain", objectPosition: "center" }}
        draggable={false}
        priority
      />
    </motion.div>
  );
}

/* ────────────────────────  install layer  ───────────────────────────── */

function InstallLayer({
  layer,
  installProgress,
  compactionProgress,
  forceInstalled,
}: {
  layer: LayerSpec;
  installProgress: MotionValue<number>;
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  // Install fade-in (0 → 1 over the install window).
  const installOpacity = useTransform(installProgress, [0, 0.18, 0.55, 1], [0, 0.45, 0.92, 1]);

  // Scattered resting position settled into post-install (mild damped approach).
  const restX = useTransform(installProgress, [0, 0.6, 1], [layer.scatter.x * 1.8, layer.scatter.x * 1.1, layer.scatter.x]);
  const restY = useTransform(installProgress, [0, 0.6, 1], [layer.scatter.y * 1.8, layer.scatter.y * 1.1, layer.scatter.y]);
  const restRot = useTransform(installProgress, [0, 0.6, 1], [layer.scatter.rotate * 1.8, layer.scatter.rotate * 1.1, layer.scatter.rotate]);
  const restScale = useTransform(installProgress, [0, 0.6, 1], [layer.scatter.scale * 0.78, layer.scatter.scale * 1.04, layer.scatter.scale]);

  // Continuous idle drift while scattered. Each fragment is given its own
  // ORBITAL motion (small ellipse around its scatter dock) plus a vertical
  // BOB on a different period — combination reads as "intelligent suspension
  // in zero-g" instead of metronomic sway. Amplitudes scaled up from the
  // previous build (9/11/2) so larger parts have proportional motion.
  // Phase seeds derived from scatter coords so all 10 fragments breathe on
  // independent rhythms. Float dampens to 0 as compaction approaches 1.
  const time = useTime();
  const orbitPhaseX = (layer.scatter.x + 320) * 0.011; // unique phase per fragment
  const orbitPhaseY = (layer.scatter.y + 400) * 0.014;
  const bobPhase = layer.scatter.rotate * 0.35;
  // Orbital X/Y traces a slow ellipse (period ~7.2s X / ~9.6s Y).
  const floatX = useTransform(time, (t) =>
    Math.sin((t as number) / 2400 + orbitPhaseX) * 16 + Math.cos((t as number) / 3700 + orbitPhaseY) * 6,
  );
  const floatY = useTransform(time, (t) =>
    Math.cos((t as number) / 3000 + orbitPhaseY) * 18 + Math.sin((t as number) / 4100 + orbitPhaseX) * 7,
  );
  // Subtle counter-rotation that follows the orbit phase — fragment looks
  // like it's drifting along its trajectory, not spinning in place.
  const floatRot = useTransform(time, (t) =>
    Math.sin((t as number) / 3400 + bobPhase) * 3.5,
  );

  // Ease-in-out compaction lerp so the merger reads as mechanical, not linear.
  const c = useTransform(compactionProgress, (v) => {
    const t = v as number;
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  });

  // Final position = (scattered rest + idle float) lerped toward 0 by
  // compaction. Float dampens to 0 as c approaches 1 (no jitter on lock).
  const x = useTransform(
    [restX, floatX, c] as const,
    ([rx, fx, ce]) => ((rx as number) + (fx as number) * (1 - (ce as number))) * (1 - (ce as number)),
  );
  const y = useTransform(
    [restY, floatY, c] as const,
    ([ry, fy, ce]) => ((ry as number) + (fy as number) * (1 - (ce as number))) * (1 - (ce as number)),
  );
  const rotate = useTransform(
    [restRot, floatRot, c] as const,
    ([rr, fr, ce]) => ((rr as number) + (fr as number) * (1 - (ce as number))) * (1 - (ce as number)),
  );
  const scale = useTransform([restScale, c] as const, ([rs, ce]) => {
    const s = rs as number;
    const e = ce as number;
    return s + (1 - s) * e;
  });

  // After compaction the exploded slice fades out so the agent-solid base
  // shows alone (otherwise the two stack and the figure double-prints).
  const compactionFade = useTransform(compactionProgress, [0.55, 1], [1, 0]);
  const opacity = useTransform(
    [installOpacity, compactionFade] as const,
    ([io, cf]) => (io as number) * (cf as number),
  );

  if (forceInstalled) return null;

  return (
    <motion.div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        x,
        y,
        rotate,
        scale,
        opacity,
        transformOrigin: "center",
      }}
    >
      <Image
        src={`/welcome/parts/${layer.file}.png`}
        alt=""
        fill
        sizes={IMG_SIZES}
        style={{ objectFit: "contain", objectPosition: "center" }}
        draggable={false}
        priority={layer.file === "01-head" || layer.file === "06-reasoning-torso"}
      />
    </motion.div>
  );
}

/* ────────────────────────  lock-click wrapper  ──────────────────────── */

function LockClickWrapper({
  compactionProgress,
  forceInstalled,
  children,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
  children: ReactNode;
}) {
  const scale = useTransform(compactionProgress, [0, 0.35, 0.55, 0.75, 1], [1, 1, 1.06, 0.985, 1]);
  if (forceInstalled) return <div style={{ position: "absolute", inset: 0 }}>{children}</div>;
  return (
    <motion.div style={{ position: "absolute", inset: 0, scale, transformOrigin: "center" }}>
      {children}
    </motion.div>
  );
}

/* ────────────────────────  SVG overlay defs  ────────────────────────── */

function Defs() {
  return (
    <defs>
      <filter id="hg-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id="hg-glow-soft" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="14" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <linearGradient id="hg-scan" x1="0%" y1="0%" x2="0%" y2="100%">
        <stop offset="0%" stopColor={C.primary} stopOpacity="0" />
        <stop offset="50%" stopColor={C.primary} stopOpacity="0.55" />
        <stop offset="100%" stopColor={C.primary} stopOpacity="0" />
      </linearGradient>
    </defs>
  );
}

/* ────────────────────────  compaction links  ────────────────────────── */

type LinkSegment = {
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  start: number;
  end: number;
};

/**
 * Network of electric lines wiring subsystems together. Coordinates are
 * in PNG image space (540x1435). Anatomy landmarks for the new standing
 * humanoid: head ~y130, chest core ~y540, hips ~y800, hands ~y870,
 * knees ~y1050, podium ~y1390. Lines wire spine + limbs together.
 */
const LINK_SEGMENTS: LinkSegment[] = [
  { d: "M 270 200 L 270 410",   x1: 270, y1: 200,  x2: 270, y2: 410,  start: 0.18, end: 0.4  }, // head → chest
  { d: "M 270 540 L 270 800",   x1: 270, y1: 540,  x2: 270, y2: 800,  start: 0.25, end: 0.5  }, // chest core → hips
  { d: "M 220 540 L 160 870",   x1: 220, y1: 540,  x2: 160, y2: 870,  start: 0.30, end: 0.6  }, // left shoulder → left hand
  { d: "M 320 540 L 380 870",   x1: 320, y1: 540,  x2: 380, y2: 870,  start: 0.30, end: 0.6  }, // right shoulder → right hand
  { d: "M 230 820 L 235 1300",  x1: 230, y1: 820,  x2: 235, y2: 1300, start: 0.40, end: 0.72 }, // left hip → left foot
  { d: "M 310 820 L 305 1300",  x1: 310, y1: 820,  x2: 305, y2: 1300, start: 0.40, end: 0.72 }, // right hip → right foot
  { d: "M 270 1300 L 270 1395", x1: 270, y1: 1300, x2: 270, y2: 1395, start: 0.50, end: 0.82 }, // feet → podium
];

function CompactionLinks({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  if (forceInstalled) {
    return (
      <g stroke={C.primary} strokeWidth={2.5} fill="none" opacity={0.7} filter="url(#hg-glow)">
        {LINK_SEGMENTS.map((s) => (
          <path key={s.d} d={s.d} />
        ))}
      </g>
    );
  }
  return (
    <g fill="none">
      {LINK_SEGMENTS.map((s) => (
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
  const drawn = useTransform(compactionProgress, [start, end], [0, 1], { clamp: true });
  const opacity = useTransform(compactionProgress, [start, (start + end) / 2, 1], [0, 0.65, 0.85]);
  const offset = useTransform(drawn, (v) => 200 - (v as number) * 200);
  return (
    <motion.path
      d={d}
      stroke={C.primary}
      strokeWidth={2.5}
      strokeLinecap="round"
      pathLength={200}
      strokeDasharray="200 200"
      filter="url(#hg-glow)"
      style={{ strokeDashoffset: offset, opacity }}
    />
  );
}

/* ────────────────────────  link pulses  ─────────────────────────────── */

/** Traveling "data packet" that fires right after each link finishes
 *  drawing. Sells the "subsystems are now talking" beat — the line is the
 *  wire, the pulse is the signal. */
function LinkPulses({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  if (forceInstalled) return null;
  return (
    <g filter="url(#hg-glow)">
      {LINK_SEGMENTS.map((s) => (
        <LinkPulse key={`pulse-${s.d}`} segment={s} compactionProgress={compactionProgress} />
      ))}
    </g>
  );
}

function LinkPulse({
  segment,
  compactionProgress,
}: {
  segment: LinkSegment;
  compactionProgress: MotionValue<number>;
}) {
  // Pulse fires immediately after the line completes, traversing in ~12%
  // of compaction progress. Two staggered windows (head, tail) so the
  // packet leaves a brief comet trail.
  const pulseStart = segment.end;
  const pulseEnd = Math.min(1, segment.end + 0.14);
  const tHead = useTransform(compactionProgress, [pulseStart, pulseEnd], [0, 1], { clamp: true });
  const tTail = useTransform(
    compactionProgress,
    [pulseStart + 0.02, Math.min(1, pulseEnd + 0.02)],
    [0, 1],
    { clamp: true },
  );

  const cxHead = useTransform(tHead, (v) => segment.x1 + (segment.x2 - segment.x1) * (v as number));
  const cyHead = useTransform(tHead, (v) => segment.y1 + (segment.y2 - segment.y1) * (v as number));
  const cxTail = useTransform(tTail, (v) => segment.x1 + (segment.x2 - segment.x1) * (v as number));
  const cyTail = useTransform(tTail, (v) => segment.y1 + (segment.y2 - segment.y1) * (v as number));

  // Pulse visible only during its window — invisible before/after.
  const opacityHead = useTransform(compactionProgress, [pulseStart - 0.01, pulseStart, pulseEnd, pulseEnd + 0.02], [0, 1, 1, 0]);
  const opacityTail = useTransform(compactionProgress, [pulseStart + 0.01, pulseStart + 0.04, pulseEnd + 0.02, pulseEnd + 0.04], [0, 0.55, 0.55, 0]);

  return (
    <>
      <motion.circle r={4} fill={C.warm} style={{ cx: cxTail, cy: cyTail, opacity: opacityTail }} />
      <motion.circle r={6} fill="#ffffff" stroke={C.primary} strokeWidth={1.5} style={{ cx: cxHead, cy: cyHead, opacity: opacityHead }} />
    </>
  );
}

/* ────────────────────────  lock-in flash  ───────────────────────────── */

function LockInFlash({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const r1 = useTransform(compactionProgress, [0.35, 0.95], [40, 520]);
  const o1 = useTransform(compactionProgress, [0.35, 0.6, 0.95], [0, 0.75, 0]);
  const r2 = useTransform(compactionProgress, [0.45, 1], [30, 680]);
  const o2 = useTransform(compactionProgress, [0.45, 0.7, 1], [0, 0.6, 0]);
  const r3 = useTransform(compactionProgress, [0.55, 1], [20, 420]);
  const o3 = useTransform(compactionProgress, [0.55, 0.8, 1], [0, 0.5, 0]);
  if (forceInstalled) return null;
  // Heart of the figure ≈ chest core (light element) at (270, 540) in new PNG space.
  return (
    <g fill="none" filter="url(#hg-glow-soft)">
      <motion.circle cx={270} cy={540} strokeWidth={4} stroke={C.primary} style={{ r: r1, opacity: o1 }} />
      <motion.circle cx={270} cy={540} strokeWidth={3} stroke={C.accent} style={{ r: r2, opacity: o2 }} />
      <motion.circle cx={270} cy={540} strokeWidth={3} stroke={C.warm} style={{ r: r3, opacity: o3 }} />
    </g>
  );
}

/* ────────────────────────  center shockwave  ────────────────────────── */

/** Final "moment of birth" exhale — a single ring expands from the heart
 *  to past the figure edges as everything locks. Distinct from the tighter,
 *  earlier triple-ring of LockInFlash. */
function CenterShockwave({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const r = useTransform(compactionProgress, [0.7, 1], [0, 760]);
  const strokeWidth = useTransform(compactionProgress, [0.7, 0.85, 1], [9, 4, 1]);
  const opacity = useTransform(compactionProgress, [0.7, 0.82, 1], [0, 0.85, 0]);
  if (forceInstalled) return null;
  return (
    <motion.circle
      cx={270}
      cy={540}
      fill="none"
      stroke={C.primary}
      filter="url(#hg-glow-soft)"
      style={{ r, strokeWidth, opacity }}
    />
  );
}

/* ────────────────────────  system online pill  ──────────────────────── */

function SystemOnlinePill({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  // Sits just below the activation platform. Fades in during the second
  // half of compaction.
  const opacity = useTransform(compactionProgress, [0.5, 0.85], [0, 1]);
  // Pill scaled up so it stays legible at small figure sizes (mobile).
  // Centered horizontally; sits just below the activation podium.
  const PILL_W = 240;
  const PILL_H = 56;
  const PILL_X = (PNG_W - PILL_W) / 2;
  const PILL_Y = 1420;
  if (forceInstalled) {
    return (
      <g transform={`translate(${PILL_X} ${PILL_Y})`}>
        <rect x={0} y={0} width={PILL_W} height={PILL_H} rx={6} fill="#03070a" stroke={C.primary} strokeWidth={3} />
        <circle cx={26} cy={PILL_H / 2} r={8} fill={C.primary} filter="url(#hg-glow)" />
        <text x={48} y={PILL_H / 2 + 8} fontFamily="monospace" fontSize={22} fontWeight="bold" fill={C.primary} letterSpacing="4">
          SYSTEM ONLINE
        </text>
      </g>
    );
  }
  return (
    <motion.g transform={`translate(${PILL_X} ${PILL_Y})`} style={{ opacity }}>
      <rect x={0} y={0} width={PILL_W} height={PILL_H} rx={6} fill="#03070a" stroke={C.primary} strokeWidth={3} />
      <circle cx={26} cy={PILL_H / 2} r={8} fill={C.primary} filter="url(#hg-glow)" />
      <text x={48} y={PILL_H / 2 + 8} fontFamily="monospace" fontSize={22} fontWeight="bold" fill={C.primary} letterSpacing="4">
        SYSTEM ONLINE
      </text>
    </motion.g>
  );
}

/* ────────────────────────  scanline sweep  ──────────────────────────── */

function Scanline({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const time = useTime();
  const yPre = useTransform(time, (t) => ((((t as number) / 4500) % 1) * (PNG_H + 60)) - 30);
  const y = useTransform([yPre, compactionProgress] as const, ([raw, c]) => {
    if ((c as number) >= 0.95) return PNG_H / 2 - 24;
    return raw as number;
  });
  const opacity = useTransform(compactionProgress, [0, 0.9, 1], [0.35, 0.35, 0.12]);
  if (forceInstalled) return null;
  return <motion.rect x={0} width={PNG_W} height={48} fill="url(#hg-scan)" style={{ y, opacity }} />;
}
