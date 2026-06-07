"use client";

import { Canvas } from "@react-three/fiber";
import { AdaptiveDpr, PerformanceMonitor } from "@react-three/drei";
import {
  EffectComposer,
  Bloom,
  ChromaticAberration,
  Vignette,
} from "@react-three/postprocessing";
import { BlendFunction } from "postprocessing";
import { Vector2 } from "three";
import { type MotionValue } from "framer-motion";
import { SceneBridge } from "./SceneBridge";
import { OasisOrb } from "./OasisOrb";
import { HoloAccents } from "./HoloAccents";
import { SystemOnlinePill } from "./SystemOnlinePill";
import { useCompactViewport } from "../useCompactViewport";

/**
 * AgentFigureWebGL — V6 entry. The agent is rendered as a single
 * unified glowing orb (OasisOrb) where each install scroll phase
 * adds a CAPABILITY LAYER to the same orb (inner geodesic, equator
 * ring, polar ring, security lattice, halo dots, corona) rather
 * than as separate floating pieces.
 *
 * V5 split the agent into a core + 10 orbiting modules; the result
 * read as "disconnected fragments." V6 collapses everything into
 * concentric layers of one form so the agent reads as a single
 * intelligence growing more powerful with scroll.
 *
 *   - Camera: pulled to z=4 with fov 36 so the ~2-unit orbital diameter
 *     fills the frame with room for the scatter origins.
 *   - Lighting: ambient + soft front directional only (everything is
 *     additive-blended emissive, so no environment reflections needed).
 *   - SceneBridge subscribes to the 11 framer-motion MotionValues once
 *     and exposes them via context as a ref; OrbitalRig modules read
 *     the ref inside useFrame, so scroll ticks never trigger React
 *     re-renders.
 *   - EffectComposer (bloom + chromatic aberration + vignette) runs on
 *     desktop only.
 *   - frameloop is "demand" for reduced-motion (one static frame) and
 *     "always" otherwise.
 *
 * The DOM "SYSTEM ONLINE" pill renders OUTSIDE the canvas so the text
 * stays crisp at any DPR.
 */

type Props = {
  installProgresses: MotionValue<number>[];
  compactionProgress: MotionValue<number>;
  forceInstalled?: boolean;
  className?: string;
};

export function AgentFigureWebGL({
  installProgresses,
  compactionProgress,
  forceInstalled = false,
  className,
}: Props) {
  const isCompact = useCompactViewport();
  const usePostprocessing = !isCompact && !forceInstalled;

  return (
    <div className={className} style={{ position: "absolute", inset: 0 }}>
      <Canvas
        dpr={[1, 2]}
        // OASIS Core sits at origin; modules orbit at radius 0.95-1.3.
        // Scatter origins reach ~2.6u out. fov 38 at z=4.2 gives a
        // visible vertical extent of ~2.9u — fills the frame.
        camera={{ position: [0, 0.05, 4.2], fov: 38, near: 0.1, far: 30 }}
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        }}
        frameloop={forceInstalled ? "demand" : "always"}
        style={{ width: "100%", height: "100%", touchAction: "none" }}
        aria-hidden
      >
        {/* Minimal lighting — everything in OasisCore + OrbitalRig is
            emissive (MeshBasicMaterial + additive blending), so we only
            need a faint ambient to register accidental MeshStandard
            materials. No directional rim needed. */}
        <ambientLight intensity={0.4} color="#cfeae0" />

        <SceneBridge
          installProgresses={installProgresses}
          compactionProgress={compactionProgress}
        >
          <HoloAccents forceInstalled={forceInstalled} />
          <OasisOrb forceInstalled={forceInstalled} />
        </SceneBridge>

        {/* Desktop-only postprocessing. Bloom tuned LOWER than V4 so
            additive emissive layers don't blow out to white smear —
            keeps the wireframe + ring structure readable. */}
        {usePostprocessing ? (
          <EffectComposer multisampling={0}>
            <Bloom
              intensity={0.42}
              luminanceThreshold={0.72}
              luminanceSmoothing={0.28}
              mipmapBlur
            />
            <ChromaticAberration
              blendFunction={BlendFunction.NORMAL}
              offset={new Vector2(0.0006, 0.0009)}
              radialModulation={false}
              modulationOffset={0}
            />
            <Vignette eskil={false} offset={0.22} darkness={0.6} />
          </EffectComposer>
        ) : null}

        <AdaptiveDpr pixelated />
        <PerformanceMonitor />
      </Canvas>

      {/* DOM overlay — sits above the canvas, browser-rasterized text */}
      <SystemOnlinePill
        compactionProgress={compactionProgress}
        forceInstalled={forceInstalled}
      />
    </div>
  );
}
