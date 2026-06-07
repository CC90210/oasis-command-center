import * as THREE from "three";

/**
 * Procedural particle distribution for the agent silhouette.
 *
 * Returns three Float32Arrays:
 *   - rest:     anatomical home position per particle (xyz)
 *   - scatter:  pre-install scattered origin per particle (xyz)
 *   - phaseSeed: [phase (0-9), seed (0-1), driftSeed (0-1)] per particle
 *
 * The silhouette is built from 10 anatomical regions, each mapped to a
 * scroll phase. Particles per region are weighted by visual importance
 * (head + chest get more particles than feet).
 *
 * Generation is deterministic — uses a seeded RNG so the same particle
 * distribution renders on every reload. Important for SSR-vs-client
 * hydration consistency (though we render on client only, consistency
 * across sessions feels more polished).
 */

const TOTAL_PARTICLES = 12000;

/** Particle counts per region (sums to TOTAL_PARTICLES). */
const REGION_BUDGET: Record<number, number> = {
  0: 1400,  // Reasoning Core   — head
  1: 900,   // State Pulse      — chest reactor (dense, glowing)
  2: 700,   // Memory Spine     — vertebral column
  3: 600,   // Browser Optics   — visor / face
  4: 1100,  // Bridge Tools     — forearms + hands (both sides combined)
  5: 1000,  // Guard Shield     — pauldrons + chest plates
  6: 500,   // Output Channels  — neck + clavicle
  7: 900,   // Security Mesh    — pelvis
  8: 1100,  // Business Layer   — upper arms + sternum
  9: 3800,  // Command Centre   — legs + podium (largest visual block)
};

// Verify totals at module-init so future edits don't silently drift.
const sum = Object.values(REGION_BUDGET).reduce((a, b) => a + b, 0);
if (sum !== TOTAL_PARTICLES) {
  // Adjust the largest bucket so the total stays exact without throwing.
  REGION_BUDGET[9] += TOTAL_PARTICLES - sum;
}

/** Mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(0x0A515150);

/** Random point inside a sphere of given radius, centered at the origin. */
function pointInSphere(r: number, out: THREE.Vector3) {
  // Marsaglia: pick (u,v) in unit disc, scale to sphere.
  let u: number, v: number, s: number;
  do {
    u = rng() * 2 - 1;
    v = rng() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  const factor = 2 * Math.sqrt(1 - s);
  const x = u * factor;
  const y = v * factor;
  const z = 1 - 2 * s;
  // Use cube-root of a uniform to get uniform density (vs cube-of-uniform = surface-biased).
  const cr = Math.cbrt(rng()) * r;
  out.set(x * cr, y * cr, z * cr);
}

/** Random point inside an axis-aligned ellipsoid (rx, ry, rz). */
function pointInEllipsoid(rx: number, ry: number, rz: number, out: THREE.Vector3) {
  pointInSphere(1, out);
  out.x *= rx;
  out.y *= ry;
  out.z *= rz;
}

/** Random point inside a Y-axis-aligned cylinder (radius r, height h, y-centred). */
function pointInCylinder(r: number, h: number, out: THREE.Vector3) {
  const theta = rng() * Math.PI * 2;
  const cr = Math.sqrt(rng()) * r;
  out.set(Math.cos(theta) * cr, (rng() - 0.5) * h, Math.sin(theta) * cr);
}

/** Random point inside a torus (major R, minor r), in XZ plane. */
function pointInTorus(R: number, r: number, out: THREE.Vector3) {
  const theta = rng() * Math.PI * 2;
  const phi = rng() * Math.PI * 2;
  const cr = Math.sqrt(rng()) * r;
  out.set(
    (R + cr * Math.cos(phi)) * Math.cos(theta),
    cr * Math.sin(phi),
    (R + cr * Math.cos(phi)) * Math.sin(theta),
  );
}

/** Region samplers — given a Vector3 buffer, fill in a rest position
 *  for the i-th particle of that region. */
type Sampler = (i: number, count: number, out: THREE.Vector3) => void;

const tmp = new THREE.Vector3();

const SAMPLERS: Record<number, Sampler> = {
  // 0 — Reasoning Core: head ellipsoid + a few skull-cap extras
  0: (_i, _n, out) => {
    pointInEllipsoid(0.21, 0.24, 0.21, tmp);
    out.set(tmp.x, 1.42 + tmp.y, tmp.z);
  },

  // 1 — State Pulse: dense glowing chest core (small ellipsoid)
  1: (_i, _n, out) => {
    pointInEllipsoid(0.16, 0.13, 0.14, tmp);
    out.set(tmp.x, 0.55 + tmp.y, 0.16 + tmp.z);
  },

  // 2 — Memory Spine: tall narrow column behind the chest
  2: (_i, _n, out) => {
    pointInEllipsoid(0.07, 0.36, 0.07, tmp);
    out.set(tmp.x, 0.78 + tmp.y, -0.08 + tmp.z);
  },

  // 3 — Browser Optics: thin horizontal band across upper face
  3: (_i, _n, out) => {
    pointInEllipsoid(0.18, 0.04, 0.04, tmp);
    out.set(tmp.x, 1.43 + tmp.y, 0.16 + tmp.z);
  },

  // 4 — Bridge Tools: forearms + hands, both sides
  4: (i, n, out) => {
    const side = i < n / 2 ? -1 : 1;
    pointInEllipsoid(0.08, 0.28, 0.08, tmp);
    out.set(side * 0.4 + tmp.x, 0.0 + tmp.y, tmp.z);
  },

  // 5 — Guard Shield: pauldrons + chest armor wrap
  5: (i, n, out) => {
    // Mix pauldrons (60%) and chest plates (40%)
    if (i < n * 0.6) {
      const side = i < n * 0.3 ? -1 : 1;
      pointInEllipsoid(0.16, 0.13, 0.16, tmp);
      out.set(side * 0.32 + tmp.x, 0.88 + tmp.y, tmp.z);
    } else {
      pointInEllipsoid(0.2, 0.2, 0.04, tmp);
      out.set(tmp.x, 0.65 + tmp.y, 0.14 + tmp.z);
    }
  },

  // 6 — Output Channels: neck + clavicle yoke
  6: (i, n, out) => {
    if (i < n * 0.55) {
      pointInCylinder(0.09, 0.2, tmp);
      out.set(tmp.x, 1.18 + tmp.y, tmp.z);
    } else {
      pointInEllipsoid(0.26, 0.04, 0.08, tmp);
      out.set(tmp.x, 1.05 + tmp.y, tmp.z);
    }
  },

  // 7 — Security Mesh: pelvis girdle + hip sockets
  7: (i, n, out) => {
    if (i < n * 0.7) {
      pointInEllipsoid(0.24, 0.12, 0.16, tmp);
      out.set(tmp.x, -0.12 + tmp.y, tmp.z);
    } else {
      const side = (i % 2 === 0) ? -1 : 1;
      pointInEllipsoid(0.09, 0.13, 0.09, tmp);
      out.set(side * 0.18 + tmp.x, -0.34 + tmp.y, tmp.z);
    }
  },

  // 8 — Business Layer: upper arms + sternum panel
  8: (i, n, out) => {
    if (i < n * 0.7) {
      const side = i < n * 0.35 ? -1 : 1;
      pointInEllipsoid(0.09, 0.22, 0.09, tmp);
      out.set(side * 0.32 + tmp.x, 0.55 + tmp.y, tmp.z);
    } else {
      pointInEllipsoid(0.11, 0.2, 0.03, tmp);
      out.set(tmp.x, 0.6 + tmp.y, 0.18 + tmp.z);
    }
  },

  // 9 — Command Centre: legs (60%) + podium (40%)
  9: (i, n, out) => {
    if (i < n * 0.6) {
      const side = i < n * 0.3 ? -1 : 1;
      pointInEllipsoid(0.1, 0.45, 0.1, tmp);
      out.set(side * 0.16 + tmp.x, -0.85 + tmp.y, tmp.z);
    } else {
      // Podium — flat ellipsoid disc + ring particles
      if (rng() > 0.5) {
        pointInEllipsoid(0.62, 0.04, 0.62, tmp);
        out.set(tmp.x, -1.72 + tmp.y, tmp.z);
      } else {
        pointInTorus(0.56, 0.02, tmp);
        out.set(tmp.x, -1.68 + tmp.y, tmp.z);
      }
    }
  },
};

export type ParticleData = {
  rest: Float32Array;
  scatter: Float32Array;
  phaseSeed: Float32Array;
  count: number;
};

/** Build the full particle dataset. Pure function — call once at module mount. */
export function buildParticleData(): ParticleData {
  const count = TOTAL_PARTICLES;
  const rest = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const phaseSeed = new Float32Array(count * 3);

  const out = new THREE.Vector3();
  let i = 0;
  for (let phase = 0; phase < 10; phase++) {
    const n = REGION_BUDGET[phase];
    const sampler = SAMPLERS[phase];
    for (let k = 0; k < n; k++, i++) {
      // REST position — anatomical home
      sampler(k, n, out);
      rest[i * 3] = out.x;
      rest[i * 3 + 1] = out.y;
      rest[i * 3 + 2] = out.z;

      // SCATTER position — pre-install origin (point on a large sphere
      // around the figure, biased toward the part's own quadrant so the
      // assembly reads as "particles flying in from the void" rather
      // than "all from one direction").
      const homeRadius = 2.0 + rng() * 1.5;
      const homeDir = new THREE.Vector3(out.x, out.y, out.z).normalize();
      // Blend home direction with random sphere direction (60% home, 40% random)
      const randomDir = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize();
      const blendedDir = homeDir.multiplyScalar(0.6).add(randomDir.multiplyScalar(0.4)).normalize();
      scatter[i * 3] = blendedDir.x * homeRadius;
      scatter[i * 3 + 1] = blendedDir.y * homeRadius;
      scatter[i * 3 + 2] = blendedDir.z * homeRadius;

      // phaseSeed: x = phase, y = uniform seed [0,1], z = drift seed [0,1]
      phaseSeed[i * 3] = phase;
      phaseSeed[i * 3 + 1] = rng();
      phaseSeed[i * 3 + 2] = rng();
    }
  }

  return { rest, scatter, phaseSeed, count };
}
