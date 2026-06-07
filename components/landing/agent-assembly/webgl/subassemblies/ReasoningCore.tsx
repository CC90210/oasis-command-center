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
 * 01 — Reasoning Core (V3). AI-helmet redesigned around the FACE as the
 * focal point.
 *
 * The V2 face plate was a solid shell box that obscured the visor and
 * eyes — making the figure read as "blocky robot without features".
 * V3 rebuilds the head as:
 *
 *   - Elongated cranial dome (deeper back-of-skull, slimmer crown)
 *   - SKULL FRAME — narrow chassis ring that defines the head outline
 *   - DARK FACE CAVITY — recessed chassis "screen" behind a thin shell
 *     frame, so BrowserOptics' visor + eyes have somewhere to sit and
 *     dominate
 *   - Cheek armor angled inward (V-shaped jawline, not blocky)
 *   - Chin / vocal grille — slim chassis bar with horizontal slats
 *   - Crown antenna trio (centered + 2 side angled) — fewer but cleaner
 *   - Side ear plates (radar discs) — repositioned + smaller
 *   - Forehead amber LED + side temple status dots
 */

const TARGET = new THREE.Vector3(0, 1.35, 0);
const SCATTER = new THREE.Vector3(-1.4, 1.6, -1.0);

export function ReasoningCore({ forceInstalled = false }: { forceInstalled?: boolean }) {
  const shell = useMemo(() => createShellMaterial(), []);
  const chassis = useMemo(() => createChassisMaterial(), []);
  const emissive = useMemo(() => createEmissiveMaterial(), []);
  const warm = useMemo(() => createWarmMaterial(), []);
  const { groupRef } = useSubassembly({
    manifestIdx: 0,
    target: TARGET,
    scatter: SCATTER,
    forceInstalled,
  });

  return (
    <group ref={groupRef}>
      {/* ───────── CRANIAL DOME (taller, deeper, elongated) ───────── */}
      <mesh material={shell} position={[0, 0.1, -0.015]} scale={[0.94, 1.02, 1.08]}>
        <sphereGeometry args={[0.22, 32, 22, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Crown ridge — central panel from front to back */}
      <mesh material={chassis} position={[0, 0.22, -0.02]}>
        <boxGeometry args={[0.05, 0.04, 0.36]} />
      </mesh>
      {/* Top crown emissive accent */}
      <mesh material={emissive} position={[0, 0.245, -0.02]}>
        <boxGeometry args={[0.025, 0.005, 0.3]} />
      </mesh>
      {/* Inner dome chassis seam */}
      <mesh material={chassis} position={[0, 0.06, -0.015]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.215, 0.011, 8, 32]} />
      </mesh>

      {/* ───────── ANTENNA TRIO ───────── */}
      {/* Central tall pylon with warm tip */}
      <mesh material={chassis} position={[0, 0.32, -0.02]}>
        <cylinderGeometry args={[0.008, 0.013, 0.14, 8]} />
      </mesh>
      <mesh material={warm} position={[0, 0.4, -0.02]}>
        <sphereGeometry args={[0.014, 8, 8]} />
      </mesh>
      {/* 2 angled side antennas — swept back */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * 0.07, 0.26, -0.06]} rotation={[0.4, 0, sign * -0.4]}>
          <mesh material={chassis}>
            <cylinderGeometry args={[0.007, 0.01, 0.1, 6]} />
          </mesh>
          <mesh material={emissive} position={[0, 0.055, 0]}>
            <sphereGeometry args={[0.009, 6, 6]} />
          </mesh>
        </group>
      ))}

      {/* ───────── SIDE EAR PLATES (smaller, repositioned) ───────── */}
      {[-1, 1].map((sign) => (
        <group key={sign} position={[sign * 0.2, 0.04, -0.02]} rotation={[0, sign * -0.15, sign * 0.25]}>
          {/* Chassis backing */}
          <mesh material={chassis}>
            <boxGeometry args={[0.025, 0.12, 0.08]} />
          </mesh>
          {/* Outer disc */}
          <mesh material={shell} position={[sign * 0.018, 0, 0]} rotation={[0, sign * Math.PI / 2, 0]}>
            <cylinderGeometry args={[0.038, 0.038, 0.012, 14]} />
            <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
          </mesh>
          {/* Centre emissive dot */}
          <mesh material={emissive} position={[sign * 0.024, 0, 0]} rotation={[0, sign * Math.PI / 2, 0]}>
            <cylinderGeometry args={[0.009, 0.009, 0.003, 8]} />
          </mesh>
        </group>
      ))}

      {/* ───────── FACE CAVITY ─────────
          Dark chassis "screen" recessed BEHIND a thin shell frame.
          This is the negative space that BrowserOptics sits in. */}
      {/* Recessed face cavity — dark chassis backdrop for the visor */}
      <mesh material={chassis} position={[0, -0.025, 0.135]}>
        <boxGeometry args={[0.26, 0.18, 0.04]} />
      </mesh>

      {/* Face frame — thin shell border around the cavity (top bar) */}
      <mesh material={shell} position={[0, 0.075, 0.158]}>
        <boxGeometry args={[0.3, 0.025, 0.02]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Face frame — bottom bar */}
      <mesh material={shell} position={[0, -0.118, 0.158]}>
        <boxGeometry args={[0.3, 0.025, 0.02]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Face frame — left vertical pillar */}
      <mesh material={shell} position={[-0.143, -0.025, 0.158]}>
        <boxGeometry args={[0.025, 0.18, 0.02]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>
      {/* Face frame — right vertical pillar */}
      <mesh material={shell} position={[0.143, -0.025, 0.158]}>
        <boxGeometry args={[0.025, 0.18, 0.02]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>

      {/* Skull rear/sides — wrap the back of the head */}
      <mesh material={shell} position={[0, -0.02, -0.05]}>
        <boxGeometry args={[0.32, 0.2, 0.2]} />
        <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
      </mesh>

      {/* ───────── ANGLED CHEEK ARMOR (V-jaw, not blocky) ───────── */}
      {[-1, 1].map((sign) => (
        <mesh
          key={sign}
          material={shell}
          position={[sign * 0.14, -0.14, 0.04]}
          rotation={[0, sign * 0.25, sign * 0.18]}
        >
          <boxGeometry args={[0.055, 0.12, 0.14]} />
          <Edges threshold={35} color={EMISSIVE_COLOR} scale={1.003} renderOrder={1} />
        </mesh>
      ))}

      {/* ───────── CHIN + VOCAL GRILLE ─────────  */}
      {/* Chin chassis bar — thinner than V2's blocky jaw */}
      <mesh material={chassis} position={[0, -0.21, 0.07]}>
        <boxGeometry args={[0.16, 0.05, 0.1]} />
      </mesh>
      {/* Vocal grille — 4 horizontal slats */}
      {[-0.022, -0.007, 0.008, 0.023].map((dy, i) => (
        <mesh key={i} material={emissive} position={[0, -0.215 + dy * 0.5, 0.12]}>
          <boxGeometry args={[0.08, 0.005, 0.005]} />
        </mesh>
      ))}

      {/* ───────── FOREHEAD STATUS LEDs (above the face frame) ───────── */}
      <mesh material={warm} position={[0, 0.095, 0.171]}>
        <boxGeometry args={[0.018, 0.01, 0.005]} />
      </mesh>
      <mesh material={emissive} position={[-0.03, 0.095, 0.171]}>
        <boxGeometry args={[0.01, 0.008, 0.005]} />
      </mesh>
      <mesh material={emissive} position={[0.03, 0.095, 0.171]}>
        <boxGeometry args={[0.01, 0.008, 0.005]} />
      </mesh>

      {/* ───────── NEURAL CONDUIT PORTS (back of skull) ───────── */}
      {[-0.07, 0.07].map((x, i) => (
        <group key={i} position={[x, 0.02, -0.16]}>
          <mesh material={chassis}>
            <cylinderGeometry args={[0.018, 0.018, 0.04, 8]} />
          </mesh>
          <mesh material={emissive} position={[0, 0.022, 0]}>
            <cylinderGeometry args={[0.012, 0.012, 0.004, 8]} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
