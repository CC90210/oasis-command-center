"use client";

import dynamic from "next/dynamic";
import { type MotionValue } from "framer-motion";
import { SilhouetteFallback } from "./webgl/SilhouetteFallback";

/**
 * AgentFigureSprite — public boundary the parent scene mounts.
 *
 * The legacy 612-line PNG-slice implementation has been replaced by a
 * procedurally-generated WebGL humanoid. This file is now a thin
 * dynamic-import shim that:
 *   - preserves the SPRITE_LAYER_COUNT = 10 contract the parent scene uses
 *     to derive PHASE_COUNT (PHASE_COUNT = SPRITE_LAYER_COUNT + 1),
 *   - preserves the prop shape (installProgresses[10] + compactionProgress
 *     + forceInstalled + className),
 *   - lazy-loads the WebGL chunk (~200KB gzipped) only on the client so
 *     LCP and the marketing-route bundle stay lean,
 *   - renders the SVG silhouette during SSR + chunk load + (optionally)
 *     reduced-motion preference.
 *
 * The actual figure code lives in ./webgl/*.tsx — keep this file boring.
 */

export const SPRITE_LAYER_COUNT = 10;

type Props = {
  installProgresses: MotionValue<number>[];
  compactionProgress: MotionValue<number>;
  forceInstalled?: boolean;
  className?: string;
};

const AgentFigureWebGL = dynamic(
  () => import("./webgl/AgentFigureWebGL").then((m) => m.AgentFigureWebGL),
  {
    ssr: false,
    loading: () => <SilhouetteFallback />,
  },
);

export function AgentFigureSprite(props: Props) {
  if (props.installProgresses.length !== SPRITE_LAYER_COUNT) {
    throw new Error(
      `AgentFigureSprite expects ${SPRITE_LAYER_COUNT} installProgresses, got ${props.installProgresses.length}`,
    );
  }
  return <AgentFigureWebGL {...props} />;
}
