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
 * 10 — Command Centre (V2). Both legs (multi-segment armor + servo
 * joints) + multi-tier activation podium with glyph ring.
 *
 * Per leg:
 *   - Hip cap                  (chassis ball joint at the top)
 *   - Thigh chassis tube       (slim actuator inside)
 *   - Thigh armor plates       (front + back shells)
 *   - Knee servo cluster       (chassis sphere + emissive ring + side caps)
 *   - Shin chassis tube
 *   - Shin armor plates        (greaves)
 *   - Ankle servo ring
 *   - Foot armor               (toe segment + heel segment + sole plate)
 *
 * Podium:
 *   - Lower base disc          (chassis, widest)
 *   - Mid step (shell)
 *   - Upper platform (shell, narrower)
 *   - Emissive glyph ring outside the platform
 *   - 6 small floor markers around the perimeter
 *   - Center activation disc with concentric rings
 *
 * Anchor (0, -0.86, 0). Thigh top at world y=-0.45 mates with the
 * SecurityMesh hip socket ring.
 */

const TARGET = new THREE.Vector3(0, -0.86, 0);
const SCATTER = new THREE.Vector3(0.3, -2.4, -1.4);

const HIP_X = 0.16;
const THIGH_LEN = 0.36;
const SHIN_LEN = 0.36;

export function CommandCentre({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const warm = useMemo(() => createWarmMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 9,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* ───────── LEGS ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * HIP_X, 0, 0]}>
          {/* Hip cap — chassis ball at the top */}
          <mesh material={chassis} position={[0, 0.31, 0]}>
            <sphereGeometry args={[0.082, 14, 10]} />
          </mesh>
          <mesh material={emissive} position={[0, 0.31, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.082, 0.006, 6, 18]} />
          </mesh>

          {/* Thigh chassis tube — slim actuator inside the armor */}
          <mesh material={chassis} position={[0, 0.1, 0]}>
            <cylinderGeometry args={[0.07, 0.075, THIGH_LEN, 12]} />
          </mesh>
          {/* Thigh front armor plate */}
          <mesh material={shell} position={[0, 0.1, 0.05]}>
            <boxGeometry args={[0.12, THIGH_LEN, 0.08]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Thigh back armor plate */}
          <mesh material={shell} position={[0, 0.1, -0.05]}>
            <boxGeometry args={[0.12, THIGH_LEN, 0.06]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Thigh outer vent line */}
          <mesh material={emissive} position={[sign * 0.062, 0.1, 0]}>
            <boxGeometry args={[0.004, THIGH_LEN * 0.7, 0.016]} />
          </mesh>

          {/* ───────── KNEE SERVO CLUSTER ───────── */}
          {/* Central servo sphere */}
          <mesh material={chassis} position={[0, -0.13, 0]}>
            <sphereGeometry args={[0.078, 14, 10]} />
          </mesh>
          {/* Knee ring */}
          <mesh material={emissive} position={[0, -0.13, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.082, 0.008, 6, 20]} />
          </mesh>
          {/* Knee side caps — small disc on each side */}
          {[-1, 1].map((s) => (
            <mesh
              key={s}
              material={shell}
              position={[s * 0.082, -0.13, 0]}
              rotation={[0, 0, Math.PI / 2]}
            >
              <cylinderGeometry args={[0.04, 0.04, 0.018, 12]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
          ))}

          {/* ───────── SHIN ───────── */}
          {/* Shin chassis tube */}
          <mesh material={chassis} position={[0, -0.32, 0]}>
            <cylinderGeometry args={[0.058, 0.062, SHIN_LEN, 12]} />
          </mesh>
          {/* Shin greave (front) */}
          <mesh material={shell} position={[0, -0.32, 0.04]}>
            <boxGeometry args={[0.1, SHIN_LEN, 0.07]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Shin back plate */}
          <mesh material={shell} position={[0, -0.32, -0.04]}>
            <boxGeometry args={[0.1, SHIN_LEN, 0.05]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Shin emissive accent — short bar mid-shin */}
          <mesh material={emissive} position={[0, -0.32, 0.076]}>
            <boxGeometry args={[0.045, 0.04, 0.004]} />
          </mesh>

          {/* ───────── ANKLE ───────── */}
          <mesh material={chassis} position={[0, -0.52, 0]}>
            <cylinderGeometry args={[0.055, 0.055, 0.04, 14]} />
          </mesh>
          <mesh material={emissive} position={[0, -0.52, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.058, 0.006, 6, 18]} />
          </mesh>

          {/* ───────── FOOT (toe + heel + sole) ───────── */}
          {/* Toe segment (forward) */}
          <mesh material={shell} position={[0, -0.58, 0.075]}>
            <boxGeometry args={[0.11, 0.05, 0.12]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Heel segment (back) */}
          <mesh material={shell} position={[0, -0.58, -0.045]}>
            <boxGeometry args={[0.105, 0.05, 0.09]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Sole plate — thin chassis underneath */}
          <mesh material={chassis} position={[0, -0.612, 0.02]}>
            <boxGeometry args={[0.12, 0.015, 0.23]} />
          </mesh>
          {/* Toe accent strip */}
          <mesh material={emissive} position={[0, -0.555, 0.137]}>
            <boxGeometry args={[0.06, 0.005, 0.005]} />
          </mesh>
        </group>
      ))}

      {/* ───────── PODIUM (multi-tier with glyph ring) ───────── */}
      {/* Lower base disc — widest, dark chassis ring */}
      <mesh material={chassis} position={[0, -0.755, 0]}>
        <cylinderGeometry args={[0.7, 0.74, 0.04, 36]} />
      </mesh>
      {/* Mid step — shell, slightly narrower */}
      <mesh material={shell} position={[0, -0.72, 0]}>
        <cylinderGeometry args={[0.6, 0.66, 0.05, 36]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Upper platform — shell, narrowest */}
      <mesh material={shell} position={[0, -0.68, 0]}>
        <cylinderGeometry args={[0.46, 0.52, 0.04, 36]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Glyph ring — large emissive torus around the upper platform */}
      <mesh material={emissive} position={[0, -0.685, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.55, 0.014, 8, 64]} />
      </mesh>
      {/* Secondary inner ring */}
      <mesh material={emissive} position={[0, -0.668, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.32, 0.008, 6, 48]} />
      </mesh>
      {/* 6 small floor markers around the perimeter */}
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const angle = (i / 6) * Math.PI * 2;
        return (
          <mesh
            key={i}
            material={warm}
            position={[Math.cos(angle) * 0.62, -0.67, Math.sin(angle) * 0.62]}
          >
            <boxGeometry args={[0.025, 0.012, 0.025]} />
          </mesh>
        );
      })}
      {/* Center activation disc */}
      <mesh material={emissive} position={[0, -0.65, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.06, 0.22, 32]} />
      </mesh>
      {/* Center inner accent */}
      <mesh material={emissive} position={[0, -0.648, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.025, 0.05, 18]} />
      </mesh>
    </group>
  );
}
