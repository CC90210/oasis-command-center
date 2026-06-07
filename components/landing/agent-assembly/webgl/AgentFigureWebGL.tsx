"use client";

import { Canvas } from "@react-three/fiber";
import { AdaptiveDpr, PerformanceMonitor, Environment } from "@react-three/drei";
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
import { HumanoidRig } from "./HumanoidRig";
import { SystemOnlinePill } from "./SystemOnlinePill";
import { useCompactViewport } from "../useCompactViewport";

/**
 * AgentFigureWebGL — the live R3F entry. Replaces the legacy PNG-sliced
 * AgentFigureSprite. Mounted via dynamic({ ssr: false }) from
 * AgentFigureSprite.tsx so the WebGL chunk doesn't ship in the SSR
 * bundle and doesn't run during reduced-motion edge cases until the
 * silhouette fallback paints.
 *
 *   - Camera: perspective, fov 32, positioned slightly above eye-level
 *     and pulled back so the full 3.5-unit-tall figure plus podium
 *     fits with comfortable headroom.
 *   - Lights: a key directional from front-top, fill directional from
 *     back-left, ambient base. Environment preset "city" gives the
 *     shell its subtle reflections without needing custom HDRs.
 *   - SceneBridge subscribes to the 11 framer-motion MotionValues
 *     ONCE and exposes them via context as a ref; HumanoidRig and its
 *     subassemblies read the ref in useFrame, so scroll ticks never
 *     trigger React re-renders.
 *   - EffectComposer chain (bloom + chromatic aberration + vignette)
 *     runs on desktop only. Gated on window.innerWidth at mount; mobile
 *     skips it entirely for thermal headroom.
 *   - frameloop is "demand" for reduced-motion (one static frame) and
 *     "always" otherwise (continuous animation).
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
        // Square-ish aspect window; camera fov chosen to frame the
        // 3.5-unit figure with headroom + foot room. dpr capped at 2
        // to keep texture memory reasonable on Retina displays.
        dpr={[1, 2]}
        // Camera framing: figure is 3.3 units tall, scatter origins extend
        // out to ±1.5 horizontal + ±2.0 vertical. At fov 36 and z = 7.2,
        // vertical visible extent is ~4.7u — figure fills ~70% with plenty
        // of room for scattered parts to drift visibly around it.
        camera={{ position: [0, -0.1, 7.2], fov: 36, near: 0.1, far: 30 }}
        gl={{
          antialias: true,
          alpha: true,
          powerPreference: "high-performance",
        }}
        // demand frameloop for reduced-motion means we render once and
        // pause. always for everyone else.
        frameloop={forceInstalled ? "demand" : "always"}
        style={{ width: "100%", height: "100%", touchAction: "none" }}
        aria-hidden
      >
        {/* Lighting rig — three-point. Cool key from above-front, warm
            fill from back-left, soft ambient base. Tuned so the shell
            reads as matte plastic-armor, not as polished metal. */}
        <ambientLight intensity={0.35} color="#cfeae0" />
        <directionalLight
          position={[3, 5, 4]}
          intensity={1.4}
          color="#ffffff"
          castShadow={false}
        />
        <directionalLight
          position={[-4, 2, -3]}
          intensity={0.6}
          color="#86efac"
        />
        {/* Rim accent — subtle warm fill from below to lift the legs */}
        <pointLight position={[0, -3, 2]} intensity={0.4} color="#fcd34d" distance={8} />

        {/* Environment preset gives free PBR reflections without
            bundling a custom HDR. "city" reads as crisp daylight,
            which keeps the shell from going dull. */}
        <Environment preset="city" />

        <SceneBridge
          installProgresses={installProgresses}
          compactionProgress={compactionProgress}
        >
          <HumanoidRig forceInstalled={forceInstalled} />
        </SceneBridge>

        {/* Desktop-only postprocessing — bloom on emissive seams +
            slight chromatic aberration + vignette finish. Mobile +
            reduced-motion skip this entirely. */}
        {usePostprocessing ? (
          <EffectComposer multisampling={0}>
            <Bloom
              intensity={0.55}
              luminanceThreshold={0.65}
              luminanceSmoothing={0.22}
              mipmapBlur
            />
            <ChromaticAberration
              blendFunction={BlendFunction.NORMAL}
              offset={new Vector2(0.0008, 0.0012)}
              radialModulation={false}
              modulationOffset={0}
            />
            <Vignette eskil={false} offset={0.18} darkness={0.55} />
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

