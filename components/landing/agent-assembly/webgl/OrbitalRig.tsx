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
  SHELL_WHITE,
} from "./materials";

/**
 * OrbitalRig — 11 distinct geometric modules orbiting the OasisCore.
 *
 * Each scroll phase (0-9) brings ONE module flying in from a scattered
 * position to its assigned orbital dock. The 10 modules use different
 * primitives — icosahedron, tetrahedron, helix, octahedron, etc. — so
 * each subsystem reads as a distinct VISUAL signature rather than as
 * "another box on the figure."
 *
 * After all 10 modules dock, the compaction beat (phase 11) triggers a
 * brief synchronization moment where every module pulses brighter and
 * tightens its orbit toward the core.
 *
 * Each module has:
 *   - dockOrbit:    radius + angle + altitude where it lives post-install
 *   - dockTilt:     rotation axis for its own internal spin
 *   - dockSpinRate: how fast it spins independently of its orbit
 *   - orbitRate:    how fast it orbits around the core (radians/sec)
 *   - colour:       per-module palette pick (green/teal/amber)
 *   - geometryFn:   what primitive it renders
 *
 * Pre-install, each module sits at its scatter position (random direction
 * on a 3-unit sphere) and drifts with sine bob. As its install progress
 * ramps 0→1, it eases from scatter to docked orbit position. Post-install,
 * its position is computed from `orbitAngle + t * orbitRate` so it traces
 * a real orbital path around the core.
 */

type Props = { forceInstalled?: boolean };

// Module palette aliases — alias to the shared constants so the
// MODULES table reads with short names while the source of truth
// stays in materials.ts.
const PRIMARY = PRIMARY_GREEN;
const ACCENT = ACCENT_CYAN;
const WARM = WARM_AMBER;
const WHITE = SHELL_WHITE;

type ModuleConfig = {
  /** Which install phase fires this module's docking animation (0-9) */
  phase: number;
  /** Distance from core along the equatorial plane */
  orbitRadius: number;
  /** Starting angle (rad) around the Y axis when docked */
  orbitAngle: number;
  /** Vertical altitude (Y offset from core centre) */
  orbitAltitude: number;
  /** Angular velocity around the orbit (rad/sec) */
  orbitRate: number;
  /** Module's internal axis-aligned spin rate (rad/sec) */
  spinRate: number;
  /** Tilt axis multiplier for the spin (x,y,z components 0-1) */
  spinAxis: [number, number, number];
  /** Module palette colour */
  color: string;
  /** Module label — for documentation/debug */
  label: string;
  /** Geometry size scalar (visual prominence) */
  size: number;
  /** Which primitive to render */
  kind:
    | "icosahedron"
    | "tetrahedron"
    | "octahedron"
    | "dodecahedron"
    | "torusKnot"
    | "torus"
    | "ringStack"
    | "diamond"
    | "helix"
    | "satellite";
};

const MODULES: ModuleConfig[] = [
  {
    phase: 0, label: "Reasoning Core",
    orbitRadius: 1.1, orbitAngle: Math.PI * 0.0, orbitAltitude: 0.55,
    orbitRate: 0.32, spinRate: 1.1, spinAxis: [0.4, 1, 0.2],
    color: PRIMARY, size: 0.14, kind: "icosahedron",
  },
  {
    phase: 1, label: "State Pulse",
    orbitRadius: 0.95, orbitAngle: Math.PI * 0.4, orbitAltitude: -0.1,
    orbitRate: -0.42, spinRate: 1.8, spinAxis: [1, 0.6, 0.3],
    color: WARM, size: 0.13, kind: "diamond",
  },
  {
    phase: 2, label: "Memory Spine",
    orbitRadius: 1.2, orbitAngle: Math.PI * 0.85, orbitAltitude: 0.25,
    orbitRate: 0.24, spinRate: 0.8, spinAxis: [0.2, 1, 0.5],
    color: ACCENT, size: 0.14, kind: "ringStack",
  },
  {
    phase: 3, label: "Browser Optics",
    orbitRadius: 1.05, orbitAngle: Math.PI * 1.25, orbitAltitude: 0.4,
    orbitRate: -0.36, spinRate: 1.4, spinAxis: [0.3, 0.4, 1],
    color: WHITE, size: 0.13, kind: "satellite",
  },
  {
    phase: 4, label: "Bridge Tools",
    orbitRadius: 1.3, orbitAngle: Math.PI * 1.65, orbitAltitude: -0.3,
    orbitRate: 0.28, spinRate: 1.2, spinAxis: [1, 0.3, 0.5],
    color: PRIMARY, size: 0.15, kind: "octahedron",
  },
  {
    phase: 5, label: "Guard Shield",
    orbitRadius: 1.15, orbitAngle: Math.PI * 0.2, orbitAltitude: -0.45,
    orbitRate: -0.34, spinRate: 0.6, spinAxis: [1, 0.5, 0.2],
    color: ACCENT, size: 0.14, kind: "torus",
  },
  {
    phase: 6, label: "Output Channels",
    orbitRadius: 1.0, orbitAngle: Math.PI * 0.6, orbitAltitude: 0.7,
    orbitRate: 0.38, spinRate: 1.6, spinAxis: [0.2, 1, 0.4],
    color: WARM, size: 0.12, kind: "tetrahedron",
  },
  {
    phase: 7, label: "Security Mesh",
    orbitRadius: 1.25, orbitAngle: Math.PI * 1.1, orbitAltitude: -0.55,
    orbitRate: -0.26, spinRate: 0.9, spinAxis: [0.5, 0.3, 1],
    color: PRIMARY, size: 0.14, kind: "dodecahedron",
  },
  {
    phase: 8, label: "Business Layer",
    orbitRadius: 1.1, orbitAngle: Math.PI * 1.45, orbitAltitude: 0.05,
    orbitRate: 0.4, spinRate: 1.3, spinAxis: [0.7, 0.6, 0.5],
    color: ACCENT, size: 0.13, kind: "helix",
  },
  {
    phase: 9, label: "Command Centre",
    orbitRadius: 1.2, orbitAngle: Math.PI * 1.85, orbitAltitude: -0.7,
    orbitRate: 0.22, spinRate: 0.7, spinAxis: [1, 0.4, 0.6],
    color: WARM, size: 0.16, kind: "torusKnot",
  },
];

