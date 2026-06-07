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
 * 01 — Reasoning Core (V2). Full AI-helmet assembly:
 *
 *   - Cranial dome:        Layered hemisphere (outer shell + inner chassis seam)
 *   - Crown antenna array: 4 spike antennas + central emitter spike
 *   - Side sensor fins:    Angled radar fins on each temple
 *   - Face plate:          Tapered helmet visor frame (chassis tier)
 *   - Jaw guard:           Two-piece jaw assembly with mandible seam
 *   - Forehead sensor:     3-dot LED cluster above the brow
 *   - Cheek armor:         Beveled cheek panels with vertical seams
 *   - Neural conduit:      Cable ports on the back of the skull
 *
 * Anchor (0, 1.35, 0). Reads as "a helmet, not a basketball."
 */

const TARGET = new THREE.Vector3(0, 1.35, 0);
const SCATTER = new THREE.Vector3(-1.4, 1.6, -1.0);

export function ReasoningCore({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const warm = useMemo(() => createWarmMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 0,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* ───────── CRANIAL DOME ───────── */}
      {/* Outer shell — flattened hemisphere */}
      <mesh material={shell} position={[0, 0.1, 0]} scale={[1, 0.92, 1.02]}>
        <sphereGeometry args={[0.22, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.58]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Inner chassis ring at dome base — visible seam */}
      <mesh material={chassis} position={[0, 0.06, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.215, 0.012, 8, 32]} />
      </mesh>
      {/* Top emissive panel — central crown plate */}
      <mesh material={emissive} position={[0, 0.28, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.018, 0.052, 16]} />
      </mesh>

      {/* ───────── ANTENNA ARRAY ───────── */}
      {/* Central tall antenna with amber tip */}
      <mesh material={chassis} position={[0, 0.34, 0]}>
        <cylinderGeometry args={[0.008, 0.012, 0.12, 8]} />
      </mesh>
      <mesh material={warm} position={[0, 0.41, 0]}>
        <sphereGeometry args={[0.012, 8, 8]} />
      </mesh>
      {/* 4 side antennas — short spikes around the crown */}
      {[
        [0.08, 0.05, -0.08],
        [-0.08, 0.05, -0.08],
        [0.08, 0.05, 0.08],
        [-0.08, 0.05, 0.08],
      ].map(([x, dy, z], i) => (
        <group key={i} position={[x, 0.27 + dy, z]}>
          <mesh material={chassis}>
            <coneGeometry args={[0.012, 0.08, 6]} />
          </mesh>
          <mesh material={emissive} position={[0, 0.045, 0]}>
            <sphereGeometry args={[0.008, 6, 6]} />
          </mesh>
        </group>
      ))}

      {/* ───────── SIDE SENSOR FINS (radar dishes on each temple) ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * 0.21, 0.06, 0]} rotation={[0, sign * -0.3, sign * 0.5]}>
          <mesh material={chassis}>
            <boxGeometry args={[0.04, 0.14, 0.04]} />
          </mesh>
          <mesh material={shell} position={[sign * 0.04, 0, 0]} rotation={[0, sign * Math.PI / 2, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.012, 12]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
          </mesh>
          {/* Dish emissive center */}
          <mesh material={emissive} position={[sign * 0.047, 0, 0]} rotation={[0, sign * Math.PI / 2, 0]}>
            <ringGeometry args={[0.008, 0.03, 12]} />
          </mesh>
        </group>
      ))}

      {/* ───────── FACE PLATE / JAW ───────── */}
      {/* Upper face plate — front-facing recessed panel for the visor */}
      <mesh material={chassis} position={[0, -0.02, 0.16]} rotation={[-0.05, 0, 0]}>
        <boxGeometry args={[0.26, 0.18, 0.02]} />
      </mesh>
      {/* Outer face plate — wraps the face */}
      <mesh material={shell} position={[0, -0.04, 0.01]}>
        <boxGeometry args={[0.32, 0.22, 0.28]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Jaw guard — upper jaw piece */}
      <mesh material={shell} position={[0, -0.18, 0.03]}>
        <boxGeometry args={[0.24, 0.06, 0.22]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Jaw chin guard — lower piece, slightly narrower */}
      <mesh material={shell} position={[0, -0.235, 0.025]}>
        <boxGeometry args={[0.2, 0.05, 0.18]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Mandible seam — horizontal emissive line between jaw pieces */}
      <mesh material={emissive} position={[0, -0.21, 0.142]}>
        <boxGeometry args={[0.16, 0.006, 0.005]} />
      </mesh>

      {/* ───────── FOREHEAD SENSOR CLUSTER ───────── */}
      {/* Brow band — large horizontal emissive bar */}
      <mesh material={emissive} position={[0, 0.06, 0.151]}>
        <boxGeometry args={[0.18, 0.018, 0.005]} />
      </mesh>
      {/* 3 small LED dots above the brow */}
      {[-0.06, 0, 0.06].map((x, i) => (
        <mesh key={i} material={warm} position={[x, 0.085, 0.152]}>
          <boxGeometry args={[0.012, 0.008, 0.004]} />
        </mesh>
      ))}

      {/* ───────── CHEEK ARMOR with vertical seams ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign}>
          {/* Cheek panel — beveled outward */}
          <mesh material={shell} position={[sign * 0.155, -0.07, 0.08]} rotation={[0, sign * -0.15, 0]}>
            <boxGeometry args={[0.04, 0.18, 0.14]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
          </mesh>
          {/* Vertical cheek seam */}
          <mesh material={emissive} position={[sign * 0.175, -0.07, 0.142]}>
            <boxGeometry args={[0.005, 0.14, 0.005]} />
          </mesh>
        </group>
      ))}

      {/* ───────── NEURAL CONDUIT PORTS (back of skull) ───────── */}
      {[-0.06, 0.06].map((x, i) => (
        <group key={i} position={[x, 0, -0.16]}>
          <mesh material={chassis}>
            <cylinderGeometry args={[0.018, 0.018, 0.04, 8]} />
          </mesh>
          <mesh material={emissive} position={[0, 0.022, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.004, 8]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
