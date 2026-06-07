"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 03 — Memory Spine. Seven stacked vertebrae running up the back of the
 * torso from lumbar (y ≈ 0.4) to base-of-skull (y ≈ 1.15). Anchored at
 * midpoint (0, 0.775, -0.06) so the chain centers nicely on its target.
 * Tiny emissive disc on each joint sells "neural conduit."
 */

const TARGET = new THREE.Vector3(0, 0.775, -0.06);
const SCATTER = new THREE.Vector3(-1.3, -0.4, 1.7);
const VERTEBRA_COUNT = 7;
const VERTEBRA_RADIUS = 0.08;
const VERTEBRA_HEIGHT = 0.11;
const VERTEBRA_SPACING = 0.115;

export function MemorySpine({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 2,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  const totalHeight = VERTEBRA_SPACING * (VERTEBRA_COUNT - 1);
  const startY = -totalHeight / 2;

  return (
    <group ref={groupRef}>
      {Array.from({ length: VERTEBRA_COUNT }).map((_, i) => {
        const y = startY + i * VERTEBRA_SPACING;
        return (
          <group key={i} position={[0, y, 0]}>
            {/* Vertebra body */}
            <mesh material={shell}>
              <cylinderGeometry args={[VERTEBRA_RADIUS, VERTEBRA_RADIUS * 0.9, VERTEBRA_HEIGHT, 16]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
            {/* Emissive joint disc on top */}
            <mesh material={emissive} position={[0, VERTEBRA_HEIGHT / 2 + 0.005, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <ringGeometry args={[VERTEBRA_RADIUS * 0.45, VERTEBRA_RADIUS * 0.78, 16]} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
