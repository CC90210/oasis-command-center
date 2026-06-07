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
 * 06 — Guard Shield (V2). Both shoulder pauldrons (with layered armor
 * plating + ball-joint sockets) + chest armor plates wrapping the State
 * Pulse heart core.
 *
 * Anchored at shoulder line (0, 0.85, 0). Each pauldron is now a
 * stack of three armor plates with a chassis ball-joint underneath +
 * a glowing seam between plates, so the shoulder reads as MECHANICAL
 * ARMOR rather than a half-sphere blob.
 *
 * BUG FIX V2 (2026-06-07): The right pauldron was previously rendered
 * with rotation=[0, Math.PI, 0] applied to a partial-sphere geometry,
 * which flipped the geometry's normals to face BACKWARD — so the right
 * shoulder was invisible from the front camera. Replaced with full
 * symmetric layered geometry per side; both pauldrons now render.
 */

const TARGET = new THREE.Vector3(0, 0.85, 0);
const SCATTER = new THREE.Vector3(1.4, 1.0, 1.2);

const SHOULDER_X = 0.32;

export function GuardShield({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 5,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* ───────── PAULDRONS (both shoulders, layered armor) ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * SHOULDER_X, 0, 0]}>
          {/* Ball-joint socket — chassis sphere under the armor */}
          <mesh material={chassis}>
            <sphereGeometry args={[0.095, 16, 12]} />
          </mesh>
          {/* Joint seam ring */}
          <mesh material={emissive} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.095, 0.006, 6, 24]} />
          </mesh>
          {/* TOP armor plate — small dome on top of the shoulder */}
          <mesh material={shell} position={[0, 0.085, 0]} scale={[1.0, 0.7, 1.0]}>
            <sphereGeometry args={[0.13, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.004} renderOrder={1} />
          </mesh>
          {/* MID armor band — cylindrical cuff outside the joint, INWARD-facing */}
          <mesh material={shell} position={[sign * 0.02, 0.01, 0]} rotation={[0, 0, sign * 0.2]}>
            <cylinderGeometry args={[0.115, 0.13, 0.09, 18]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.004} renderOrder={1} />
          </mesh>
          {/* OUTER armor flare — angled outward */}
          <mesh material={shell} position={[sign * 0.05, -0.05, 0]} rotation={[0, 0, sign * 0.45]}>
            <cylinderGeometry args={[0.075, 0.115, 0.1, 14]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.004} renderOrder={1} />
          </mesh>
          {/* Pauldron emissive seam between plates */}
          <mesh material={emissive} position={[sign * 0.03, 0.04, 0]} rotation={[0, 0, sign * 0.2]}>
            <torusGeometry args={[0.125, 0.005, 6, 18, Math.PI * 1.2]} />
          </mesh>
          {/* Small status indicator on outer face */}
          <mesh material={emissive} position={[sign * 0.13, 0.02, 0]}>
            <boxGeometry args={[0.012, 0.018, 0.018]} />
          </mesh>
        </group>
      ))}

      {/* ───────── CHEST PLATES (front + back armor wrapping the heart) ───────── */}
      {/* Front chest plate — tilted slightly outward to follow chest curve */}
      <mesh material={shell} position={[0, -0.2, 0.14]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[0.34, 0.36, 0.05]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Front chest panel divider — vertical chassis seam */}
      <mesh material={chassis} position={[0, -0.2, 0.166]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[0.012, 0.32, 0.005]} />
      </mesh>
      {/* Cutout for State Pulse heart — emissive ring framing it */}
      <mesh material={emissive} position={[0, -0.31, 0.168]} rotation={[0.12, 0, 0]}>
        <torusGeometry args={[0.045, 0.005, 6, 18]} />
      </mesh>
      {/* Back chest plate */}
      <mesh material={shell} position={[0, -0.2, -0.14]} rotation={[-0.12, 0, 0]}>
        <boxGeometry args={[0.34, 0.36, 0.05]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Spine port cluster — 3 emissive dots on the back plate */}
      {[-0.06, 0, 0.06].map((y, i) => (
        <mesh key={i} material={emissive} position={[0, -0.15 + y * 0.5, -0.166]} rotation={[-0.12, 0, 0]}>
          <boxGeometry args={[0.018, 0.012, 0.005]} />
        </mesh>
      ))}
      {/* Pauldron-to-clavicle connecting collar bar */}
      <mesh material={chassis} position={[0, -0.04, 0.05]}>
        <boxGeometry args={[0.58, 0.025, 0.06]} />
      </mesh>
    </group>
  );
}
