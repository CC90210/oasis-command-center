import * as THREE from "three";

/**
 * Shared material singletons for the humanoid rig.
 *
 * Allocating one MeshStandardMaterial per mesh (~60 meshes across 10
 * subassemblies) tanks frame-time inside useFrame, and each material
 * carries its own shader uniforms. We keep ONE material per type per
 * subassembly via the create*Material() factories below.
 *
 * Material palette (V2 — adds darker chassis + circuit + bright accent
 * tiers so each subassembly can layer ARMOR PLATING over EXPOSED
 * MECHANISMS over GLOWING SEAMS, instead of everything reading as
 * one flat plastic shell):
 *
 *   shellMaterial    — matte white plastic armor (top layer)
 *   chassisMaterial  — darker brushed metal (under-armor frame)
 *   accentMaterial   — cool green PCB substrate (exposed circuits)
 *   emissiveMaterial — OASIS green glow (seams, heart core, eyes)
 *   warmMaterial     — amber glow (status indicators, podium ring)
 *
 * The shell and chassis materials are NEVER emissive (they reflect
 * scene lighting). The emissive/warm materials ignore lighting and
 * drive bloom. Mixing the two tiers is what turns a plastic toy into
 * a layered mechanical assembly.
 */

export const SHELL_COLOR = "#f5f5f4";       // matte off-white plastic
export const CHASSIS_COLOR = "#2a2f33";     // brushed gunmetal
export const EMISSIVE_COLOR = "#86efac";    // OASIS green
export const ACCENT_COLOR = "#5eead4";      // cyan accent
export const WARM_COLOR = "#fcd34d";        // amber status
export const CIRCUIT_COLOR = "#0a1a14";     // very dark green PCB substrate

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

/** Circuit / PCB substrate — very dark green that catches a hint of the
 *  scene lights but lets emissive overlays pop. Used for "exposed
 *  motherboard" patches behind grilles. */
export function createCircuitMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: CIRCUIT_COLOR,
    metalness: 0.4,
    roughness: 0.6,
    transparent: true,
    opacity: 0,
  });
  m.name = "chassisMaterial"; // share opacity bucket with chassis
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
