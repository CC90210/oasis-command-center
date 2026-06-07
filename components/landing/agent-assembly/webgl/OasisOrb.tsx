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
 * OasisOrb — the agent, rendered as a single unified glowing orb that
 * gains a new CAPABILITY LAYER for each install scroll phase.
 *
 * V5's "central core + 10 orbiting modules" read as disconnected pieces.
 * V6 fixes that by collapsing every capability into a layer of ONE
 * coherent form: a nucleus surrounded by 10 concentric (or near-
 * concentric) layers that nest cleanly and animate in harmony.
 *
 * Mapping of install phase → layer:
 *
 *   0 Reasoning Core   → inner nucleus glow (always visible at base)
 *   1 State Pulse      → solid pulsing heart sphere (breath rhythm)
 *   2 Memory Spine     → vertical neural axis through the centre
 *   3 Browser Optics   → inner geodesic wireframe (icosahedron L1)
 *   4 Bridge Tools     → equatorial activation ring (XZ plane)
 *   5 Guard Shield     → outer protective sphere shell (translucent)
 *   6 Output Channels  → polar ring (XY plane, perpendicular to equator)
 *   7 Security Mesh    → mid-radius octahedral lattice cage
 *   8 Business Layer   → halo of 12 satellite dots in an orbital plane
 *   9 Command Centre   → outer cosmic corona (4 thin perpendicular rings)
 *
 * Every layer:
 *   - Is centred on the origin (no chaotic orbital scatter)
 *   - Starts at opacity 0; ramps to its lit opacity as its phase fires
 *   - Rotates at its own slow rate, creating layered parallax depth
 *   - Brightens synchronously during the compaction beat (final lock)
 *
 * The result reads as ONE intelligence growing more powerful with scroll,
 * not 10 separate objects assembling.
 */

type Props = { forceInstalled?: boolean };

/** Opacities the layer settles to once its phase is fully installed. */
const LIT_OPACITY = {
  nucleus: 0.95,        // 0 — always lit at base
  heart: 0.62,          // 1
  spine: 0.55,          // 2
  innerGeodesic: 0.55,  // 3
  equator: 0.85,        // 4
  shell: 0.18,          // 5
  polar: 0.7,           // 6
  lattice: 0.42,        // 7
  haloDots: 0.7,        // 8
  corona: 0.55,         // 9
};

