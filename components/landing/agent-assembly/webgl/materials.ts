import * as THREE from "three";

/**
 * V5 material factory — single shared additive-emissive builder.
 *
 * After the humanoid figure was retired in V5 (replaced by OasisCore +
 * OrbitalRig + HoloAccents), every visible mesh in this WebGL feature
 * is a glowing wireframe or translucent solid rendered with
 * MeshBasicMaterial + AdditiveBlending so it composites cleanly with
 * the FlowField backdrop and feeds the Bloom post-process.
 *
 * The V1-V4 MeshStandardMaterial factories (shell/chassis/accent/warm)
 * are gone — they only made sense for the now-deleted plastic-armor
 * humanoid. If V6 ever brings back PBR materials, restore them here.
 *
 * Returns a new instance each call — caller is expected to wrap in
 * useMemo so material identity is stable across renders.
 */

export const PRIMARY_GREEN = "#86efac";
export const ACCENT_CYAN = "#5eead4";
export const WARM_AMBER = "#fcd34d";
export const SHELL_WHITE = "#f5f5f4";

type AdditiveOpts = {
  color: string;
  opacity?: number;
  wireframe?: boolean;
  /** Use side: DoubleSide — required for thin ring/torus surfaces
   *  that the camera can see from either side. */
  doubleSide?: boolean;
};

/** The one and only material constructor used across OasisCore,
 *  OrbitalRig, and HoloAccents. */
export function buildAdditiveMaterial({
  color,
  opacity = 0.65,
  wireframe = false,
  doubleSide = false,
}: AdditiveOpts): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    wireframe,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
}
