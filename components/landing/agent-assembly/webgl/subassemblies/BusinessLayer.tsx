"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 09 — Business Layer. Upper arms (shoulder-to-elbow) + sternum chest
 * panel with a vertical OASIS green seam. Anchored at chest mid-height
 * (0, 0.55, 0). Upper arm capsules span world y=0.34 → 0.74; their
 * bottoms (elbows) meet the Bridge Tools forearm tops at y=0.38 after
 * BridgeTools' anchor was raised to y=0.18.
 */

const TARGET = new THREE.Vector3(0, 0.55, 0);
const SCATTER = new THREE.Vector3(-1.4, -0.3, -1.4);

const SHOULDER_X = 0.32;
const UPPER_ARM_LEN = 0.38;

export function BusinessLayer({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 8,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* Left upper arm */}
      <mesh material={shell} position={[-SHOULDER_X, -0.01, 0]}>
        <capsuleGeometry args={[0.082, UPPER_ARM_LEN, 6, 16]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Right upper arm */}
      <mesh material={shell} position={[SHOULDER_X, -0.01, 0]}>
        <capsuleGeometry args={[0.082, UPPER_ARM_LEN, 6, 16]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Elbow joint emissive rings */}
      <mesh material={emissive} position={[-SHOULDER_X, -0.22, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.082, 0.012, 8, 14]} />
      </mesh>
      <mesh material={emissive} position={[SHOULDER_X, -0.22, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.082, 0.012, 8, 14]} />
      </mesh>
      {/* Sternum chest panel — tall, narrow, slightly forward */}
      <mesh material={shell} position={[0, 0.05, 0.16]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.22, 0.42, 0.05]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Vertical OASIS green seam down the sternum */}
      <mesh material={emissive} position={[0, 0.05, 0.187]}>
        <boxGeometry args={[0.014, 0.36, 0.003]} />
      </mesh>
      {/* Horizontal collar bar — sits above the sternum, just below clavicle */}
      <mesh material={emissive} position={[0, 0.24, 0.187]}>
        <boxGeometry args={[0.18, 0.014, 0.003]} />
      </mesh>
    </group>
  );
}
