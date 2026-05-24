"use client";

import Image from "next/image";
import {
  motion,
  useSpring,
  useTime,
  useTransform,
  type MotionValue,
} from "framer-motion";

/**
 * AgentFigureSprite — photoreal scroll-driven agent assembly built from
 * 11 layered transparent PNGs sliced from the ChatGPT reference render:
 *   - 10 exploded-view bands (head → activation podium) that fly in from
 *     offscreen as their `installProgresses[i]` scrubs 0→1
 *   - 1 always-painted silhouette (faint, anchors the scene pre-scroll)
 *   - 1 solid-state base (the compacted figure with fragments removed)
 *     that cross-fades IN as `compactionProgress` scrubs 0→1; the
 *     exploded layers cross-fade OUT in the same window, so the user
 *     sees fragments visually collapse into a fully-assembled robot.
 *
 * Physics:
 *   - Per-layer depth (0..1) drives cursor parallax weight: depth=0 is
 *     closest (full drift), depth=1 is farthest (minimal drift).
 *   - Two spring profiles: BODY_SPRING (tight, mechanical) for the
 *     central spine; FRAGMENT_SPRING (looser, zero-G) for everything
 *     that's mostly floating chips.
 *   - Once installProgress crosses 0.95, an idle hover (sin-wave y-drift
 *     with per-layer amplitude/period/phase) blends in so the figure
 *     never goes static.
 */

type LayerSpec = {
  /** PNG filename inside /public/welcome/parts/ (no extension). */
  file: string;
  /** Human label for alt text. */
  label: string;
  /** Offscreen launch position (px relative to dock). */
  from: { x: number; y: number; rotate: number; scale: number };
  /** Parallax depth — 0 = closest (full cursor drift), 1 = farthest (min drift). */
  depth: number;
  /** "body" → tight spring + small idle hover; "fragment" → loose spring + larger drift. */
  kind: "body" | "fragment";
  /** Idle-hover params engaged after installProgress >= 0.95. */
  idle: { amp: number; period: number; phase: number };
};

const LAYERS: LayerSpec[] = [
  // Paint order: bottom (activation) → top (head) so foreground parts land last.
  // depth 0=closest, 1=farthest. Body layers get mechanical springs; fragment-
  // heavy layers get loose zero-G springs. Idle hover amplitudes and periods
  // staggered so the figure breathes asymmetrically.
  { file: "10-activation",      label: "Activation podium",  from: { x: 0,    y: 380,  rotate: 0,   scale: 0.6 },  depth: 1.0,  kind: "body",     idle: { amp: 1.5, period: 6.3, phase: 0.0 } },
  { file: "09-body-pelvis",     label: "Body interface",     from: { x: 0,    y: 320,  rotate: 0,   scale: 0.7 },  depth: 0.85, kind: "body",     idle: { amp: 2.0, period: 5.7, phase: 0.4 } },
  { file: "08-ethics-hip",      label: "Ethics layer",       from: { x: 280,  y: 60,   rotate: 12,  scale: 0.75 }, depth: 0.7,  kind: "fragment", idle: { amp: 5.5, period: 4.9, phase: 1.1 } },
  { file: "07-communication",   label: "Communication arms", from: { x: -300, y: 20,   rotate: -10, scale: 0.78 }, depth: 0.55, kind: "fragment", idle: { amp: 6.0, period: 4.3, phase: 0.7 } },
  { file: "06-reasoning-torso", label: "Reasoning engine",   from: { x: 300,  y: -40,  rotate: 8,   scale: 0.78 }, depth: 0.4,  kind: "body",     idle: { amp: 2.5, period: 5.1, phase: 1.8 } },
  { file: "05-sensors",         label: "Sensor band",        from: { x: -260, y: -60,  rotate: -8,  scale: 0.8 },  depth: 0.3,  kind: "fragment", idle: { amp: 7.5, period: 4.1, phase: 2.3 } },
  { file: "04-memory-ring",     label: "Memory ring",        from: { x: 0,    y: -260, rotate: -15, scale: 0.7 },  depth: 0.22, kind: "fragment", idle: { amp: 8.5, period: 3.7, phase: 0.2 } },
  { file: "03-neural-disc",     label: "Neural lattice",     from: { x: 240,  y: -180, rotate: 12,  scale: 0.7 },  depth: 0.16, kind: "fragment", idle: { amp: 9.5, period: 3.4, phase: 2.9 } },
  { file: "02-neural-cube",     label: "Neural cube",        from: { x: -220, y: -220, rotate: -18, scale: 0.6 },  depth: 0.10, kind: "fragment", idle: { amp: 10,  period: 3.2, phase: 1.5 } },
  { file: "01-head",            label: "Reasoning core",     from: { x: 0,    y: -380, rotate: 0,   scale: 0.7 },  depth: 0.05, kind: "body",     idle: { amp: 3.0, period: 4.6, phase: 0.9 } },
];

