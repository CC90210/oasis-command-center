"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useSceneBridge } from "./SceneBridge";
import { buildParticleData } from "./particleGeometry";
import { PARTICLE_VERTEX, PARTICLE_FRAGMENT } from "./particleShader";

/**
 * ParticleAvatar — V4 replacement for the V1-V3 primitive-stack humanoid.
 *
 * Renders the agent as ~12k GPU-driven particles forming a humanoid
 * silhouette via custom ShaderMaterial. Each particle:
 *   - lives in one of 10 anatomical regions (head, chest, spine, ...)
 *     mapped 1:1 to the install scroll phases
 *   - drifts in 3D space pre-install, then lerps to its anatomical home
 *     when its phase fires
 *   - breathes (micro-orbits) post-install
 *   - colours itself from a phase-indexed palette so the figure has a
 *     vertical warm-white → cyan-green → amber gradient
 *
 * No solid meshes, no plastic shell — just energy + data. The intent is
 * to read as "holographic intelligence" rather than "assembled toy."
 *
 * Performance: single Points draw call (no per-particle React state).
 * SceneBridge phase MotionValues feed into shader uniforms once per
 * frame via the bridge ref + useFrame.
 */

type Props = { forceInstalled?: boolean };

const PARTICLE_DATA = buildParticleData();

export function ParticleAvatar({ forceInstalled = false }: Props) {
  const pointsRef = useRef<THREE.Points | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  const bridge = useSceneBridge();
  const { size, viewport } = useThree();

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(PARTICLE_DATA.rest, 3));
    g.setAttribute("aScatter", new THREE.BufferAttribute(PARTICLE_DATA.scatter, 3));
    g.setAttribute("aPhaseSeed", new THREE.BufferAttribute(PARTICLE_DATA.phaseSeed, 3));
    // Bounding sphere is needed for frustum culling — compute a generous one.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 4);
    return g;
  }, []);

  const material = useMemo(() => {
    const m = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      uniforms: {
        uInstall0: { value: new THREE.Vector4(0, 0, 0, 0) },
        uInstall1: { value: new THREE.Vector4(0, 0, 0, 0) },
        uInstall2: { value: new THREE.Vector4(0, 0, 0, 0) },
        uCompaction: { value: 0 },
        uTime: { value: 0 },
        uPixelScale: { value: 1 },
      },
      transparent: true,
      depthWrite: false,            // additive-like compositing without z-fighting
      blending: THREE.AdditiveBlending,
      vertexColors: false,
    });
    return m;
  }, []);

  // Keep pixel scale uniform synced to actual canvas size so points stay
  // proportionally sized whether the user is on a phone or a 4K display.
  useEffect(() => {
    if (!material) return;
    // Tunes point density to viewport — at standard 1080-ish, scale ~= 1.
    material.uniforms.uPixelScale.value = Math.min(1.6, Math.max(0.55, size.height / 900));
  }, [size.height, viewport.height, material]);

  // On mount with forceInstalled, snap all install scalars to 1 so the
  // figure paints fully assembled on the first frame.
  useEffect(() => {
    if (!material) return;
    if (forceInstalled) {
      material.uniforms.uInstall0.value.set(1, 1, 1, 1);
      material.uniforms.uInstall1.value.set(1, 1, 1, 1);
      material.uniforms.uInstall2.value.set(1, 1, 0, 0);
      material.uniforms.uCompaction.value = 1;
    }
  }, [forceInstalled, material]);

  useFrame((state, dt) => {
    if (!materialRef.current) return;
    if (forceInstalled) return;

    const install = bridge.current.install;
    const compP = bridge.current.compaction;

    // Pack the 10 install scalars into the 3 vec4 uniforms.
    materialRef.current.uniforms.uInstall0.value.set(install[0], install[1], install[2], install[3]);
    materialRef.current.uniforms.uInstall1.value.set(install[4], install[5], install[6], install[7]);
    materialRef.current.uniforms.uInstall2.value.set(install[8], install[9], 0, 0);
    materialRef.current.uniforms.uCompaction.value = THREE.MathUtils.clamp(compP, 0, 1);

    // uTime accumulator (dt-safe so animations stay smooth across pauses).
    materialRef.current.uniforms.uTime.value += dt;

    // Idle rotation once fully assembled — the whole points object rotates,
    // not just the camera, so the breathing + drift uniforms still work.
    if (pointsRef.current && compP >= 0.98) {
      pointsRef.current.rotation.y += dt * (Math.PI * 2 / 90);  // 1 rev per 90s
    } else if (pointsRef.current) {
      pointsRef.current.rotation.y = THREE.MathUtils.damp(
        pointsRef.current.rotation.y, 0, 4, dt,
      );
    }

    // Sync ref on first frame.
    if (materialRef.current !== material) {
      materialRef.current = material;
    }
  });

  // Bind the material ref on every render since useMemo identity is stable.
  materialRef.current = material;

  return (
    <points ref={pointsRef} geometry={geometry} material={material} frustumCulled={false} />
  );
}
