"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useSceneBridge } from "./SceneBridge";

/**
 * HoloAccents — solid-geometry accents that ground the particle avatar
 * without competing with it:
 *
 *   - Podium platform: glowing disc + ring on the floor where the agent
 *     stands. Visible from scroll 0.
 *   - 3 orbital rings around the chest core: counter-rotating, each on
 *     a different axis. Fade in as the State Pulse install fires.
 *   - Vertical scan beam: thin column from podium to head that pulses
 *     with the compaction beat — sells the "final lock" moment.
 *
 * Everything is emissive + additive-blended so it adds light to the
 * particle field instead of looking like opaque mesh stuck through it.
 *
 * All materials are memoized so they have stable identity across renders;
 * useFrame closes over them directly and mutates opacity per frame.
 */

type Props = { forceInstalled?: boolean };

const PRIMARY = "#86efac";
const ACCENT = "#5eead4";
const WARM = "#fcd34d";

function buildHoloMat(color: string, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function HoloAccents({ forceInstalled = false }: Props) {
  const bridge = useSceneBridge();

  const platformRef = useRef<THREE.Mesh | null>(null);
  const ringARef = useRef<THREE.Mesh | null>(null);
  const ringBRef = useRef<THREE.Mesh | null>(null);
  const ringCRef = useRef<THREE.Mesh | null>(null);
  const beamRef = useRef<THREE.Mesh | null>(null);

  // Stable material instances. useFrame mutates their .opacity per frame —
  // mutating a material uniform/opacity does NOT trigger a React re-render.
  const platformMat = useMemo(() => buildHoloMat(PRIMARY, 0.55), []);
  const ringAMat = useMemo(() => buildHoloMat(PRIMARY, 0), []);
  const ringBMat = useMemo(() => buildHoloMat(ACCENT, 0), []);
  const ringCMat = useMemo(() => buildHoloMat(WARM, 0), []);
  const beamMat = useMemo(() => buildHoloMat(PRIMARY, 0), []);

  useFrame((state) => {
    if (forceInstalled) {
      platformMat.opacity = 0.65;
      ringAMat.opacity = 0.7;
      ringBMat.opacity = 0.55;
      ringCMat.opacity = 0.45;
      beamMat.opacity = 0.18;
      return;
    }

    const t = state.clock.elapsedTime;
    const statePulseP = bridge.current.install[1] ?? 0;
    const overall = Math.min(1, bridge.current.install.reduce((a, b) => a + b, 0) / 10);
    const compP = THREE.MathUtils.clamp(bridge.current.compaction, 0, 1);

    // Podium: always-on, brightens with overall progress + compaction pulse
    platformMat.opacity = 0.35 + overall * 0.4 + compP * 0.25;
    if (platformRef.current) platformRef.current.rotation.y = t * 0.18;

    // 3 orbital rings: fade in once State Pulse phase fires
    const ringFade = THREE.MathUtils.smoothstep(statePulseP, 0, 1) * 0.7;
    ringAMat.opacity = ringFade + compP * 0.2;
    ringBMat.opacity = ringFade * 0.8 + compP * 0.15;
    ringCMat.opacity = ringFade * 0.65 + compP * 0.1;

    if (ringARef.current) {
      ringARef.current.rotation.z = t * 0.4;
      ringARef.current.rotation.x = Math.PI / 2 + Math.sin(t * 0.3) * 0.18;
    }
    if (ringBRef.current) {
      ringBRef.current.rotation.x = -t * 0.55;
      ringBRef.current.rotation.y = Math.cos(t * 0.27) * 0.22;
    }
    if (ringCRef.current) {
      ringCRef.current.rotation.y = t * 0.28;
      ringCRef.current.rotation.z = Math.sin(t * 0.41) * 0.3;
    }

    // Scan beam: faint always, bright pulse during compaction
    beamMat.opacity = 0.05 + compP * 0.45 + Math.sin(t * 3.0) * 0.06 * compP;
    if (beamRef.current) beamRef.current.scale.y = 1 + compP * 0.08;
  });

  return (
    <group>
      {/* Podium platform — large flat glowing disc */}
      <mesh
        ref={platformRef}
        position={[0, -1.72, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={platformMat}
      >
        <ringGeometry args={[0.0, 0.78, 64, 1]} />
      </mesh>
      {/* Podium accent ring — outer glow halo */}
      <mesh
        position={[0, -1.715, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={platformMat}
      >
        <ringGeometry args={[0.78, 0.86, 64, 1]} />
      </mesh>

      {/* Vertical scan beam — thin column from podium to head */}
      <mesh ref={beamRef} position={[0, -0.1, 0]} material={beamMat}>
        <cylinderGeometry args={[0.03, 0.03, 3.3, 12, 1, true]} />
      </mesh>

      {/* 3 orbital rings around the chest core (y=0.55) */}
      <mesh ref={ringARef} position={[0, 0.55, 0]} material={ringAMat}>
        <torusGeometry args={[0.45, 0.012, 8, 64]} />
      </mesh>
      <mesh ref={ringBRef} position={[0, 0.55, 0]} material={ringBMat}>
        <torusGeometry args={[0.58, 0.01, 8, 80]} />
      </mesh>
      <mesh ref={ringCRef} position={[0, 0.55, 0]} material={ringCMat}>
        <torusGeometry args={[0.72, 0.008, 8, 96]} />
      </mesh>
    </group>
  );
}
