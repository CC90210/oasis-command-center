"use client";

import Image from "next/image";
import {
  motion,
  useSpring,
  useTransform,
  type MotionValue,
} from "framer-motion";

/**
 * AgentFigureSprite — photoreal exploded-view agent built from 10 layered
 * transparent PNGs sliced from the ChatGPT reference render. Each layer
 * flies in from an offscreen "from" position to its docked center as its
 * `installProgress` motion-value scrubs 0→1. The head layer additionally
 * picks up a subtle cursor-tracked drift so the figure feels alive after
 * assembly completes.
 *
 * Layers stack on a 1024×1536 canvas (matches the source image), wrapped
 * in a max-width container so the whole figure scales responsively
 * without distorting per-layer positions.
 */

type LayerSpec = {
  /** PNG filename inside /public/welcome/parts/ (no extension). */
  file: string;
  /** Human label for alt text + manifest. */
  label: string;
  /** Offscreen launch position (px relative to dock). */
  from: { x: number; y: number; rotate: number; scale: number };
};

const LAYERS: LayerSpec[] = [
  // Order matters: later entries paint over earlier ones. We dock from
  // bottom (podium) → up (head) so foreground parts land on top.
  { file: "10-activation",      label: "Activation podium", from: { x: 0,    y: 380,  rotate: 0,   scale: 0.6 } },
  { file: "09-body-pelvis",     label: "Body interface",     from: { x: 0,    y: 320,  rotate: 0,   scale: 0.7 } },
  { file: "08-ethics-hip",      label: "Ethics layer",       from: { x: 280,  y: 60,   rotate: 12,  scale: 0.75 } },
  { file: "07-communication",   label: "Communication arms", from: { x: -300, y: 20,   rotate: -10, scale: 0.78 } },
  { file: "06-reasoning-torso", label: "Reasoning engine",   from: { x: 300,  y: -40,  rotate: 8,   scale: 0.78 } },
  { file: "05-sensors",         label: "Sensor band",        from: { x: -260, y: -60,  rotate: -8,  scale: 0.8 } },
  { file: "04-memory-ring",     label: "Memory ring",        from: { x: 0,    y: -260, rotate: -15, scale: 0.7 } },
  { file: "03-neural-disc",     label: "Neural lattice",     from: { x: 240,  y: -180, rotate: 12,  scale: 0.7 } },
  { file: "02-neural-cube",     label: "Neural cube",        from: { x: -220, y: -220, rotate: -18, scale: 0.6 } },
  { file: "01-head",            label: "Reasoning core",     from: { x: 0,    y: -380, rotate: 0,   scale: 0.7 } },
];

export const SPRITE_LAYER_COUNT = LAYERS.length;

/**
 * Each MotionValue in `installProgresses` must be ordered to match the
 * REFERENCE manifest order (top-to-bottom: head, neural cube, neural
 * disc, memory ring, sensors, reasoning torso, communication, ethics,
 * body, activation). Internally we paint bottom→top so the head paints
 * last on top, but the install timeline still reads top→bottom.
 */
type AgentFigureSpriteProps = {
  installProgresses: MotionValue<number>[];
  cursorX: MotionValue<number>;
  cursorY: MotionValue<number>;
  forceInstalled?: boolean;
  className?: string;
};

const HEAD_SPRING = { stiffness: 120, damping: 22, mass: 0.45 };

