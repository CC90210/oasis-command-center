"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 10 — Command Centre. The biggest single subassembly: both legs
 * (thigh capsule, knee ring, shin capsule, foot) + the activation
 * podium with its glowing ring + center disc.
 *
 * Anatomy math (capsule total height = length 0.42 + 2*radius 0.10 = 0.62,
 * so half-height = 0.31):
 *   - Thigh local center y = +0.10, so capsule spans local y = -0.21 to +0.41
 *   - SecurityMesh hip socket ring sits at world y = -0.15 + (-0.30) = -0.45
 *   - For thigh TOP to meet hip socket at y=-0.45:
 *       TARGET.y + 0.41 = -0.45  →  TARGET.y = -0.86
 *   - World shin spans roughly y=-1.04 to -1.51
 *   - World foot bottom ≈ -1.555, podium top ≈ -1.56 → foot rests on podium
 *
 * Scatter origin is below the figure so the part RISES into view from
 * below, which feels load-bearing — the right physics read for "legs".
 */

const TARGET = new THREE.Vector3(0, -0.86, 0);
const SCATTER = new THREE.Vector3(0.3, -2.4, -1.4);

const HIP_OFFSET = 0.16;        // horizontal stance — slightly wider than pelvis sockets
const THIGH_LEN = 0.42;
const SHIN_LEN = 0.42;
const FOOT_OFFSET_Z = 0.04;     // toe-forward bias for stance

export function CommandCentre({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 9,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {(["left", "right"] as const).map((side) => {
        const sign = side === "left" ? -1 : 1;
        return (
          <group key={side} position={[sign * HIP_OFFSET, 0, 0]}>
            {/* Thigh — top of capsule at world y=-0.4 + (0 + THIGH_LEN/2 + 0.10) = -0.09,
                bottom of capsule at world y=-0.4 + (0 - THIGH_LEN/2 + 0.10) = -0.51 */}
            <mesh material={shell} position={[0, 0.1, 0]}>
              <capsuleGeometry args={[0.1, THIGH_LEN, 6, 16]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
            {/* Knee joint emissive band */}
            <mesh material={emissive} position={[0, -0.13, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.1, 0.013, 8, 16]} />
            </mesh>
            {/* Shin */}
            <mesh material={shell} position={[0, -0.36, 0]}>
              <capsuleGeometry args={[0.085, SHIN_LEN, 6, 16]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
            {/* Ankle joint */}
            <mesh material={emissive} position={[0, -0.6, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.085, 0.011, 8, 14]} />
            </mesh>
            {/* Foot */}
            <mesh material={shell} position={[0, -0.66, FOOT_OFFSET_Z]}>
              <boxGeometry args={[0.13, 0.07, 0.22]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
          </group>
        );
      })}
      {/* Podium base — main disc */}
      <mesh material={shell} position={[0, -0.74, 0]}>
        <cylinderGeometry args={[0.58, 0.62, 0.08, 32]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Inner podium step */}
      <mesh material={shell} position={[0, -0.69, 0]}>
        <cylinderGeometry args={[0.44, 0.5, 0.05, 32]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Podium glow ring — large emissive torus on the floor */}
      <mesh material={emissive} position={[0, -0.7, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.52, 0.014, 8, 48]} />
      </mesh>
      {/* Center activation disc */}
      <mesh material={emissive} position={[0, -0.66, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.06, 0.2, 24]} />
      </mesh>
    </group>
  );
}
