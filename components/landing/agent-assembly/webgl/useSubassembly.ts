"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useSceneBridge } from "./SceneBridge";

/**
 * useSubassembly — common animation contract for every named subassembly
 * (ReasoningCore … CommandCentre).
 *
 * Each subassembly is a `<group>` with:
 *   - children meshes (shellMaterial-tagged or emissiveMaterial-tagged)
 *   - drei `<Edges>` overlays on those meshes (rendered as LineSegments)
 *
 * On every frame this hook reads the bridge ref (latest install + compaction
 * progress, written by SceneBridge) and:
 *
 *  1. Lerps the group's position from `scatter` → `target` as installP
 *     ramps 0→1, with a per-subassembly idle float (sine drift on a unique
 *     seed) added on top while still scattered. The float dampens to 0 as
 *     the part snaps home.
 *  2. Applies a tiny "lock click" overshoot at the end of the install
 *     window (small positive Y impulse decaying as installP → 1.0).
 *  3. Ramps material opacities — edges fade in over the first 40% of the
 *     install window, shells fade in over the back 60% (wireframe-first
 *     materialization). Traverses children to find by material.name.
 *  4. During the compaction phase (compP > 0), bumps emissiveIntensity
 *     so the figure glows brighter as the system comes online.
 *
 * forceInstalled short-circuits to the final pose for reduced-motion users.
 */

type Props = {
  manifestIdx: number;
  target: THREE.Vector3;
  scatter: THREE.Vector3;
  forceInstalled?: boolean;
  /**
   * Seed multiplier for idle float — defaults to manifestIdx so all 10
   * subassemblies breathe on independent rhythms without colliding.
   */
  floatSeed?: number;
};

const FLOAT_AMP = 0.18;
const ROT_AMP = 0.16;
const DAMP_POS = 9;
const DAMP_ROT = 6;
const BASE_EMISSIVE_INTENSITY = 2.4;
const COMPACTION_EMISSIVE_BOOST = 0.8;