export function AgentFigureSprite({
  installProgresses,
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

  // Head cursor-drift overlay. Applied on top of the layer's own install
  // transform via nested motion.div so the install animation isn't fought.
  const headDriftX = useSpring(useTransform(cursorX, [-1, 1], [-14, 14]), HEAD_SPRING);
  const headDriftY = useSpring(useTransform(cursorY, [-1, 1], [-10, 10]), HEAD_SPRING);
  const headDriftRotate = useSpring(useTransform(cursorX, [-1, 1], [-1.6, 1.6]), HEAD_SPRING);

  // Map LAYERS (paint order: bottom→top) back to manifest order (top→bottom)
  // so each layer reads from the correct installProgress slot.
  // installProgresses[0] = head, [1] = neural cube, ... [9] = activation
  const manifestIndexFor = (paintIndex: number): number => {
    // Paint order: [activation, body, ethics, comm, reasoning, sensors,
    //               memory, disc, cube, head]
    // Manifest:    [head, cube, disc, memory, sensors, reasoning, comm,
    //               ethics, body, activation]
    return LAYERS.length - 1 - paintIndex;
  };

  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "1024 / 1536",
      }}
    >
      {/* Always-visible silhouette so the figure outline anchors the scene
          before any scroll happens. Brightens slightly as overall assembly
          progresses. Sits beneath every layer. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          opacity: forceInstalled ? 0 : 0.16,
          filter: "blur(1.5px) brightness(0.55)",
          mixBlendMode: "screen",
        }}
      >
        <Image
          src="/welcome/parts/agent-full.png"
          alt=""
          fill
          sizes="(max-width: 640px) 92vw, (max-width: 1024px) 58vw, 44vw"
          style={{ objectFit: "contain", objectPosition: "center" }}
          draggable={false}
          priority
        />
      </div>

      {LAYERS.map((layer, paintIndex) => {
        const manifestIdx = manifestIndexFor(paintIndex);
        const progress = installProgresses[manifestIdx];
        const isHead = layer.file === "01-head";
        return (
          <LayerSprite
            key={layer.file}
            layer={layer}
            progress={progress}
            forceInstalled={forceInstalled}
            extraTransform={
              isHead
                ? {
                    x: headDriftX,
                    y: headDriftY,
                    rotate: headDriftRotate,
                  }
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

type LayerSpriteProps = {
  layer: LayerSpec;
  progress: MotionValue<number>;
  forceInstalled: boolean;
  extraTransform?: {
    x: MotionValue<number>;
    y: MotionValue<number>;
    rotate: MotionValue<number>;
  };
};

function LayerSprite({
  layer,
  progress,
  forceInstalled,
  extraTransform,
}: LayerSpriteProps) {
  // Install-driven transforms: layer flies from offscreen (full from values)
  // → dock (0,0). Slight overshoot at 0.88 then settles to 1 for a magnetic
  // "snap" feel matching the original AssemblyModule's choreography.
  const x = useTransform(progress, [0, 0.72, 0.88, 1], [layer.from.x, layer.from.x * 0.18, -4, 0]);
  const y = useTransform(progress, [0, 0.72, 0.88, 1], [layer.from.y, layer.from.y * 0.18, -4, 0]);
  const rotate = useTransform(progress, [0, 0.72, 1], [layer.from.rotate, layer.from.rotate * 0.18, 0]);
  const scale = useTransform(progress, [0, 0.72, 0.88, 1], [layer.from.scale, 0.98, 1.04, 1]);
  const opacity = useTransform(progress, [0, 0.08, 0.22], [0, 0.5, 1]);

  return (
    <motion.div
      style={{
        position: "absolute",
        inset: 0,
        x: forceInstalled ? 0 : x,
        y: forceInstalled ? 0 : y,
        rotate: forceInstalled ? 0 : rotate,
        scale: forceInstalled ? 1 : scale,
        opacity: forceInstalled ? 1 : opacity,
      }}
    >
      {extraTransform ? (
        <motion.div
          style={{
            position: "absolute",
            inset: 0,
            x: extraTransform.x,
            y: extraTransform.y,
            rotate: extraTransform.rotate,
          }}
        >
          <LayerImage layer={layer} />
        </motion.div>
      ) : (
        <LayerImage layer={layer} />
      )}
    </motion.div>
  );
}

function LayerImage({ layer }: { layer: LayerSpec }) {
  return (
    <Image
      src={`/welcome/parts/${layer.file}.png`}
      alt={layer.label}
      fill
      sizes="(max-width: 640px) 92vw, (max-width: 1024px) 58vw, 44vw"
      priority={layer.file === "01-head" || layer.file === "06-reasoning-torso"}
      style={{
        objectFit: "contain",
        objectPosition: "center",
      }}
      draggable={false}
    />
  );
}
