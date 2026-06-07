"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useSceneBridge } from "./SceneBridge";
import {
  buildAdditiveMaterial,
  PRIMARY_GREEN,
  ACCENT_CYAN,
  WARM_AMBER,
} from "./materials";

/**
 * OasisCore — central icosahedral reactor at the heart of the agent.
 *
 * Anatomy (all centered at origin):
 *   - Outer wireframe icosahedron (radius 0.42) — counter-rotates slowly
 *   - Inner solid sphere (radius 0.22) — pulses with breathing rhythm
 *     and brightens with compaction
 *   - Inner second icosahedron (radius 0.30) — rotates on a different axis
 *   - 3 concentric thin rings (one per pair of axes) — slow drift
 *
 * The core is the FIRST thing the viewer sees on scroll 0 (visible
 * regardless of install progress) and stays at centre throughout the
 * 11 phases. Other geometry orbits around it.
 */

type Props = { forceInstalled?: boolean };

export function OasisCore({ forceInstalled = false }: Props) {
  const outerWireRef = useRef<THREE.Mesh | null>(null);
  const innerWireRef = useRef<THREE.Mesh | null>(null);
  const innerSphereRef = useRef<THREE.Mesh | null>(null);
  const ringARef = useRef<THREE.Mesh | null>(null);
  const ringBRef = useRef<THREE.Mesh | null>(null);
  const ringCRef = useRef<THREE.Mesh | null>(null);
  const bridge = useSceneBridge();

  const outerWireMat = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0.65, wireframe: true }),
    [],
  );
  const innerWireMat = useMemo(
    () => buildAdditiveMaterial({ color: ACCENT_CYAN, opacity: 0.55, wireframe: true }),
    [],
  );
  const coreSphereMat = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0.85 }),
    [],
  );
  const ringAMat = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0.55, doubleSide: true }),
    [],
  );
  const ringBMat = useMemo(
    () => buildAdditiveMaterial({ color: ACCENT_CYAN, opacity: 0.45, doubleSide: true }),
    [],
  );
  const ringCMat = useMemo(
    () => buildAdditiveMaterial({ color: WARM_AMBER, opacity: 0.32, doubleSide: true }),
    [],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const compP = forceInstalled
      ? 1
      : THREE.MathUtils.clamp(bridge.current.compaction, 0, 1);

    if (outerWireRef.current) {
      outerWireRef.current.rotation.y = t * 0.18;
      outerWireRef.current.rotation.x = Math.sin(t * 0.12) * 0.25;
    }
    if (innerWireRef.current) {
      innerWireRef.current.rotation.y = -t * 0.28;
      innerWireRef.current.rotation.z = Math.cos(t * 0.17) * 0.2;
    }
    if (innerSphereRef.current) {
      const pulse = 1 + Math.sin(t * 1.4) * 0.06 + compP * 0.18;
      innerSphereRef.current.scale.setScalar(pulse);
    }
    coreSphereMat.opacity = 0.7 + Math.sin(t * 1.4) * 0.12 + compP * 0.18;

    if (ringARef.current) {
      ringARef.current.rotation.x = Math.PI / 2 + Math.sin(t * 0.2) * 0.18;
      ringARef.current.rotation.z = t * 0.3;
    }
    if (ringBRef.current) {
      ringBRef.current.rotation.x = -t * 0.22;
      ringBRef.current.rotation.y = Math.cos(t * 0.18) * 0.3;
    }
    if (ringCRef.current) {
      ringCRef.current.rotation.y = t * 0.16;
      ringCRef.current.rotation.z = Math.sin(t * 0.24) * 0.4;
    }
  });

  return (
    <group>
      {/* Outer wireframe icosahedron — the dominant cage */}
      <mesh ref={outerWireRef} material={outerWireMat}>
        <icosahedronGeometry args={[0.42, 1]} />
      </mesh>

      {/* Inner second wireframe — smaller, counter-rotating */}
      <mesh ref={innerWireRef} material={innerWireMat}>
        <icosahedronGeometry args={[0.3, 0]} />
      </mesh>

      {/* Solid inner core sphere — the reactor heart */}
      <mesh ref={innerSphereRef} material={coreSphereMat}>
        <sphereGeometry args={[0.16, 24, 18]} />
      </mesh>

      {/* Bright nucleus point at the exact center */}
      <mesh material={coreSphereMat}>
        <sphereGeometry args={[0.05, 16, 12]} />
      </mesh>

      {/* 3 concentric atmospheric rings around the core */}
      <mesh ref={ringARef} material={ringAMat}>
        <torusGeometry args={[0.55, 0.008, 8, 64]} />
      </mesh>
      <mesh ref={ringBRef} material={ringBMat}>
        <torusGeometry args={[0.7, 0.006, 8, 80]} />
      </mesh>
      <mesh ref={ringCRef} material={ringCMat}>
        <torusGeometry args={[0.88, 0.005, 8, 96]} />
      </mesh>
    </group>
  );
}
