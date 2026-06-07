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
 * 07 — Output Channels (V2). Neck + clavicle yoke assembly. The neck
 * is now a segmented column (chassis collar + shell sleeve + emissive
 * throat band) and the clavicle yoke carries 2 conduit ports on each
 * shoulder where signals cross to the arms.
 */

const TARGET = new THREE.Vector3(0, 1.18, 0);
const SCATTER = new THREE.Vector3(0.2, 1.9, -1.6);

export function OutputChannels({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 6,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* Neck chassis core */}
      <mesh material={chassis}>
        <cylinderGeometry args={[0.06, 0.07, 0.22, 12]} />
      </mesh>
      {/* Neck outer shell sleeve — slightly larger than the chassis */}
      <mesh material={shell}>
        <cylinderGeometry args={[0.078, 0.085, 0.18, 14]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Throat band — emissive horizontal ring at front of neck */}
      <mesh material={emissive} position={[0, 0, 0.082]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.04, 0.006, 6, 18, Math.PI]} />
      </mesh>

      {/* ───────── CLAVICLE YOKE ───────── */}
      {/* Main horizontal bar across the shoulders */}
      <mesh material={shell} position={[0, -0.13, 0]}>
        <boxGeometry args={[0.46, 0.06, 0.12]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Front yoke armor lip */}
      <mesh material={chassis} position={[0, -0.13, 0.066]}>
        <boxGeometry args={[0.42, 0.04, 0.012]} />
      </mesh>
      {/* Clavicle emissive seam line (front) */}
      <mesh material={emissive} position={[0, -0.13, 0.074]}>
        <boxGeometry args={[0.4, 0.008, 0.005]} />
      </mesh>
      {/* Conduit ports — 2 small dots on each clavicle end */}
      {[-1, 1].flatMap((sign) =>
        [-0.022, 0.022].map((dx, i) => (
          <mesh
            key={`${sign}-${i}`}
            material={emissive}
            position={[sign * 0.2 + dx, -0.13, 0.075]}
          >
            <boxGeometry args={[0.015, 0.018, 0.005]} />
          </mesh>
        )),
      )}
    </group>
  );
}
