"use client";

import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import { useMotionValueEvent, type MotionValue } from "framer-motion";

/**
 * SceneBridge — bridges framer-motion MotionValues into a ref that R3F's
 * useFrame can read every frame WITHOUT re-rendering the React tree.
 *
 * If we read MotionValues via useMotionValue + useState inside an R3F
 * subassembly, every scroll tick (60 Hz) triggers a React re-render
 * underneath the canvas, which thrashes the reconciler and tanks framerate.
 *
 * Instead: subscribe once at the bridge level, write the latest scalar
 * into a useRef object, and let descendants pull from the ref inside
 * useFrame. The ref is exposed via context so descendants don't need
 * the ref prop drilled through every layer.
 */

export type BridgeState = {
  install: number[];        // 10 install progress scalars (0–1)
  compaction: number;       // single compaction progress scalar (0–1)
};

const BridgeContext = createContext<{ ref: { current: BridgeState } } | null>(null);

export function useSceneBridge(): { current: BridgeState } {
  const ctx = useContext(BridgeContext);
  if (!ctx) {
    throw new Error("useSceneBridge must be used inside <SceneBridge>");
  }
  return ctx.ref;
}

type Props = {
  installProgresses: MotionValue<number>[];
  compactionProgress: MotionValue<number>;
  children: ReactNode;
};

export function SceneBridge({ installProgresses, compactionProgress, children }: Props) {
  // Single ref holds the latest snapshot. useFrame consumers read from it.
  const stateRef = useRef<BridgeState>({
    install: new Array(10).fill(0),
    compaction: 0,
  });

  // 10 explicit hook calls — keeps React's hook order stable and silences
  // the rules-of-hooks linter. The parent shim guarantees installProgresses
  // is always length 10 (SPRITE_LAYER_COUNT contract).
  useMotionValueEvent(installProgresses[0], "change", (v) => { stateRef.current.install[0] = v; });
  useMotionValueEvent(installProgresses[1], "change", (v) => { stateRef.current.install[1] = v; });
  useMotionValueEvent(installProgresses[2], "change", (v) => { stateRef.current.install[2] = v; });
  useMotionValueEvent(installProgresses[3], "change", (v) => { stateRef.current.install[3] = v; });
  useMotionValueEvent(installProgresses[4], "change", (v) => { stateRef.current.install[4] = v; });
  useMotionValueEvent(installProgresses[5], "change", (v) => { stateRef.current.install[5] = v; });
  useMotionValueEvent(installProgresses[6], "change", (v) => { stateRef.current.install[6] = v; });
  useMotionValueEvent(installProgresses[7], "change", (v) => { stateRef.current.install[7] = v; });
  useMotionValueEvent(installProgresses[8], "change", (v) => { stateRef.current.install[8] = v; });
  useMotionValueEvent(installProgresses[9], "change", (v) => { stateRef.current.install[9] = v; });
  useMotionValueEvent(compactionProgress, "change", (v) => { stateRef.current.compaction = v; });

  const value = useMemo(() => ({ ref: stateRef }), []);
  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}
