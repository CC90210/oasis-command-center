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
 *    from anatomical home, with mild rotation) and STAYS scattered through
 *    its scroll window. Reads as exploded-view blueprint fragments
 *    materialising one by one.
 *  - COMPACTION phase (last scroll beat): every slice converges from its
 *    scattered rest position toward home (0, 0, 0, 1) via an ease-in-out
 *    lerp; the whole figure punches +6% scale ("lock click"); 7 connection
 *    lines draw in sequence wiring subsystems together; a triple-ring
 *    burst confirms SYSTEM ONLINE; the agent-solid base PNG cross-fades
 *    in for the final "fully assembled" look.
 *  - REDUCED-MOTION / mobile: forceInstalled short-circuits to a static
 *    fully-assembled view (just the agent-solid PNG with SYSTEM ONLINE
 *    overlay).
 *
 * Sizing: parent constrains by HEIGHT (e.g. h-[min(78vh,620px)]); the
 * figure aspect-ratio (521:1536) yields a narrow humanoid column that
 * always fits the viewport.
 */

export const SPRITE_LAYER_COUNT = 10;

// Source PNG dimensions — used as the SVG overlay viewBox so connection
// lines and lock-in flashes share coordinate space with the figure.
const PNG_W = 521;
const PNG_H = 1536;

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
const LAYERS: LayerSpec[] = [
  { file: "10-activation",      manifestIdx: 9, scatter: { x: -25,  y: 95,   rotate: -5,  scale: 0.7 } },
  { file: "09-body-pelvis",     manifestIdx: 8, scatter: { x: -55,  y: -45,  rotate: -7,  scale: 0.45 } },
  { file: "08-ethics-hip",      manifestIdx: 7, scatter: { x: 110,  y: 50,   rotate: 12,  scale: 0.65 } },
  { file: "07-communication",   manifestIdx: 6, scatter: { x: -120, y: -25,  rotate: -11, scale: 0.6 } },
  { file: "06-reasoning-torso", manifestIdx: 5, scatter: { x: 85,   y: 55,   rotate: 8,   scale: 0.55 } },
  { file: "05-sensors",         manifestIdx: 4, scatter: { x: -135, y: 25,   rotate: -14, scale: 0.45 } },
  { file: "04-memory-ring",     manifestIdx: 3, scatter: { x: 95,   y: -75,  rotate: 13,  scale: 0.6 } },
  { file: "03-neural-disc",     manifestIdx: 2, scatter: { x: -65,  y: 40,   rotate: -6,  scale: 0.7 } },
  { file: "02-neural-cube",     manifestIdx: 1, scatter: { x: 100,  y: -20,  rotate: 10,  scale: 0.55 } },
  { file: "01-head",            manifestIdx: 0, scatter: { x: 55,   y: -115, rotate: 8,   scale: 0.5 } },
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
      <SilhouetteLayer compactionProgress={compactionProgress} forceInstalled={forceInstalled} />

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
        <LockInFlash compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
        <SystemOnlinePill compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
        <Scanline compactionProgress={compactionProgress} forceInstalled={forceInstalled} />
      </svg>
    </div>
  );
}

/* ────────────────────────  base PNG layers  ─────────────────────────── */

/** Faint blurred silhouette — anchors the figure pre-scroll. Fades out
 *  as the solid base layer takes over during compaction. */
function SilhouetteLayer({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const opacity = useTransform(compactionProgress, [0, 0.45], [0.16, 0]);
  if (forceInstalled) return null;
  return (
    <motion.div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        filter: "blur(2px) brightness(0.55)",
        mixBlendMode: "screen",
      }}
    >
      <Image
        src="/welcome/parts/agent-full.png"
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

/** Solid compacted figure — fades IN during the compaction beat. On
 *  reduced-motion / mobile this is the only thing visible. */
function SolidLayer({
  compactionProgress,
  forceInstalled,
}: {
  compactionProgress: MotionValue<number>;
  forceInstalled: boolean;
}) {
  const opacity = useTransform(compactionProgress, [0, 0.55, 1], [0, 0.55, 1]);
  const filter = useTransform(
    compactionProgress,
    [0, 1],
    ["brightness(1) drop-shadow(0 0 0 rgba(134,239,172,0))", "brightness(1.12) drop-shadow(0 0 28px rgba(134,239,172,0.45))"],
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

  // Ease-in-out compaction lerp so the merger reads as mechanical, not linear.
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

  // After compaction the exploded slice fades out so the agent-solid base
  // shows alone (otherwise the two stack and the figure double-prints).
  const compactionFade = useTransform(compactionProgress, [0.55, 1], [1, 0]);
  const opacity = useTransform([installOpacity, compactionFade] as const, ([io, cf]) => (io as number) * (cf as number));

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

/**
 * Network of electric lines wiring subsystems together. Coordinates are
 * in PNG image space (521x1536). Anatomy estimates derived from the
 * agent-solid PNG layout: head ~y180, chest ~y490, hips ~y1080,
 * hands ~y820, platform ~y1480.
 */
const LINK_SEGMENTS = [
  { d: "M 260 250 L 260 470", start: 0.18, end: 0.4 },   // head → chest
  { d: "M 260 580 L 260 1080", start: 0.25, end: 0.5 },  // chest → hips
  { d: "M 220 540 L 110 830", start: 0.3, end: 0.6 },    // left torso → left hand
  { d: "M 300 540 L 410 830", start: 0.3, end: 0.6 },    // right torso → right hand
  { d: "M 110 830 L 210 1460", start: 0.4, end: 0.72 },  // left hand → base
  { d: "M 410 830 L 310 1460", start: 0.4, end: 0.72 },  // right hand → base
  { d: "M 260 1100 L 260 1470", start: 0.5, end: 0.82 }, // spine → platform
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
  return (
    <g fill="none" filter="url(#hg-glow-soft)">
      <motion.circle cx={260} cy={620} strokeWidth={4} stroke={C.primary} style={{ r: r1, opacity: o1 }} />
      <motion.circle cx={260} cy={620} strokeWidth={3} stroke={C.accent} style={{ r: r2, opacity: o2 }} />
      <motion.circle cx={260} cy={620} strokeWidth={3} stroke={C.warm} style={{ r: r3, opacity: o3 }} />
    </g>
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
  const PILL_X = 188;
  const PILL_Y = 1492;
  const PILL_W = 145;
  const PILL_H = 32;
  if (forceInstalled) {
    return (
      <g transform={`translate(${PILL_X} ${PILL_Y})`}>
        <rect x={0} y={0} width={PILL_W} height={PILL_H} rx={4} fill="#03070a" stroke={C.primary} strokeWidth={2} />
        <circle cx={18} cy={PILL_H / 2} r={5} fill={C.primary} filter="url(#hg-glow)" />
        <text x={32} y={PILL_H / 2 + 5} fontFamily="monospace" fontSize={14} fill={C.primary} letterSpacing="3">
          SYSTEM ONLINE
        </text>
      </g>
    );
  }
  return (
    <motion.g transform={`translate(${PILL_X} ${PILL_Y})`} style={{ opacity }}>
      <rect x={0} y={0} width={PILL_W} height={PILL_H} rx={4} fill="#03070a" stroke={C.primary} strokeWidth={2} />
      <circle cx={18} cy={PILL_H / 2} r={5} fill={C.primary} filter="url(#hg-glow)" />
      <text x={32} y={PILL_H / 2 + 5} fontFamily="monospace" fontSize={14} fill={C.primary} letterSpacing="3">
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
