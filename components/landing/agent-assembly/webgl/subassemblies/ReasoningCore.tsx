"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 01 — Reasoning Core. Full head assembly:
 *   - Cranial dome (upper half-sphere)
 *   - Lower skull / face plate (slightly forward-tapered box)
 *   - Jaw structure (rounded box at the chin)
 *   - Forehead emissive band (the brow line)
 *   - Cheek seam (vertical OASIS green stripe each side)
 *
 * Anchored at (0, 1.35, 0). The dome top reaches y≈1.6 (top of figure)
 * and the jaw bottom sits at y≈1.12 where it meets the Output Channels
 * neck cylinder (whose top is at y=1.27).
 */

const TARGET = new THREE.Vector3(0, 1.35, 0);
const SCATTER = new THREE.Vector3(-1.4, 1.6, -1.0);

export function ReasoningCore({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 0,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* Cranial dome — upper half sphere, slightly flattened */}
      <mesh material={shell} position={[0, 0.1, 0]} scale={[1, 0.95, 1]}>
        <sphereGeometry args={[0.22, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.6]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Lower skull / face plate — box tapered toward the chin */}
      <mesh material={shell} position={[0, -0.04, 0.01]}>
        <boxGeometry args={[0.32, 0.22, 0.28]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Jaw / chin bar */}
      <mesh material={shell} position={[0, -0.19, 0.02]}>
        <boxGeometry args={[0.24, 0.07, 0.2]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Forehead brow band — emissive line across the top of the face plate */}
      <mesh material={emissive} position={[0, 0.08, 0.15]}>
        <boxGeometry args={[0.22, 0.018, 0.005]} />
      </mesh>
      {/* Left cheek vertical seam */}
      <mesh material={emissive} position={[-0.13, -0.04, 0.14]}>
        <boxGeometry args={[0.008, 0.16, 0.005]} />
      </mesh>
      {/* Right cheek vertical seam */}
      <mesh material={emissive} position={[0.13, -0.04, 0.14]}>
        <boxGeometry args={[0.008, 0.16, 0.005]} />
      </mesh>
      {/* Antenna / crown tip — small spike at the very top */}
      <mesh material={emissive} position={[0, 0.27, 0]}>
        <coneGeometry args={[0.018, 0.06, 8]} />
      </mesh>
    </group>
  );
}