export function useSubassembly({
  manifestIdx,
  target,
  scatter,
  forceInstalled = false,
  floatSeed,
}: Props) {
  const groupRef = useRef<THREE.Group | null>(null);
  const bridge = useSceneBridge();
  const seed = (floatSeed ?? manifestIdx) * 0.137;
  const tmpTarget = useMemo(() => new THREE.Vector3(), []);

  // Snap to final pose on mount for reduced-motion users; otherwise start
  // at scatter origin with wireframe edges already at 0.55 alpha so the
  // figure reads as "skeleton floating in space" the moment the canvas
  // paints — not invisible until the first useFrame.
  useEffect(() => {
    if (!groupRef.current) return;
    if (forceInstalled) {
      groupRef.current.position.copy(target);
      groupRef.current.rotation.set(0, 0, 0);
      paintOpacity(groupRef.current, 1, 1, 1);
    } else {
      groupRef.current.position.copy(scatter);
      paintOpacity(groupRef.current, 0, 0.55, 0.55);
    }
  }, [forceInstalled, target, scatter]);

  useFrame((state, dt) => {
    const g = groupRef.current;
    if (!g) return;
    if (forceInstalled) return; // static — never re-animated

    const installP = THREE.MathUtils.clamp(
      bridge.current.install[manifestIdx] ?? 0,
      0,
      1,
    );
    const compP = THREE.MathUtils.clamp(bridge.current.compaction, 0, 1);
    const t = state.clock.elapsedTime;
    const scattered = 1 - installP;

    // Idle float — sine drift on a unique phase per subassembly. Dampens
    // to 0 as installP → 1 so the snapped part doesn't jitter.
    const fx = Math.sin(t * 0.6 + seed * 1.7) * FLOAT_AMP * scattered;
    const fy = Math.cos(t * 0.5 + seed * 2.3) * FLOAT_AMP * 1.1 * scattered;
    const fz = Math.sin(t * 0.4 + seed * 1.1) * FLOAT_AMP * 0.7 * scattered;
    const frotX = Math.sin(t * 0.35 + seed * 0.8) * ROT_AMP * scattered;
    const frotY = Math.cos(t * 0.42 + seed * 1.3) * ROT_AMP * scattered;
    const frotZ = Math.sin(t * 0.28 + seed * 0.5) * ROT_AMP * 0.5 * scattered;

    // Lerp scatter → target across the install window, plus the float on
    // top. Overshoot kicks in near the end of the window so the snap feels
    // mechanical — like a magnet pulling the part the last centimetre.
    const overshoot =
      installP > 0.5
        ? Math.sin((installP - 0.5) * Math.PI * 2) * 0.06 * (1 - installP) * 2
        : 0;

    tmpTarget.set(
      scatter.x * scattered + target.x * installP + fx,
      scatter.y * scattered + target.y * installP + fy + overshoot,
      scatter.z * scattered + target.z * installP + fz,
    );

    // Damped spring — uses MathUtils.damp (frame-rate-independent lerp).
    g.position.x = THREE.MathUtils.damp(g.position.x, tmpTarget.x, DAMP_POS, dt);
    g.position.y = THREE.MathUtils.damp(g.position.y, tmpTarget.y, DAMP_POS, dt);
    g.position.z = THREE.MathUtils.damp(g.position.z, tmpTarget.z, DAMP_POS, dt);

    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, frotX, DAMP_ROT, dt);
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, frotY, DAMP_ROT, dt);
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, frotZ, DAMP_ROT, dt);

    // Opacity ramps. KEY DESIGN: parts are VISIBLE from the start as
    // wireframe-only outlines drifting in zero-g (so the user sees the
    // "transformer parts floating in space" before they scroll). When the
    // install phase fires, the shell materializes and locks the part home.
    //
    //   edges:  0.55 (always lit) → 1.0 at end of install
    //   shell:  0 → 1.0 over the back 60% of the install window
    const edgeOp = 0.55 + 0.45 * THREE.MathUtils.smoothstep(installP, 0, 1);
    const shellOp = THREE.MathUtils.smoothstep(installP, 0.4, 1);
    const emissiveOp = Math.max(edgeOp, shellOp);

    paintOpacity(g, shellOp, emissiveOp, edgeOp);

    // Emissive intensity ramps as compaction beat finishes — the "coming
    // online" feel. Applied to every emissive material the subassembly owns.
    g.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (m && (m.name === "emissiveMaterial" || m.name === "accentMaterial")) {
          m.emissiveIntensity =
            BASE_EMISSIVE_INTENSITY + compP * COMPACTION_EMISSIVE_BOOST;
        }
      }
    });
  });

  return { groupRef };
}

/**
 * Traverses the group, setting opacity on:
 *  - meshes named "shellMaterial" → shellOp
 *  - meshes named "emissiveMaterial" / "accentMaterial" → emissiveOp
 *  - LineSegments (drei <Edges> output) → edgeOp
 *
 * Mutating mat.opacity is a no-render uniform update — does NOT cause
 * React to re-render.
 */
function paintOpacity(
  group: THREE.Group,
  shellOp: number,
  emissiveOp: number,
  edgeOp: number,
) {
  group.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const m = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial;
      if (!m) return;
      // Shell + chassis tiers ramp together (both are reflective, non-emissive).
      if (m.name === "shellMaterial" || m.name === "chassisMaterial") {
        m.opacity = shellOp;
      } else if (m.name === "emissiveMaterial" || m.name === "accentMaterial") {
        m.opacity = emissiveOp;
      }
    } else if ((obj as THREE.LineSegments).isLineSegments) {
      const m = (obj as THREE.LineSegments).material as THREE.LineBasicMaterial;
      if (!m) return;
      m.transparent = true;
      m.opacity = edgeOp;
    }
  });
}
