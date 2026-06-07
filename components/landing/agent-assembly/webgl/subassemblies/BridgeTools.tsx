"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 05 — Bridge Tools. The forearms + hands — both at once, mirrored across
 * the Y axis. Each side gets a capsule forearm + rounded box hand. Group
 * is anchored at chest-height (0, 0.0, 0); the symmetric meshes are
 * positioned at ±0.38. Scatters into view from off-screen-left for the
 * whole pair to "thump" home together.
 */

const TARGET = new THREE.Vector3(0, 0.18, 0);
const SCATTER = new THREE.Vector3(-1.5, -0.1, 1.4);

export function BridgeTools({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 4,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {(["left", "right"] as const).map((side) => {
        const sign = side === "left" ? -1 : 1;
        return (
          <group key={side} position={[sign * 0.38, 0, 0]}>
            {/* Forearm — capsule */}
            <mesh material={shell} position={[0, 0.05, 0]}>
              <capsuleGeometry args={[0.07, 0.4, 8, 16]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
            {/* Wrist joint emissive band */}
            <mesh material={emissive} position={[0, -0.22, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.08, 0.012, 8, 16]} />
            </mesh>
            {/* Hand */}
            <mesh material={shell} position={[0, -0.32, 0]}>
              <boxGeometry args={[0.13, 0.18, 0.07]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
