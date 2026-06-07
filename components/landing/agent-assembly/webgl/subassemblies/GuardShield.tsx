"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 06 — Guard Shield. The shoulder pauldrons + chest armor plates (front
 * and back). Anchored at shoulder-line (0, 0.85, 0). The two pauldrons
 * use sphere fragments to read as rounded armor caps; the chest plates
 * are gently curved boxes flanking the State Pulse heart core.
 */

const TARGET = new THREE.Vector3(0, 0.85, 0);
const SCATTER = new THREE.Vector3(1.4, 1.0, 1.2);

export function GuardShield({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 5,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* Left pauldron — sphere fragment */}
      <mesh material={shell} position={[-0.3, 0, 0]} rotation={[0, 0, 0]}>
        <sphereGeometry args={[0.18, 18, 14, 0, Math.PI, 0, Math.PI * 0.55]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Right pauldron — mirrored */}
      <mesh material={shell} position={[0.3, 0, 0]} rotation={[0, Math.PI, 0]}>
        <sphereGeometry args={[0.18, 18, 14, 0, Math.PI, 0, Math.PI * 0.55]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Front chest plate */}
      <mesh material={shell} position={[0, -0.18, 0.13]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[0.32, 0.34, 0.06]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Back chest plate */}
      <mesh material={shell} position={[0, -0.18, -0.13]} rotation={[-0.12, 0, 0]}>
        <boxGeometry args={[0.32, 0.34, 0.06]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Pauldron emissive seam line */}
      <mesh material={emissive} position={[0, -0.05, 0.14]}>
        <boxGeometry args={[0.28, 0.012, 0.002]} />
      </mesh>
    </group>
  );
}