export const SPRITE_LAYER_COUNT = LAYERS.length;

const BODY_SPRING = { stiffness: 140, damping: 24, mass: 0.5 };
const FRAGMENT_SPRING = { stiffness: 55, damping: 18, mass: 1.2 };

// Maximum cursor parallax offset (px) at depth=0 (closest layer). Layers
// further back scale this down by (1 - depth).
const CURSOR_PARALLAX_MAX_X = 22;
const CURSOR_PARALLAX_MAX_Y = 16;
const CURSOR_PARALLAX_MAX_ROT = 1.4;

type AgentFigureSpriteProps = {
  /** One MotionValue per layer in MANIFEST order: head, cube, disc, ring,
      sensors, torso, comm, ethics, body, activation. */
  installProgresses: MotionValue<number>[];
  /** 0→1 over scroll 92–100%. Drives fragment fade-out + solid fade-in. */
  compactionProgress: MotionValue<number>;
  cursorX: MotionValue<number>;
  cursorY: MotionValue<number>;
  forceInstalled?: boolean;
  className?: string;
};

export function AgentFigureSprite({
  installProgresses,
  compactionProgress,
  cursorX,
  cursorY,
  forceInstalled = false,
  className,
}: AgentFigureSpriteProps) {
  if (installProgresses.length !== LAYERS.length) {
    throw new Error(
      `AgentFigureSprite expects ${LAYERS.length} installProgresses, got ${installProgresses.length}`,
    );
  }

  // Continuous clock for sin-wave idle hover. useTime returns ms since mount.
  const time = useTime();

  // Solid-state base layer: scrubs in over the last 8% of scroll. The
  // exploded layers correspondingly fade out (see LayerSprite).
  const solidOpacity = useTransform(compactionProgress, [0, 0.6, 1], [0, 0.6, 1]);
  // Subtle "system online" glow ramps with compaction.
  const solidBrightness = useTransform(compactionProgress, [0, 1], [1.0, 1.18]);
  const solidFilter = useTransform(solidBrightness, (b) => `brightness(${b}) drop-shadow(0 0 24px rgba(134,239,172,0.35))`);
  // Silhouette fades out as compaction completes so it doesn't fight the solid base.
  const silhouetteOpacity = useTransform(compactionProgress, [0, 0.5], [0.16, 0]);

  const manifestIndexFor = (paintIndex: number): number => {
    // Paint order is reverse of manifest order (activation paints first,
    // head paints last). manifestIndex 0 = head, 9 = activation.
    return LAYERS.length - 1 - paintIndex;
  };

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        // Aspect matches the new cropped source PNG (521 × 1536).
        aspectRatio: "521 / 1536",
      }}
    >
      {/* Always-visible silhouette (faint, blurred) — anchors the figure
          outline before any scroll. Sits beneath every layer. Fades out as
          compaction completes so it doesn't compete with the solid base. */}
      <motion.div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          opacity: forceInstalled ? 0 : silhouetteOpacity,
          filter: "blur(1.5px) brightness(0.55)",
          mixBlendMode: "screen",
        }}
      >
        <Image
          src="/welcome/parts/agent-full.png"
          alt=""
          fill
          sizes="(max-width: 640px) 90vw, (max-width: 1024px) 44vw, 30vw"
          style={{ objectFit: "contain", objectPosition: "center" }}
          draggable={false}
          priority
        />
      </motion.div>

      {/* Solid-state compacted base — fades IN during the compaction beat.
          By scroll-end this is the only thing visible. */}
      <motion.div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          opacity: forceInstalled ? 1 : solidOpacity,
          filter: solidFilter,
        }}
      >
        <Image
          src="/welcome/parts/agent-solid.png"
          alt=""
          fill
          sizes="(max-width: 640px) 90vw, (max-width: 1024px) 44vw, 30vw"
          style={{ objectFit: "contain", objectPosition: "center" }}
          draggable={false}
          priority
        />
      </motion.div>

      {LAYERS.map((layer, paintIndex) => {
        const manifestIdx = manifestIndexFor(paintIndex);
        const progress = installProgresses[manifestIdx];
        return (
          <LayerSprite
            key={layer.file}
            layer={layer}
            progress={progress}
            compactionProgress={compactionProgress}
            cursorX={cursorX}
            cursorY={cursorY}
            time={time}
            forceInstalled={forceInstalled}
          />
        );
      })}
    </div>
  );
}

