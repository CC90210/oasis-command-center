"use client";

import { useMemo } from "react";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 04 — Browser Optics. Visor band + two glowing eye points.
 *
 * Anchored at (0, 1.36, 0.10) — the midline of the Reasoning Core face
 * plate, so the visor wraps cleanly across the eyes rather than floating
 * above the head. The visor is a torus arc oriented around the Y axis
 * with PI*1.1 sweep so it wraps the front + sides of the face plate.
 * Eyes are emissive spheres recessed into the visor band.
 */

const TARGET = new THREE.Vector3(0, 1.36, 0.10);
const SCATTER = new THREE.Vector3(1.5, 1.2, -1.1);

const VISOR_OUTER_R = 0.13;
const VISOR_TUBE_R = 0.022;
const VISOR_ARC = Math.PI * 0.7;       // 126° — sweeps front only, no wrap behind ears
const EYE_X = 0.058;
const EYE_R = 0.028;

export function BrowserOptics({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 3,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* Visor band — torus arc wrapping the FRONT of the face only.
          torusGeometry arc starts at angle 0 in its local XY plane and
          sweeps CCW to VISOR_ARC. Rotation chain:
            1. Z = π/2 - VISOR_ARC/2  → centres the arc on local +Y (up)
            2. X = π/2                → tilts XY plane to XZ; +Y becomes +Z (forward)
          Net: visor centre points at +Z (front of head), arc sweeps
          symmetrically left+right around the face, leaving the back open. */}
      <mesh material={shell} rotation={[Math.PI / 2, 0, Math.PI / 2 - VISOR_ARC / 2]}>
        <torusGeometry args={[VISOR_OUTER_R, VISOR_TUBE_R, 12, 32, VISOR_ARC]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Left eye — emissive sphere at slightly forward offset so it
          sits IN the visor band, not floating in front of it */}
      <mesh material={emissive} position={[-EYE_X, 0, VISOR_OUTER_R * 0.85]}>
        <sphereGeometry args={[EYE_R, 16, 16]} />
      </mesh>
      {/* Right eye */}
      <mesh material={emissive} position={[EYE_X, 0, VISOR_OUTER_R * 0.85]}>
        <sphereGeometry args={[EYE_R, 16, 16]} />
      </mesh>
      {/* Visor accent line — thin emissive across the front */}
      <mesh material={emissive} position={[0, 0.025, VISOR_OUTER_R * 0.95]}>
        <boxGeometry args={[0.12, 0.006, 0.004]} />
      </mesh>
    </group>
  );
}
