"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useSceneBridge } from "./SceneBridge";
import { ReasoningCore } from "./subassemblies/ReasoningCore";
import { StatePulse } from "./subassemblies/StatePulse";
import { MemorySpine } from "./subassemblies/MemorySpine";
import { BrowserOptics } from "./subassemblies/BrowserOptics";
import { BridgeTools } from "./subassemblies/BridgeTools";
import { GuardShield } from "./subassemblies/GuardShield";
import { OutputChannels } from "./subassemblies/OutputChannels";
import { SecurityMesh } from "./subassemblies/SecurityMesh";
import { BusinessLayer } from "./subassemblies/BusinessLayer";
import { CommandCentre } from "./subassemblies/CommandCentre";

/**
 * HumanoidRig — parent group for all 10 subassemblies. Each subassembly
 * owns its own scatter→target lerp; the rig wraps them in a single
 * outer group that applies RIG-WIDE behaviours:
 *
 *  1. **Lock-click scale punch** during phase 11 (compaction beat).
 *     The whole assembled rig briefly snaps to 1.06× then settles to
 *     1.0 — the visual "magnet click" that confirms SYSTEM ONLINE.
 *  2. **Breathing pulse** once the figure is fully assembled and locked.
 *     Slow 3-second period sine adds ±0.5% scale. Subtle — reads as
 *     alive, not as a bouncy ball.
 *  3. **Slow Y rotation** once locked. 120-second period (one rotation
 *     every 2 minutes) so the figure presents at every angle as the
 *     visitor reads down the page, but never enough to feel like a
 *     spinning toy.
 *
 * forceInstalled (reduced-motion) skips all rig-wide animation — the
 * figure renders one static frame at scale=1, rotation=0.
 */

type Props = { forceInstalled?: boolean };

export function HumanoidRig({ forceInstalled = false }: Props) {
  const rigRef = useRef<THREE.Group | null>(null);
  const bridge = useSceneBridge();

  useFrame((state, dt) => {
    const g = rigRef.current;
    if (!g) return;
    if (forceInstalled) return;

    const compP = THREE.MathUtils.clamp(bridge.current.compaction, 0, 1);
    const t = state.clock.elapsedTime;

    // Lock-click scale: punches to 1.06 around the 50% mark of the
    // compaction window, then eases back to 1.0 by the end. After
    // compaction completes, the breathing pulse takes over.
    const lockPunch = compP > 0 ? Math.sin(compP * Math.PI) * 0.06 : 0;
    const breathing = compP >= 0.99 ? Math.sin(t * (Math.PI * 2) / 3) * 0.005 : 0;
    const scale = 1 + lockPunch + breathing;
    g.scale.setScalar(scale);

    // Slow Y rotation — only kicks in once fully assembled. 2-minute
    // period. THREE.MathUtils.damp gives a smooth ramp from 0 → target
    // angular velocity instead of a hard start.
    if (compP >= 0.99) {
      const dampedRate = THREE.MathUtils.damp(0, dt * (Math.PI * 2) / 120, 4, dt);
      g.rotation.y += dampedRate;
    } else {
      // While compaction is still in progress, settle rotation back to
      // 0 in case scroll-back-up partially reset.
      g.rotation.y = THREE.MathUtils.damp(g.rotation.y, 0, 4, dt);
    }
  });

  return (
    <group ref={rigRef}>
      <ReasoningCore forceInstalled={forceInstalled} />
      <StatePulse forceInstalled={forceInstalled} />
      <MemorySpine forceInstalled={forceInstalled} />
      <BrowserOptics forceInstalled={forceInstalled} />
      <BridgeTools forceInstalled={forceInstalled} />
      <GuardShield forceInstalled={forceInstalled} />
      <OutputChannels forceInstalled={forceInstalled} />
      <SecurityMesh forceInstalled={forceInstalled} />
      <BusinessLayer forceInstalled={forceInstalled} />
      <CommandCentre forceInstalled={forceInstalled} />
    </group>
  );
}
