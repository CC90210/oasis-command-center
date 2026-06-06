import * as THREE from "three";

/**
 * Shared material singletons for the humanoid rig.
 *
 * Allocating one MeshStandardMaterial per mesh (~60 meshes across 10
 * subassemblies) tanks frame-time inside useFrame, and each material
 * carries its own shader uniforms. We keep ONE shell + ONE emissive
 * material at module scope and let every mesh point at the same instance.
 *
 * Mutating opacity is still safe per-subassembly because we DON'T mutate
 * these — we override per-mesh via the JSX prop spread on the parent
 * `<group>` (`material-opacity` via R3F). When we need per-subassembly
 * opacity (edges-first materialization), the subassembly clones the
 * material once at mount and stores the clone in a ref.
 *
 * Colour palette:
 *  - shell: warm off-white (#f5f5f4) — matches the reference photoreal
 *           plastic-armor render. Slight metalness keeps highlights
 *           legible without making the figure look like polished steel.
 *  - emissive seam: OASIS green (#86efac) — the brand accent already used
 *           in the surrounding scene's connection lines and progress bar.
 */

export const SHELL_COLOR = "#f5f5f4";
export const EMISSIVE_COLOR = "#86efac";
export const ACCENT_COLOR = "#5eead4";
export const WARM_COLOR = "#fcd34d";

/**
 * Factory functions — subassemblies that need per-instance opacity
 * control call these to get their own MeshStandardMaterial instance. The
 * geometry cost is in the geometry, not the material, so allocating 10
 * materials (one per subassembly) is fine; it's allocating 60+ (one per
 * mesh) we want to avoid.
 */
export function createShellMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: SHELL_COLOR,
    metalness: 0.15,
    roughness: 0.42,
    envMapIntensity: 0.8,
    transparent: true,
    opacity: 0,
  });
  m.name = "shellMaterial";
  return m;
}

export function createEmissiveMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: "#0a0f0a",
    emissive: EMISSIVE_COLOR,
    emissiveIntensity: 2.4,
    metalness: 0.0,
    roughness: 0.6,
    transparent: true,
    opacity: 0,
  });
  m.name = "emissiveMaterial";
  return m;
}

export function createAccentMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: "#08110f",
    emissive: ACCENT_COLOR,
    emissiveIntensity: 1.8,
    metalness: 0.1,
    roughness: 0.5,
    transparent: true,
    opacity: 0,
  });
  m.name = "accentMaterial";
  return m;
}
