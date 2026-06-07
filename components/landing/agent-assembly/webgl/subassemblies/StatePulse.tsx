"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { useSceneBridge } from "../SceneBridge";
import {
  createShellMaterial,
  createChassisMaterial,
  createEmissiveMaterial,
  EMISSIVE_COLOR,
} from "../materials";

/**
 * 02 — State Pulse (V2). The visible heart core of the agent. Now a
 * proper gyroscope/reactor assembly:
 *
 *   - Outer containment torus    (shell — the reactor housing ring)
 *   - 2 perpendicular gimbal rings (chassis — spin slowly on different axes)
 *   - Central gem icosahedron    (emissive — pulses + counter-rotates)
 *   - 4 cooling fins             (chassis spikes around the housing)
 *   - Inner halo plate           (emissive disc behind the gem)
 *   - Energy flares              (small emissive cubes orbiting the housing)
 *
 * The two gimbal rings + the gem all rotate independently once installed —
 * reads as a live reactor, not a static prop.
 */

const TARGET = new THREE.Vector3(0, 0.55, 0.18);
const SCATTER = new THREE.Vector3(1.3, 0.5, 1.5);

export function StatePulse({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const gemRef = useRef<THREE.Mesh | null>(null);
  const gimbalARef = useRef<THREE.Mesh | null>(null);
  const gimbalBRef = useRef<THREE.Mesh | null>(null);
  const bridge = useSceneBridge();

  const { groupRef } = useSubassembly({
    manifestIdx: 1,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  useFrame((state) => {
    const installP = bridge.current.install[1] ?? (forceInstalled ? 1 : 0);
    if (installP < 0.35) return;
    const t = state.clock.elapsedTime;
    if (gemRef.current) {
      gemRef.current.rotation.y = t * 0.55;
      gemRef.current.rotation.x = t * 0.25;
      const pulse = 1 + Math.sin(t * 2.1) * 0.08 * installP;
      gemRef.current.scale.setScalar(pulse);
    }
    if (gimbalARef.current) {
      gimbalARef.current.rotation.z = t * 0.35;
    }
    if (gimbalBRef.current) {
      gimbalBRef.current.rotation.x = -t * 0.45;
    }
  });

  return (
    <group ref={groupRef}>
      {/* ───────── REACTOR HOUSING ───────── */}
      {/* Outer containment torus — main reactor ring */}
      <mesh material={shell} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.17, 0.025, 14, 36]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Cooling fins — 4 chassis spikes radiating from the housing */}
      {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((angle, i) => (
        <group key={i} rotation={[0, 0, angle]}>
          <mesh material={chassis} position={[0.2, 0, 0]}>
            <boxGeometry args={[0.04, 0.02, 0.04]} />
          </mesh>
          <mesh material={chassis} position={[0.225, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
            <coneGeometry args={[0.014, 0.04, 6]} />
          </mesh>
        </group>
      ))}

      {/* ───────── GIMBAL RINGS (rotating chassis bands) ───────── */}
      <mesh ref={gimbalARef} material={chassis} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.135, 0.008, 6, 28]} />
      </mesh>
      <mesh ref={gimbalBRef} material={chassis}>
        <torusGeometry args={[0.135, 0.008, 6, 28]} />
      </mesh>

      {/* ───────── CENTRAL GEM ───────── */}
      <mesh ref={gemRef} material={emissive}>
        <icosahedronGeometry args={[0.105, 1]} />
      </mesh>

      {/* ───────── HALO + AURA ───────── */}
      {/* Inner halo plate — emissive disc behind the gem */}
      <mesh material={emissive} position={[0, 0, -0.012]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.04, 0.155, 28]} />
      </mesh>
      {/* Forward halo plate — second disc in front */}
      <mesh material={emissive} position={[0, 0, 0.012]} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.115, 0.155, 28]} />
      </mesh>

      {/* ───────── ENERGY FLARES (small orbiting cubes) ───────── */}
      {[0, Math.PI / 3, (2 * Math.PI) / 3, Math.PI, (4 * Math.PI) / 3, (5 * Math.PI) / 3].map((angle, i) => (
        <mesh
          key={i}
          material={emissive}
          position={[Math.cos(angle) * 0.18, Math.sin(angle) * 0.18, 0]}
        >
          <boxGeometry args={[0.012, 0.012, 0.012]} />
        </mesh>
      ))}
    </group>
  );
}
