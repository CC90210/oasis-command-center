"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 07 — Output Channels. Neck cylinder + clavicle yoke (the bar across
 * the upper chest where shoulders attach). Anchored at (0, 1.18, 0) —
 * sits between the chest plates (Guard Shield) and the jaw (Reasoning
 * Core), so this part is what visually connects the head to the torso.
 */

const TARGET = new THREE.Vector3(0, 1.18, 0);
const SCATTER = new THREE.Vector3(0.2, 1.9, -1.6);

export function OutputChannels({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 6,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* Neck cylinder */}
      <mesh material={shell}>
        <cylinderGeometry args={[0.08, 0.09, 0.18, 16]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Clavicle yoke — horizontal bar across upper shoulders */}
      <mesh material={shell} position={[0, -0.13, 0]}>
        <boxGeometry args={[0.46, 0.06, 0.12]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Throat emissive band (vocal/output line) */}
      <mesh material={emissive} position={[0, 0, 0.085]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.06, 0.008, 8, 16, Math.PI]} />
      </mesh>
    </group>
  );
}
