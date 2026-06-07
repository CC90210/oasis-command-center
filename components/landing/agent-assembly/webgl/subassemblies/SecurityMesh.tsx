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
 * 08 — Security Mesh (V2). Pelvis girdle with utility belt + hip socket
 * connectors that mate to the Command Centre thigh tops.
 *
 *   - Hip girdle:         Top belt block (shell) over a chassis frame
 *   - Front belt buckle:  Centered emissive module (status badge)
 *   - Utility pouches:    2 small chassis boxes on each hip
 *   - Hip socket cylinders + emissive joint rings (at world y=-0.45)
 *   - Belt seam:          Horizontal emissive line across the girdle front
 *   - Back utility port:  Single chassis box on the lumbar back
 */

const TARGET = new THREE.Vector3(0, -0.15, 0);
const SCATTER = new THREE.Vector3(-0.3, -1.7, 1.6);

export function SecurityMesh({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const warm = useMemo(() => createWarmMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 7,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* Inner pelvis frame (chassis) — visible at the gap between belt segments */}
      <mesh material={chassis} position={[0, 0.06, 0]}>
        <boxGeometry args={[0.4, 0.14, 0.22]} />
      </mesh>
      {/* Top hip girdle — shell over the chassis */}
      <mesh material={shell} position={[0, 0.08, 0]}>
        <boxGeometry args={[0.44, 0.16, 0.26]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Belt seam — horizontal emissive line across the girdle front */}
      <mesh material={emissive} position={[0, 0.08, 0.131]}>
        <boxGeometry args={[0.38, 0.012, 0.005]} />
      </mesh>
      {/* Front belt buckle — central emissive module */}
      <mesh material={chassis} position={[0, 0.02, 0.135]}>
        <boxGeometry args={[0.08, 0.06, 0.012]} />
      </mesh>
      <mesh material={warm} position={[0, 0.02, 0.142]}>
        <boxGeometry args={[0.05, 0.04, 0.005]} />
      </mesh>

      {/* Front belt buckle plate — wider tapered shell below girdle */}
      <mesh material={shell} position={[0, -0.07, 0.115]} rotation={[0.2, 0, 0]}>
        <boxGeometry args={[0.36, 0.12, 0.04]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>

      {/* Utility pouches — 2 small chassis boxes on each side */}
      {[-1, 1].map((sign) => (
        <group key={sign}>
          <mesh material={chassis} position={[sign * 0.21, 0.04, 0.07]}>
            <boxGeometry args={[0.06, 0.08, 0.05]} />
          </mesh>
          <mesh material={emissive} position={[sign * 0.21, 0.04, 0.096]}>
            <boxGeometry args={[0.04, 0.012, 0.005]} />
          </mesh>
        </group>
      ))}

      {/* Hip socket connectors — drop down to meet Command Centre thigh tops at y=-0.45 */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * 0.18, -0.2, 0]}>
          <mesh material={shell}>
            <cylinderGeometry args={[0.115, 0.105, 0.22, 16]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Hip joint emissive ring at the bottom */}
          <mesh material={emissive} position={[0, -0.11, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.095, 0.012, 8, 18]} />
          </mesh>
          {/* Side socket bolt cap */}
          <mesh material={chassis} position={[sign * 0.105, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.025, 0.025, 0.024, 8]} />
          </mesh>
        </group>
      ))}

      {/* Back lumbar utility port */}
      <mesh material={chassis} position={[0, 0.05, -0.135]}>
        <boxGeometry args={[0.18, 0.08, 0.02]} />
      </mesh>
      {[-0.06, 0, 0.06].map((x, i) => (
        <mesh key={i} material={emissive} position={[x, 0.05, -0.146]}>
          <boxGeometry args={[0.018, 0.016, 0.005]} />
        </mesh>
      ))}
    </group>
  );
}
