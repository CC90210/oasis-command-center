"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { useSubassembly } from "../useSubassembly";
import { useSceneBridge } from "../SceneBridge";
import { createShellMaterial, createEmissiveMaterial, EMISSIVE_COLOR } from "../materials";

/**
 * 02 — State Pulse. The figure's glowing heart core. An icosahedron gem
 * (emissive) suspended inside a containment torus (shell). Anchored at
 * chest-center (0, 0.55, 0.18) — slightly forward so it reads as
 * embedded in the chest plate rather than hidden behind it.
 *
 * Unique behaviour: the gem rotates slowly on the Y axis even after the
 * part has installed — the only piece that spins independently of the
 * rig. Visually communicates "heartbeat."
 */

const TARGET = new THREE.Vector3(0, 0.55, 0.18);
const SCATTER = new THREE.Vector3(1.3, 0.5, 1.5);

export function StatePulse({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const gemRef = useRef<THREE.Mesh | null>(null);
  const bridge = useSceneBridge();

  const { groupRef } = useSubassembly({
    manifestIdx: 1,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  // Independent gem rotation + pulsing scale once installed.
  useFrame((state) => {
    if (!gemRef.current) return;
    const installP = bridge.current.install[1] ?? (forceInstalled ? 1 : 0);
    if (installP < 0.4) return;
    const t = state.clock.elapsedTime;
    gemRef.current.rotation.y = t * 0.6;
    gemRef.current.rotation.x = t * 0.25;
    const pulse = 1 + Math.sin(t * 2.2) * 0.06 * installP;
    gemRef.current.scale.setScalar(pulse);
  });

  return (
    <group ref={groupRef}>
      {/* Containment torus (shell-coloured ring) */}
      <mesh material={shell} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.16, 0.02, 12, 32]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.005} renderOrder={1} />
      </mesh>
      {/* Glowing gem at the centre — bigger detail level so the bloom
          catches all 20 faces */}
      <mesh ref={gemRef} material={emissive}>
        <icosahedronGeometry args={[0.13, 1]} />
      </mesh>
      {/* Inner halo plate for extra glow */}
      <mesh material={emissive} position={[0, 0, -0.01]}>
        <ringGeometry args={[0.04, 0.13, 24]} />
      </mesh>
    </group>
  );
}
