"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useSceneBridge } from "./SceneBridge";
import { buildAdditiveMaterial, PRIMARY_GREEN } from "./materials";

/**
 * HoloAccents — V5 simplified. The OasisCore now owns the atmosphere
 * rings around the core itself, and the OrbitalRig provides the
 * 10 orbiting modules — so this layer is reduced to:
 *
 *   - Glowing podium platform UNDER the orbital scene (grounds it visually)
 *   - Vertical scan beam through the core (pulses with compaction)
 *
 * Both are additive-blended so they add light to the scene without
 * occluding the floating geometry above.
 */

type Props = { forceInstalled?: boolean };

export function HoloAccents({ forceInstalled = false }: Props) {
  const bridge = useSceneBridge();

  const platformRef = useRef<THREE.Mesh | null>(null);
  const beamRef = useRef<THREE.Mesh | null>(null);

  const platformMat = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0.5, doubleSide: true }),
    [],
  );
  const haloMat = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0.3, doubleSide: true }),
    [],
  );
  const beamMat = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0, doubleSide: true }),
    [],
  );

  useFrame((state) => {
    if (forceInstalled) {
      platformMat.opacity = 0.55;
      haloMat.opacity = 0.32;
      beamMat.opacity = 0.18;
      return;
    }

    const t = state.clock.elapsedTime;
    const overall = Math.min(1, bridge.current.install.reduce((a, b) => a + b, 0) / 10);
    const compP = THREE.MathUtils.clamp(bridge.current.compaction, 0, 1);

    // Podium: always-on, brightens with overall progress + compaction pulse
    platformMat.opacity = 0.3 + overall * 0.3 + compP * 0.2;
    haloMat.opacity = 0.15 + overall * 0.18 + compP * 0.15;
    if (platformRef.current) platformRef.current.rotation.z = t * 0.18;

    // Scan beam: faint always, bright pulse during compaction
    beamMat.opacity = 0.04 + compP * 0.35 + Math.sin(t * 3.0) * 0.05 * compP;
    if (beamRef.current) beamRef.current.scale.y = 1 + compP * 0.06;
  });

  return (
    <group>
      {/* Podium platform — large flat glowing disc UNDER the core */}
      <mesh
        ref={platformRef}
        position={[0, -1.45, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={platformMat}
      >
        <ringGeometry args={[0.0, 0.95, 64, 1]} />
      </mesh>
      {/* Podium accent ring — outer glow halo */}
      <mesh
        position={[0, -1.445, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={haloMat}
      >
        <ringGeometry args={[0.95, 1.15, 64, 1]} />
      </mesh>
      {/* Inner podium ring — defines a "stage" the agent stands on */}
      <mesh
        position={[0, -1.44, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={haloMat}
      >
        <ringGeometry args={[0.65, 0.68, 64, 1]} />
      </mesh>

      {/* Vertical scan beam — thin column from podium through the core */}
      <mesh ref={beamRef} position={[0, -0.3, 0]} material={beamMat}>
        <cylinderGeometry args={[0.04, 0.04, 2.4, 12, 1, true]} />
      </mesh>
    </group>
  );
}
