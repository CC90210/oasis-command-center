"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 08 — Security Mesh. Pelvis girdle + hip connectors + thigh-socket caps.
 * Anchored at (0, -0.15, 0) so the girdle sits at the natural hip line.
 * Includes explicit hip connector cylinders that drop from the girdle to
 * meet the Command Centre thigh tops — without them the figure looked
 * like a floating torso above floating legs at the assembled state.
 */

const TARGET = new THREE.Vector3(0, -0.15, 0);
const SCATTER = new THREE.Vector3(-0.3, -1.7, 1.6);

export function SecurityMesh({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 7,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* Pelvis girdle — top of hip belt */}
      <mesh material={shell} position={[0, 0.06, 0]}>
        <boxGeometry args={[0.42, 0.18, 0.26]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Front belt buckle plate (tapers down) */}
      <mesh material={shell} position={[0, -0.08, 0.12]} rotation={[0.2, 0, 0]}>
        <boxGeometry args={[0.38, 0.14, 0.04]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Left hip socket connector — drops down to meet thigh top at world y=-0.6 */}
      <mesh material={shell} position={[-0.18, -0.18, 0]}>
        <cylinderGeometry args={[0.12, 0.11, 0.22, 16]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Right hip socket connector */}
      <mesh material={shell} position={[0.18, -0.18, 0]}>
        <cylinderGeometry args={[0.12, 0.11, 0.22, 16]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Left hip joint emissive ring (socket) */}
      <mesh material={emissive} position={[-0.18, -0.3, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.09, 0.014, 8, 18]} />
      </mesh>
      {/* Right hip joint emissive ring */}
      <mesh material={emissive} position={[0.18, -0.3, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.09, 0.014, 8, 18]} />
      </mesh>
      {/* Belt seam — horizontal OASIS green stripe across the girdle */}
      <mesh material={emissive} position={[0, 0.06, 0.131]}>
        <boxGeometry args={[0.38, 0.012, 0.002]} />
      </mesh>
    </group>
  );
}
