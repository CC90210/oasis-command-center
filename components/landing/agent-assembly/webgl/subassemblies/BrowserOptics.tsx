"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import {
  createChassisMaterial,
  createEmissiveMaterial,
  createWarmMaterial,
} from "../materials";

/**
 * 04 — Browser Optics (V3). The face. Now sized to FILL the
 * Reasoning Core face cavity (which V3 left as recessed chassis
 * negative space, framed by a thin shell border).
 *
 * Anatomy:
 *   - Visor bar         — wide horizontal emissive band across the face cavity
 *   - 2 prominent eye lenses (large, centered in the visor bar)
 *   - Pupil cores       — bright warm-amber dots inside each iris
 *   - HUD strip         — thin emissive line above the visor for tech feel
 *   - Scanner segments  — small flanking emissive cubes outside the eye lenses
 *   - Temple sensors    — chassis side cubes at the helmet temples
 *   - Bridge status LED — amber dot above the bridge of the nose
 *
 * The visor bar is now a flat extruded box (not a curved torus) so it
 * presents BIG on camera. The eyes are 0.038 radius (was 0.026) — 46%
 * larger so they read clearly even at 50% screen scale.
 */

const TARGET = new THREE.Vector3(0, 1.36, 0.17);
const SCATTER = new THREE.Vector3(1.5, 1.2, -1.1);

const EYE_X = 0.066;
const EYE_R = 0.038;

export function BrowserOptics({ forceInstalled = false }: { forceInstalled?: boolean }) {
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
      {/* ───────── VISOR BAR ───────── */}
      {/* Chassis backing — slightly behind the emissive band */}
      <mesh material={chassis} position={[0, 0, -0.005]}>
        <boxGeometry args={[0.24, 0.07, 0.018]} />
      </mesh>
      {/* Main visor emissive bar — the dominant feature of the face */}
      <mesh material={emissive} position={[0, 0, 0.002]}>
        <boxGeometry args={[0.22, 0.058, 0.012]} />
      </mesh>

      {/* ───────── PRIMARY EYE LENSES ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * EYE_X, 0, 0.012]}>
          {/* Lens frame — slim chassis bezel */}
          <mesh material={chassis} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[EYE_R + 0.004, EYE_R + 0.004, 0.008, 18]} />
          </mesh>
          {/* Iris — bright emissive disc */}
          <mesh material={emissive} position={[0, 0, 0.006]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[EYE_R, EYE_R, 0.006, 18]} />
          </mesh>
          {/* Pupil core — small warm dot inside the iris */}
          <mesh material={warm} position={[0, 0, 0.012]}>
            <sphereGeometry args={[0.011, 10, 10]} />
          </mesh>
        </group>
      ))}

      {/* ───────── HUD ACCENT STRIPS ───────── */}
      {/* Upper HUD line — above the visor */}
      <mesh material={emissive} position={[0, 0.038, 0.005]}>
        <boxGeometry args={[0.18, 0.004, 0.006]} />
      </mesh>
      {/* Lower HUD line — below the visor */}
      <mesh material={emissive} position={[0, -0.038, 0.005]}>
        <boxGeometry args={[0.14, 0.003, 0.006]} />
      </mesh>

      {/* ───────── SCANNER SEGMENTS (flanking the eyes) ───────── */}
      {/* Inner — between the two eyes (bridge of the nose) */}
      <mesh material={emissive} position={[0, 0, 0.007]}>
        <boxGeometry args={[0.008, 0.022, 0.006]} />
      </mesh>
      {/* Outer scanners — small cubes on each outer edge */}
      {[-0.105, 0.105].map((x, i) => (
        <mesh key={i} material={emissive} position={[x, 0, 0.006]}>
          <boxGeometry args={[0.012, 0.018, 0.006]} />
        </mesh>
      ))}

      {/* ───────── TEMPLE SENSORS ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * 0.135, 0, 0]}>
          <mesh material={chassis}>
            <boxGeometry args={[0.02, 0.06, 0.05]} />
          </mesh>
          <mesh material={emissive} position={[sign * 0.011, 0, 0]}>
            <boxGeometry args={[0.005, 0.04, 0.04]} />
          </mesh>
        </group>
      ))}

      {/* ───────── BRIDGE STATUS LED ───────── */}
      <mesh material={warm} position={[0, 0.05, 0.012]}>
        <boxGeometry args={[0.018, 0.008, 0.005]} />
      </mesh>
    </group>
  );
}
