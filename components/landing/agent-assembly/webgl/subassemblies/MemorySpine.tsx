"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import {
  createShellMaterial,
  createChassisMaterial,
  createEmissiveMaterial,
  EMISSIVE_COLOR,
} from "../materials";

/**
 * 03 — Memory Spine (V2). Vertebral column running up the back of the
 * torso. Each vertebra is now a layered 3-component stack (chassis
 * disc + shell collar + emissive joint ring) wired by a CONTINUOUS
 * chassis cable running through the centre — reads as a real neural
 * conduit instead of a stack of beads.
 */

const TARGET = new THREE.Vector3(0, 0.775, -0.06);
const SCATTER = new THREE.Vector3(-1.3, -0.4, 1.7);

const VERTEBRA_COUNT = 7;
const VERTEBRA_HEIGHT = 0.09;
const VERTEBRA_SPACING = 0.115;

export function MemorySpine({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
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
      {/* Central neural cable — continuous chassis rod through every vertebra */}
      <mesh material={chassis}>
        <cylinderGeometry args={[0.025, 0.025, totalHeight + 0.12, 8]} />
      </mesh>
      {/* Cable emissive core — slimmer glowing rod inside the cable */}
      <mesh material={emissive}>
        <cylinderGeometry args={[0.012, 0.012, totalHeight + 0.12, 6]} />
      </mesh>

      {/* Per-vertebra stack */}
      {Array.from({ length: VERTEBRA_COUNT }).map((_, i) => {
        const y = startY + i * VERTEBRA_SPACING;
        return (
          <group key={i} position={[0, y, 0]}>
            {/* Vertebra body — shell collar */}
            <mesh material={shell}>
              <cylinderGeometry args={[0.082, 0.078, VERTEBRA_HEIGHT, 12]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
            {/* Vertebra back fin — short paddle pointing rearward */}
            <mesh material={shell} position={[0, 0, -0.078]}>
              <boxGeometry args={[0.04, 0.06, 0.024]} />
            </mesh>
            {/* Vertebra side studs */}
            {[-1, 1].map((s) => (
              <mesh key={s} material={chassis} position={[s * 0.082, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.018, 0.018, 0.014, 8]} />
              </mesh>
            ))}
            {/* Emissive joint disc on top */}
            <mesh material={emissive} position={[0, VERTEBRA_HEIGHT / 2 + 0.008, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.046, 0.078, 18]} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
