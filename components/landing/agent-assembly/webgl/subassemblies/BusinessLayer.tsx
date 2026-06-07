"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import {
  createShellMaterial,
  createChassisMaterial,
  createEmissiveMaterial,
  createWarmMaterial,
  EMISSIVE_COLOR,
} from "../materials";

/**
 * 09 — Business Layer (V2). Upper-arm armor segments + sternum cooling
 * module + chest status indicator strip.
 *
 *   - Upper arms: 3-segment armor (deltoid cap + bicep tube + elbow socket)
 *                 with chassis bicep cylinder underneath each shell
 *   - Sternum:    Recessed cooling-vent module (5 vertical grille slats
 *                 over a chassis backplate) flanked by accent strips
 *   - Status:     6-segment horizontal indicator bar across the collar
 *                 (5 green + 1 amber, like a power-state row)
 *
 * Anchored at chest mid-height (0, 0.55, 0). Upper arms span world
 * y=0.34 → 0.74; elbow sockets at y=0.34 align with BridgeTools
 * forearm tops.
 */

const TARGET = new THREE.Vector3(0, 0.55, 0);
const SCATTER = new THREE.Vector3(-1.4, -0.3, -1.4);

const SHOULDER_X = 0.32;
const UPPER_ARM_LEN = 0.34;

export function BusinessLayer({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const warm = useMemo(() => createWarmMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 8,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* ───────── UPPER ARMS (both sides, layered armor) ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * SHOULDER_X, -0.01, 0]}>
          {/* Inner chassis bicep — slimmer, sits inside the armor */}
          <mesh material={chassis}>
            <cylinderGeometry args={[0.058, 0.062, UPPER_ARM_LEN + 0.04, 12]} />
          </mesh>
          {/* Deltoid armor cap — top of the bicep */}
          <mesh material={shell} position={[0, 0.13, 0]}>
            <cylinderGeometry args={[0.088, 0.082, 0.1, 14]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Bicep armor tube — main arm segment */}
          <mesh material={shell} position={[0, -0.01, 0]}>
            <cylinderGeometry args={[0.082, 0.078, 0.2, 14]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Elbow socket — wider at the bottom */}
          <mesh material={shell} position={[0, -0.15, 0]}>
            <cylinderGeometry args={[0.085, 0.075, 0.08, 14]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Bicep emissive seam — vertical line on the OUTER face */}
          <mesh material={emissive} position={[sign * 0.082, -0.01, 0]}>
            <boxGeometry args={[0.004, 0.18, 0.018]} />
          </mesh>
          {/* Elbow ball-joint emissive ring */}
          <mesh material={emissive} position={[0, -0.21, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.078, 0.011, 8, 18]} />
          </mesh>
        </group>
      ))}

      {/* ───────── STERNUM COOLING MODULE ───────── */}
      {/* Backplate — recessed chassis behind the grille */}
      <mesh material={chassis} position={[0, 0.05, 0.158]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.18, 0.42, 0.02]} />
      </mesh>
      {/* Outer sternum frame — shell border around the cooling vent */}
      <mesh material={shell} position={[0, 0.05, 0.16]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.24, 0.46, 0.05]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* 5 vertical cooling-vent slats — chassis (dark) over the cutout */}
      {[-0.06, -0.03, 0, 0.03, 0.06].map((x, i) => (
        <mesh key={i} material={chassis} position={[x, 0.05, 0.183]} rotation={[0.04, 0, 0]}>
          <boxGeometry args={[0.014, 0.36, 0.01]} />
        </mesh>
      ))}
      {/* Vent emissive backlight — single bar behind the slats */}
      <mesh material={emissive} position={[0, 0.05, 0.169]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.13, 0.32, 0.005]} />
      </mesh>
      {/* Sternum top accent — horizontal bar */}
      <mesh material={emissive} position={[0, 0.27, 0.19]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.2, 0.012, 0.003]} />
      </mesh>
      {/* Sternum bottom accent */}
      <mesh material={emissive} position={[0, -0.17, 0.19]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.2, 0.012, 0.003]} />
      </mesh>

      {/* ───────── STATUS INDICATOR ROW (collar bar) ───────── */}
      {[-0.06, -0.036, -0.012, 0.012, 0.036].map((x, i) => (
        <mesh key={i} material={emissive} position={[x, 0.295, 0.191]} rotation={[0.04, 0, 0]}>
          <boxGeometry args={[0.018, 0.018, 0.004]} />
        </mesh>
      ))}
      {/* Last segment in amber */}
      <mesh material={warm} position={[0.06, 0.295, 0.191]} rotation={[0.04, 0, 0]}>
        <boxGeometry args={[0.018, 0.018, 0.004]} />
      </mesh>
    </group>
  );
}