type LayerSpriteProps = {
  layer: LayerSpec;
  progress: MotionValue<number>;
  compactionProgress: MotionValue<number>;
  cursorX: MotionValue<number>;
  cursorY: MotionValue<number>;
  time: MotionValue<number>;
  forceInstalled: boolean;
};

function LayerSprite({
  layer,
  progress,
  compactionProgress,
  cursorX,
  cursorY,
  time,
  forceInstalled,
}: LayerSpriteProps) {
  const spring = layer.kind === "body" ? BODY_SPRING : FRAGMENT_SPRING;
  // Closer layers (low depth) get MORE parallax drift.
  const depthInv = 1 - layer.depth;

  // ── Install transforms: layer flies from offscreen → dock with a
  //    slight overshoot at 0.88 then settles. Spring-smoothed so wheel
  //    spam doesn't visibly jitter.
  const installX = useTransform(progress, [0, 0.72, 0.88, 1], [layer.from.x, layer.from.x * 0.18, -4, 0]);
  const installY = useTransform(progress, [0, 0.72, 0.88, 1], [layer.from.y, layer.from.y * 0.18, -4, 0]);
  const installRotate = useTransform(progress, [0, 0.72, 1], [layer.from.rotate, layer.from.rotate * 0.18, 0]);
  const installScale = useTransform(progress, [0, 0.72, 0.88, 1], [layer.from.scale, 0.98, 1.04, 1]);

  // ── Install opacity (fade-in) AND compaction opacity (fade-out).
  //    Fragment layers fade to 0 by end of compaction so the solid base
  //    shows alone. Body layers fade more gently (the solid base still
  //    needs them to layer on top during the silhouette → solid swap).
  const installOpacity = useTransform(progress, [0, 0.08, 0.22], [0, 0.5, 1]);
  const compactionFade = useTransform(
    compactionProgress,
    [0, 1],
    [1, layer.kind === "fragment" ? 0 : 0.15],
  );
  const opacity = useTransform(
    [installOpacity, compactionFade] as const,
    ([io, cf]) => Math.max(0, (io as number) * (cf as number)),
  );

  // ── Cursor parallax (depth-weighted). Each layer drifts toward the
  //    cursor by an amount inversely proportional to its depth. Spring-
  //    smoothed using the layer's profile.
  const parallaxX = useSpring(
    useTransform(cursorX, [-1, 1], [-CURSOR_PARALLAX_MAX_X * depthInv, CURSOR_PARALLAX_MAX_X * depthInv]),
    spring,
  );
  const parallaxY = useSpring(
    useTransform(cursorY, [-1, 1], [-CURSOR_PARALLAX_MAX_Y * depthInv, CURSOR_PARALLAX_MAX_Y * depthInv]),
    spring,
  );
  const parallaxRotate = useSpring(
    useTransform(cursorX, [-1, 1], [-CURSOR_PARALLAX_MAX_ROT * depthInv, CURSOR_PARALLAX_MAX_ROT * depthInv]),
    spring,
  );

  // ── Idle hover: blends in once install ≥ 0.95. amplitude * sin(t/period + phase).
  //    Use installProgress as a gate so newly-arriving layers don't immediately
  //    pick up the wobble mid-install.
  const idleGate = useTransform(progress, [0.85, 1], [0, 1]);
  const idleY = useTransform([time, idleGate] as const, ([t, gate]) => {
    const seconds = (t as number) / 1000;
    return Math.sin((seconds / layer.idle.period) * Math.PI * 2 + layer.idle.phase) * layer.idle.amp * (gate as number);
  });

  return (
    <motion.div
      style={{
        position: "absolute",
        inset: 0,
        x: forceInstalled ? 0 : installX,
        y: forceInstalled ? 0 : installY,
        rotate: forceInstalled ? 0 : installRotate,
        scale: forceInstalled ? 1 : installScale,
        opacity: forceInstalled ? 1 : opacity,
      }}
    >
      <motion.div
        style={{
          position: "absolute",
          inset: 0,
          x: parallaxX,
          y: useTransform([parallaxY, idleY] as const, ([p, i]) => (p as number) + (i as number)),
          rotate: parallaxRotate,
        }}
      >
        <Image
          src={`/welcome/parts/${layer.file}.png`}
          alt={layer.label}
          fill
          sizes="(max-width: 640px) 90vw, (max-width: 1024px) 44vw, 30vw"
          priority={layer.file === "01-head" || layer.file === "06-reasoning-torso"}
          style={{ objectFit: "contain", objectPosition: "center" }}
          draggable={false}
        />
      </motion.div>
    </motion.div>
  );
}
