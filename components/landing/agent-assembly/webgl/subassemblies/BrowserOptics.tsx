"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import {
  createShellMaterial,
  createChassisMaterial,
  createEmissiveMaterial,
  createWarmMaterial,
  EMISSIVE_COLOR,
} from "../materials";

/**
 * 04 — Browser Optics (V2). HUD-style multi-segment visor array.
 *
 *   - Visor frame:        Chassis arc forming the recessed eye slot
 *   - Main visor band:    Shell torus arc wrapping the front of the face
 *   - 2 primary eye lenses:  Outer emissive cylinders (the "pupils")
 *   - 2 secondary scanner segments: Smaller emissive cubes flanking the eyes
 *   - HUD accent strip:   Thin horizontal line across the visor
 *   - Side temple sensors: Small chassis cubes at each temple
 *   - Status dot:         Single warm-amber LED above the bridge
 *
 * Anchor (0, 1.36, 0.10) — centred on the Reasoning Core face plate.
 * Rotation chain: rotate X by π/2 to tilt the torus into XZ plane,
 * then Z by π/2 - VISOR_ARC/2 so the arc midpoint faces +Z (forward).
 */

const TARGET = new THREE.Vector3(0, 1.36, 0.10);
const SCATTER = new THREE.Vector3(1.5, 1.2, -1.1);

const VISOR_R = 0.14;
const VISOR_TUBE_R = 0.025;
const VISOR_ARC = Math.PI * 0.7;       // 126° — front-only wrap

export function BrowserOptics({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const warm = useMemo(() => createWarmMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 3,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* Visor chassis frame — slimmer dark band sitting behind the shell */}
      <mesh material={chassis} rotation={[Math.PI / 2, 0, Math.PI / 2 - VISOR_ARC / 2]}>
        <torusGeometry args={[VISOR_R, 0.015, 8, 32, VISOR_ARC]} />
      </mesh>
      {/* Main visor band — shell, slightly larger so it caps the chassis */}
      <mesh material={shell} rotation={[Math.PI / 2, 0, Math.PI / 2 - VISOR_ARC / 2]}>
        <torusGeometry args={[VISOR_R, VISOR_TUBE_R, 12, 32, VISOR_ARC]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>

      {/* HUD accent strip — thin emissive bar across the upper visor */}
      <mesh material={emissive} position={[0, 0.018, VISOR_R * 0.95]}>
        <boxGeometry args={[0.14, 0.004, 0.004]} />
      </mesh>
      {/* Secondary HUD strip — below */}
      <mesh material={emissive} position={[0, -0.022, VISOR_R * 0.95]}>
        <boxGeometry args={[0.1, 0.003, 0.004]} />
      </mesh>

      {/* ───────── EYE LENSES (cylinders facing forward) ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * 0.062, 0, VISOR_R * 0.85]}>
          {/* Outer chassis lens frame */}
          <mesh material={chassis} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.026, 0.026, 0.012, 16]} />
          </mesh>
          {/* Emissive lens (the "iris") */}
          <mesh material={emissive} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.008]}>
            <cylinderGeometry args={[0.022, 0.022, 0.008, 16]} />
          </mesh>
          {/* Centre pupil dot */}
          <mesh material={warm} position={[0, 0, 0.015]}>
            <sphereGeometry args={[0.006, 8, 8]} />
          </mesh>
        </group>
      ))}

      {/* ───────── SECONDARY SCANNER SEGMENTS (small flanking cubes) ───────── */}
      {[-0.112, -0.096, 0.096, 0.112].map((x, i) => (
        <mesh key={i} material={emissive} position={[x, 0, VISOR_R * 0.78]}>
          <boxGeometry args={[0.009, 0.009, 0.005]} />
        </mesh>
      ))}

      {/* ───────── TEMPLE SENSORS (small chassis cubes on each side) ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * VISOR_R * 0.95, 0, 0.005]}>
          <mesh material={chassis}>
            <boxGeometry args={[0.018, 0.04, 0.05]} />
          </mesh>
          <mesh material={emissive} position={[sign * 0.01, 0, 0]}>
            <boxGeometry args={[0.004, 0.026, 0.04]} />
          </mesh>
        </group>
      ))}

      {/* ───────── BRIDGE STATUS LED ───────── */}
      <mesh material={warm} position={[0, 0.045, VISOR_R * 0.95]}>
        <boxGeometry args={[0.012, 0.008, 0.005]} />
      </mesh>
    </group>
  );
}