/** smoothstep helper — same curve as the GLSL primitive. */
function smooth(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function OasisOrb({ forceInstalled = false }: Props) {
  const bridge = useSceneBridge();

  // Refs for the layers that need per-frame transform updates
  const heartRef = useRef<THREE.Mesh | null>(null);
  const innerGeoRef = useRef<THREE.Mesh | null>(null);
  const equatorRef = useRef<THREE.Mesh | null>(null);
  const shellRef = useRef<THREE.Mesh | null>(null);
  const polarRef = useRef<THREE.Mesh | null>(null);
  const latticeRef = useRef<THREE.Mesh | null>(null);
  const haloGroupRef = useRef<THREE.Group | null>(null);
  const coronaGroupRef = useRef<THREE.Group | null>(null);
  const spineRef = useRef<THREE.Mesh | null>(null);

  // Materials — each layer has its own so opacity ramps are independent.
  const mNucleus = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: LIT_OPACITY.nucleus }),
    [],
  );
  const mNucleusCore = useMemo(
    () => buildAdditiveMaterial({ color: "#ffffff", opacity: 1.0 }),
    [],
  );
  const mHeart = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0 }),
    [],
  );
  const mSpine = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0 }),
    [],
  );
  const mInnerGeo = useMemo(
    () => buildAdditiveMaterial({ color: ACCENT_CYAN, opacity: 0, wireframe: true }),
    [],
  );
  const mEquator = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0, doubleSide: true }),
    [],
  );
  const mShell = useMemo(
    () => buildAdditiveMaterial({ color: ACCENT_CYAN, opacity: 0, wireframe: true }),
    [],
  );
  const mPolar = useMemo(
    () => buildAdditiveMaterial({ color: WARM_AMBER, opacity: 0, doubleSide: true }),
    [],
  );
  const mLattice = useMemo(
    () => buildAdditiveMaterial({ color: ACCENT_CYAN, opacity: 0, wireframe: true }),
    [],
  );
  const mHaloDot = useMemo(
    () => buildAdditiveMaterial({ color: WARM_AMBER, opacity: 0 }),
    [],
  );
  const mCorona = useMemo(
    () => buildAdditiveMaterial({ color: PRIMARY_GREEN, opacity: 0, doubleSide: true }),
    [],
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const install = bridge.current.install;
    const compP = forceInstalled
      ? 1
      : THREE.MathUtils.clamp(bridge.current.compaction, 0, 1);

    // Per-phase install progress with reduced-motion shortcut
    const ip = (i: number) =>
      forceInstalled ? 1 : THREE.MathUtils.clamp(install[i] ?? 0, 0, 1);

    // Compaction adds a brightness boost across every layer.
    const compBoost = 1 + compP * 0.35;

    /** Helper — opacity must stay in [0,1] for three.js renderers.
     *  Stacking lit*compBoost*pulse can exceed 1; clamp explicitly so
     *  intent is visible and renderers behave consistently. */
    const op = (v: number) => THREE.MathUtils.clamp(v, 0, 1);

    // === Layer opacity ramps ===
    // Phase 0 — nucleus is ALWAYS lit at a base value (the agent has to
    // exist before its first install), then brightens as ip(0) progresses.
    const nucleusPulse = 1 + Math.sin(t * 1.8) * 0.06;
    mNucleus.opacity = op((0.55 + smooth(ip(0)) * (LIT_OPACITY.nucleus - 0.55)) * compBoost * nucleusPulse);
    mNucleusCore.opacity = op((0.7 + smooth(ip(0)) * 0.3) * compBoost);

    mHeart.opacity = op(smooth(ip(1)) * LIT_OPACITY.heart * compBoost);
    mSpine.opacity = op(smooth(ip(2)) * LIT_OPACITY.spine * compBoost);
    mInnerGeo.opacity = op(smooth(ip(3)) * LIT_OPACITY.innerGeodesic * compBoost);
    mEquator.opacity = op(smooth(ip(4)) * LIT_OPACITY.equator * compBoost);
    mShell.opacity = op(smooth(ip(5)) * LIT_OPACITY.shell * compBoost);
    mPolar.opacity = op(smooth(ip(6)) * LIT_OPACITY.polar * compBoost);
    mLattice.opacity = op(smooth(ip(7)) * LIT_OPACITY.lattice * compBoost);
    mHaloDot.opacity = op(smooth(ip(8)) * LIT_OPACITY.haloDots * compBoost);
    mCorona.opacity = op(smooth(ip(9)) * LIT_OPACITY.corona * compBoost);

    // === Per-frame transforms ===
    // Heart breathing (only when installed)
    if (heartRef.current) {
      const breath = 1 + Math.sin(t * 1.5) * 0.08 * ip(1);
      heartRef.current.scale.setScalar(breath);
    }
    // Spine subtle pulse
    if (spineRef.current) {
      spineRef.current.scale.y = 1 + Math.sin(t * 0.9) * 0.04 * ip(2);
    }
    // Inner geodesic — slow rotation on Y + tilt on X
    if (innerGeoRef.current) {
      innerGeoRef.current.rotation.y = t * 0.22;
      innerGeoRef.current.rotation.x = Math.sin(t * 0.13) * 0.18;
    }
    // Equatorial ring — fast rotation on Y axis (it stays horizontal)
    if (equatorRef.current) {
      equatorRef.current.rotation.z = t * 0.55;
    }
    // Outer shell — slow rotation opposite to inner geodesic
    if (shellRef.current) {
      shellRef.current.rotation.y = -t * 0.14;
      shellRef.current.rotation.z = Math.cos(t * 0.11) * 0.15;
    }
    // Polar ring — rotation around X (vertical disc spinning)
    if (polarRef.current) {
      polarRef.current.rotation.y = t * 0.4;
    }
    // Mid-radius lattice — diagonal rotation
    if (latticeRef.current) {
      latticeRef.current.rotation.x = t * 0.18;
      latticeRef.current.rotation.y = t * 0.13;
    }
    // Halo dot group — spins as a unit in its plane
    if (haloGroupRef.current) {
      haloGroupRef.current.rotation.y = t * 0.3;
      haloGroupRef.current.rotation.z = Math.sin(t * 0.17) * 0.12;
    }
    // Corona — slow tumble
    if (coronaGroupRef.current) {
      coronaGroupRef.current.rotation.y = t * 0.08;
      coronaGroupRef.current.rotation.z = Math.cos(t * 0.05) * 0.2;
    }
  });

  // Halo dot positions — 12 dots evenly spaced on a circle in the
  // XZ plane at radius 1.05 (just outside the shell).
  const haloDots = useMemo(() => {
    const positions: [number, number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const theta = (i / 12) * Math.PI * 2;
      positions.push([Math.cos(theta) * 1.05, 0, Math.sin(theta) * 1.05]);
    }
    return positions;
  }, []);

  return (
    <group>
      {/* ───────── PHASE 0: NUCLEUS (always visible base) ───────── */}
      {/* Outer nucleus glow */}
      <mesh material={mNucleus}>
        <sphereGeometry args={[0.18, 32, 24]} />
      </mesh>
      {/* Bright white centre dot */}
      <mesh material={mNucleusCore}>
        <sphereGeometry args={[0.045, 16, 12]} />
      </mesh>

      {/* ───────── PHASE 1: HEART (breathing solid sphere) ───────── */}
      <mesh ref={heartRef} material={mHeart}>
        <sphereGeometry args={[0.32, 32, 24]} />
      </mesh>

      {/* ───────── PHASE 2: NEURAL SPINE (vertical pulse axis) ───────── */}
      <mesh ref={spineRef} material={mSpine}>
        <cylinderGeometry args={[0.012, 0.012, 1.6, 8, 1, true]} />
      </mesh>

      {/* ───────── PHASE 3: INNER GEODESIC (subdivided wireframe) ───────── */}
      <mesh ref={innerGeoRef} material={mInnerGeo}>
        <icosahedronGeometry args={[0.5, 1]} />
      </mesh>

      {/* ───────── PHASE 4: EQUATORIAL ACTIVATION RING ─────────
          Sits in XZ plane (horizontal). Wider than the inner geodesic. */}
      <mesh ref={equatorRef} material={mEquator} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.78, 0.014, 12, 96]} />
      </mesh>

      {/* ───────── PHASE 5: PROTECTIVE OUTER SHELL ─────────
          Translucent wireframe sphere wrapping everything */}
      <mesh ref={shellRef} material={mShell}>
        <icosahedronGeometry args={[0.95, 2]} />
      </mesh>

      {/* ───────── PHASE 6: POLAR RING ─────────
          Vertical disc — sits in YZ plane, perpendicular to equator */}
      <mesh ref={polarRef} material={mPolar} rotation={[0, 0, Math.PI / 2]}>
        <torusGeometry args={[0.82, 0.01, 10, 80]} />
      </mesh>

      {/* ───────── PHASE 7: SECURITY LATTICE ─────────
          Mid-radius octahedral wireframe cage — diagonal rotation */}
      <mesh ref={latticeRef} material={mLattice}>
        <octahedronGeometry args={[0.72, 0]} />
      </mesh>

      {/* ───────── PHASE 8: HALO DOTS ─────────
          12 small spheres in an equatorial ring outside the shell */}
      <group ref={haloGroupRef}>
        {haloDots.map((pos, i) => (
          <mesh key={i} material={mHaloDot} position={pos}>
            <sphereGeometry args={[0.022, 8, 8]} />
          </mesh>
        ))}
      </group>

      {/* ───────── PHASE 9: COSMIC CORONA ─────────
          4 thin perpendicular rings forming an outer star pattern */}
      <group ref={coronaGroupRef}>
        <mesh material={mCorona}>
          <torusGeometry args={[1.18, 0.006, 8, 96]} />
        </mesh>
        <mesh material={mCorona} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.18, 0.006, 8, 96]} />
        </mesh>
        <mesh material={mCorona} rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[1.18, 0.006, 8, 96]} />
        </mesh>
        <mesh material={mCorona} rotation={[Math.PI / 4, Math.PI / 4, 0]}>
          <torusGeometry args={[1.18, 0.006, 8, 96]} />
        </mesh>
      </group>
    </group>
  );
}
