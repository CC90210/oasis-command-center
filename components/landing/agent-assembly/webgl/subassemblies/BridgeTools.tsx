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
 * 05 — Bridge Tools (V2). Forearms + mechanical hands with finger
 * segments. Symmetric across the Y axis.
 *
 * Per side:
 *   - Inner chassis tube  (the actuator rod inside the armor)
 *   - 2 forearm armor segments (upper cuff + lower cuff with seam between)
 *   - Wrist coupler ring  (chassis + emissive)
 *   - Palm armor block    (the back of the hand)
 *   - 4 finger segments   (small boxes — index/middle/ring/pinky)
 *   - 1 thumb segment     (offset to the inner edge of the palm)
 *   - Forearm vent strip  (emissive line down the outer face)
 *
 * Target raised to y=0.18 so forearm tops connect to BusinessLayer
 * elbow sockets (which are at world y=0.34).
 */

const TARGET = new THREE.Vector3(0, 0.18, 0);
const SCATTER = new THREE.Vector3(-1.5, -0.1, 1.4);

const FOREARM_X = 0.38;

export function BridgeTools({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 4,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * FOREARM_X, 0, 0]}>
          {/* Inner chassis actuator — visible at the joint gap */}
          <mesh material={chassis}>
            <cylinderGeometry args={[0.052, 0.052, 0.46, 10]} />
          </mesh>
          {/* Upper forearm armor cuff */}
          <mesh material={shell} position={[0, 0.11, 0]}>
            <cylinderGeometry args={[0.072, 0.074, 0.2, 14]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Lower forearm armor cuff */}
          <mesh material={shell} position={[0, -0.11, 0]}>
            <cylinderGeometry args={[0.07, 0.064, 0.18, 14]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Forearm seam between cuffs */}
          <mesh material={emissive} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.074, 0.005, 6, 18]} />
          </mesh>
          {/* Forearm outer vent line */}
          <mesh material={emissive} position={[sign * 0.072, 0, 0]}>
            <boxGeometry args={[0.004, 0.36, 0.014]} />
          </mesh>
          {/* Forearm chassis stripe — front diagonal accent */}
          <mesh material={chassis} position={[0, 0.05, 0.072]} rotation={[0, 0, sign * 0.5]}>
            <boxGeometry args={[0.014, 0.08, 0.003]} />
          </mesh>
          {/* Forearm seam ring divider on the front */}
          <mesh material={chassis} position={[0, 0.02, 0.072]}>
            <boxGeometry args={[0.08, 0.005, 0.003]} />
          </mesh>
          {/* Wrist coupler ring */}
          <mesh material={chassis} position={[0, -0.24, 0]}>
            <cylinderGeometry args={[0.058, 0.058, 0.04, 14]} />
          </mesh>
          <mesh material={emissive} position={[0, -0.24, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.06, 0.006, 6, 18]} />
          </mesh>

          {/* ───────── HAND ───────── */}
          {/* Palm armor block — the back of the hand */}
          <mesh material={shell} position={[0, -0.31, 0.005]}>
            <boxGeometry args={[0.105, 0.1, 0.07]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
          </mesh>
          {/* Palm chassis underside */}
          <mesh material={chassis} position={[0, -0.31, -0.038]}>
            <boxGeometry args={[0.1, 0.095, 0.012]} />
          </mesh>
          {/* Knuckle accent strip on the back of the hand */}
          <mesh material={emissive} position={[0, -0.275, 0.036]}>
            <boxGeometry args={[0.075, 0.005, 0.005]} />
          </mesh>
          {/* 4 finger segments (rounded boxes hanging from the palm) */}
          {[-0.038, -0.013, 0.012, 0.037].map((x, i) => (
            <group key={i} position={[x, -0.385, 0.012]}>
              {/* Finger upper */}
              <mesh material={shell}>
                <boxGeometry args={[0.018, 0.05, 0.022]} />
                <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
              </mesh>
              {/* Finger knuckle ring */}
              <mesh material={chassis} position={[0, 0.025, 0]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[0.013, 0.013, 0.02, 6]} />
              </mesh>
              {/* Finger tip */}
              <mesh material={shell} position={[0, -0.04, 0]}>
                <boxGeometry args={[0.016, 0.04, 0.02]} />
                <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
              </mesh>
            </group>
          ))}
          {/* Thumb — offset to the inner side of the palm */}
          <group position={[sign * -0.062, -0.34, 0.012]} rotation={[0, 0, sign * 0.4]}>
            <mesh material={shell}>
              <boxGeometry args={[0.022, 0.06, 0.024]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
            <mesh material={shell} position={[0, -0.045, 0]}>
              <boxGeometry args={[0.02, 0.04, 0.022]} />
              <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  );
}