/** Compile-time guard — we must have exactly 10 modules (1 per install phase). */
if (MODULES.length !== 10) {
  throw new Error(`OrbitalRig expects 10 modules, got ${MODULES.length}`);
}

/** Stable seeded scatter origin — same direction every load. */
function scatterOriginFor(phase: number): THREE.Vector3 {
  // Deterministic hash → unit-sphere direction.
  const a = Math.sin(phase * 12.9898) * 43758.5453;
  const b = Math.sin(phase * 78.233 + 1.0) * 43758.5453;
  const c = Math.sin(phase * 37.719 + 2.0) * 43758.5453;
  const dir = new THREE.Vector3(a - Math.floor(a) - 0.5, b - Math.floor(b) - 0.5, c - Math.floor(c) - 0.5).normalize();
  return dir.multiplyScalar(2.6 + (phase % 3) * 0.4);
}

export function OrbitalRig({ forceInstalled = false }: Props) {
  return (
    <group>
      {MODULES.map((m) => (
        <OrbitalModule key={m.phase} config={m} forceInstalled={forceInstalled} />
      ))}
    </group>
  );
}

function OrbitalModule({
  config,
  forceInstalled,
}: {
  config: ModuleConfig;
  forceInstalled: boolean;
}) {
  const groupRef = useRef<THREE.Group | null>(null);
  const spinRef = useRef<THREE.Group | null>(null);
  const bridge = useSceneBridge();
  const scatter = useMemo(() => scatterOriginFor(config.phase), [config.phase]);
  const spinAxisVec = useMemo(
    () => new THREE.Vector3(...config.spinAxis).normalize(),
    [config.spinAxis],
  );

  // Pre-compute materials via the shared factory so they're stable refs.
  const material = useMemo(
    () => buildAdditiveMaterial({ color: config.color, opacity: 0.85, wireframe: true }),
    [config.color],
  );
  const solidMaterial = useMemo(
    () => buildAdditiveMaterial({ color: config.color, opacity: 0.35 }),
    [config.color],
  );

  useFrame((state, dt) => {
    const g = groupRef.current;
    const spin = spinRef.current;
    if (!g || !spin) return;
    const t = state.clock.elapsedTime;

    const installP = forceInstalled
      ? 1
      : THREE.MathUtils.clamp(bridge.current.install[config.phase] ?? 0, 0, 1);
    const compP = forceInstalled
      ? 1
      : THREE.MathUtils.clamp(bridge.current.compaction, 0, 1);

    // Docked orbital position — computed from current time + orbit rate
    const orbitAngle = config.orbitAngle + t * config.orbitRate;
    const dockX = Math.cos(orbitAngle) * config.orbitRadius;
    const dockZ = Math.sin(orbitAngle) * config.orbitRadius;
    const dockY = config.orbitAltitude + Math.sin(t * 0.5 + config.phase) * 0.04;

    // Pre-install scatter drift — soft sine on a unique seed
    const driftX = Math.sin(t * 0.5 + config.phase * 1.3) * 0.18 * (1 - installP);
    const driftY = Math.cos(t * 0.4 + config.phase * 1.7) * 0.22 * (1 - installP);
    const driftZ = Math.sin(t * 0.3 + config.phase * 2.1) * 0.16 * (1 - installP);

    // Eased interpolation scatter→dock
    const eased = installP * installP * (3 - 2 * installP);

    // Compaction pull — tightens orbit toward core
    const compTighten = 1 - compP * 0.12;

    const targetX = (scatter.x + driftX) * (1 - eased) + dockX * eased * compTighten;
    const targetY = (scatter.y + driftY) * (1 - eased) + dockY * eased * compTighten;
    const targetZ = (scatter.z + driftZ) * (1 - eased) + dockZ * eased * compTighten;

    g.position.x = THREE.MathUtils.damp(g.position.x, targetX, 7, dt);
    g.position.y = THREE.MathUtils.damp(g.position.y, targetY, 7, dt);
    g.position.z = THREE.MathUtils.damp(g.position.z, targetZ, 7, dt);

    // Internal spin — module rotates on its own axis regardless of orbit
    const spinDelta = dt * config.spinRate * (0.4 + installP * 0.6);
    spin.rotateOnAxis(spinAxisVec, spinDelta);

    // Compaction brightness spike
    material.opacity = 0.5 + installP * 0.4 + compP * 0.25;
    solidMaterial.opacity = 0.15 + installP * 0.25 + compP * 0.2;
  });

  return (
    <group ref={groupRef}>
      <group ref={spinRef}>
        <ModuleGeometry kind={config.kind} size={config.size} wireMaterial={material} solidMaterial={solidMaterial} />
      </group>
    </group>
  );
}

