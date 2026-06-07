import * as THREE from "three";

/**
 * Shared material singletons for the humanoid rig.
 *
 * Allocating one MeshStandardMaterial per mesh (~60 meshes across 10
 * subassemblies) tanks frame-time inside useFrame, and each material
 * carries its own shader uniforms. We keep ONE material per type per
 * subassembly via the create*Material() factories below.
 *
 * Material palette (V2):
 *
 *   shellMaterial    — matte white plastic armor (top layer)
 *   chassisMaterial  — darker brushed metal (under-armor frame)
 *   emissiveMaterial — OASIS green glow (seams, heart core, eyes)
 *   accentMaterial   — cool cyan glow (used sparingly for variety)
 *   warmMaterial     — amber glow (status indicators, podium markers)
 *
 * The shell and chassis materials are NEVER emissive (they reflect
 * scene lighting). The emissive / accent / warm materials ignore
 * lighting and drive bloom. Layering the two tiers is what turns a
 * plastic toy into a mechanical assembly.
 *
 * Only EMISSIVE_COLOR and SHELL_COLOR are exported — the other colour
 * constants are internal to the factories and would only cause drift
 * if consumers reached for them directly. Subassemblies that need to
 * tint an Edges line use EMISSIVE_COLOR.
 */

export const SHELL_COLOR = "#f5f5f4";       // matte off-white plastic
export const EMISSIVE_COLOR = "#86efac";    // OASIS green

const CHASSIS_COLOR = "#2a2f33";   // brushed gunmetal (chassis tier)
const ACCENT_COLOR = "#5eead4";    // cyan emissive (rarely used)
const WARM_COLOR = "#fcd34d";      // amber status

export function createShellMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: SHELL_COLOR,
    metalness: 0.18,
    roughness: 0.42,
    envMapIntensity: 0.85,
    transparent: true,
    opacity: 0,
  });
  m.name = "shellMaterial";
  return m;
}

/** Chassis — the darker brushed-metal frame beneath the armor plates.
 *  Visible at joints, neck seam, exposed mechanical sections. */
export function createChassisMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: CHASSIS_COLOR,
    metalness: 0.78,
    roughness: 0.32,
    envMapIntensity: 1.1,
    transparent: true,
    opacity: 0,
  });
  m.name = "chassisMaterial";
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

/** Warm amber emissive — used sparingly for status / activation indicators
 *  (podium ring, eye core, hazard markers) so the figure has a second
 *  emissive temperature next to the dominant green. */
export function createWarmMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: "#1a0f00",
    emissive: WARM_COLOR,
    emissiveIntensity: 2.0,
    metalness: 0.0,
    roughness: 0.5,
    transparent: true,
    opacity: 0,
  });
  m.name = "accentMaterial"; // share emissive opacity bucket
  return m;
}