/** Renders the primitive geometry for a single module type. */
function ModuleGeometry({
  kind,
  size,
  wireMaterial,
  solidMaterial,
}: {
  kind: ModuleConfig["kind"];
  size: number;
  wireMaterial: THREE.MeshBasicMaterial;
  solidMaterial: THREE.MeshBasicMaterial;
}) {
  switch (kind) {
    case "icosahedron":
      return (
        <>
          <mesh material={wireMaterial}><icosahedronGeometry args={[size, 1]} /></mesh>
          <mesh material={solidMaterial} scale={0.82}><icosahedronGeometry args={[size, 0]} /></mesh>
        </>
      );
    case "tetrahedron":
      return (
        <>
          <mesh material={wireMaterial}><tetrahedronGeometry args={[size * 1.3, 0]} /></mesh>
          <mesh material={solidMaterial} scale={0.7}><tetrahedronGeometry args={[size * 1.3, 0]} /></mesh>
        </>
      );
    case "octahedron":
      return (
        <>
          <mesh material={wireMaterial}><octahedronGeometry args={[size * 1.2, 0]} /></mesh>
          <mesh material={solidMaterial} scale={0.75}><octahedronGeometry args={[size * 1.2, 0]} /></mesh>
        </>
      );
    case "dodecahedron":
      return (
        <>
          <mesh material={wireMaterial}><dodecahedronGeometry args={[size, 0]} /></mesh>
          <mesh material={solidMaterial} scale={0.8}><dodecahedronGeometry args={[size, 0]} /></mesh>
        </>
      );
    case "torus":
      return (
        <>
          <mesh material={wireMaterial}><torusGeometry args={[size, size * 0.28, 8, 24]} /></mesh>
          <mesh material={solidMaterial} scale={0.92}><torusGeometry args={[size, size * 0.18, 6, 20]} /></mesh>
        </>
      );
    case "torusKnot":
      return (
        <>
          <mesh material={wireMaterial}><torusKnotGeometry args={[size * 0.8, size * 0.22, 64, 8]} /></mesh>
        </>
      );
    case "diamond":
      // Stacked octahedrons — a "diamond" shape
      return (
        <>
          <mesh material={wireMaterial} scale={[1, 1.4, 1]}><octahedronGeometry args={[size, 0]} /></mesh>
          <mesh material={solidMaterial} scale={[0.7, 1.2, 0.7]}><octahedronGeometry args={[size, 0]} /></mesh>
        </>
      );
    case "ringStack":
      // 3 concentric rings on different axes
      return (
        <>
          <mesh material={wireMaterial} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[size, size * 0.06, 6, 24]} />
          </mesh>
          <mesh material={wireMaterial} rotation={[0, Math.PI / 2, 0]} scale={0.78}>
            <torusGeometry args={[size, size * 0.06, 6, 24]} />
          </mesh>
          <mesh material={wireMaterial} scale={0.56}>
            <torusGeometry args={[size, size * 0.06, 6, 24]} />
          </mesh>
        </>
      );
    case "helix":
      // Helix-like form: small spheres arranged in a vertical spiral
      return (
        <group>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => {
            const phi = (i / 7) * Math.PI * 2;
            const y = (i / 7 - 0.5) * size * 2.5;
            const r = size * 0.6;
            return (
              <mesh key={i} material={wireMaterial} position={[Math.cos(phi) * r, y, Math.sin(phi) * r]}>
                <sphereGeometry args={[size * 0.22, 8, 6]} />
              </mesh>
            );
          })}
        </group>
      );
    case "satellite":
      // Sphere with orbital ring around it (eye-like)
      return (
        <>
          <mesh material={solidMaterial}><sphereGeometry args={[size * 0.45, 16, 12]} /></mesh>
          <mesh material={wireMaterial}><sphereGeometry args={[size * 0.7, 12, 8]} /></mesh>
          <mesh material={wireMaterial} rotation={[Math.PI / 2.4, 0, 0]}>
            <torusGeometry args={[size * 1.1, size * 0.04, 6, 28]} />
          </mesh>
        </>
      );
  }
}
