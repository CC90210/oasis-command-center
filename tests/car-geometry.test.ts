/**
 * Geometry guard for the marketing car stage.
 *
 * Two defects shipped to production here, and neither was visible in code
 * review or in a still screenshot:
 *
 *  1. Contour strips were placed against `station.w` — the section's
 *     BOUNDING half-width, which the surface only reaches at its vertical
 *     centre. The shoulder run ended up INSIDE the bodywork at 16 of 16
 *     stations, z-fighting along its entire length and strobing as the car
 *     turned. The sill run had the same error inverted and floated up to
 *     13.9cm off the flank.
 *  2. Roof rails and side skirts were placed at hardcoded world
 *     coordinates, so they sat 5.5cm inside bravo's roof and outboard of
 *     atlas's sill respectively.
 *
 * Both are silent: geometry that intersects still renders, it just renders
 * wrong, intermittently, per frame. So this asserts the invariant directly —
 * every surface-mounted part must sit PROUD of the skin on every harness.
 *
 * It calls the real exported functions rather than restating the maths. An
 * earlier version of this check reimplemented the superellipse inverse in a
 * second language, which would have mirrored any bug in the original and
 * passed regardless.
 */
import { strict as assert } from "node:assert";
import {
  CAR_SPECS,
  MOUNT,
  flankPoint,
  nearestStation,
  runHeight,
  surfaceHalfWidth,
  type Station,
} from "../lib/marketing/car-geometry";

let checks = 0;
const fail = (msg: string) => {
  throw new Error(msg);
};

/**
 * Is a point INSIDE the section?
 *
 * The sampled distance below is unsigned, so on its own it cannot tell a
 * part sitting 2cm proud of the flank from one buried 2cm into it — they
 * are both "2cm from the surface". An earlier version of this file used
 * distance alone and passed happily when the mount offset was inverted,
 * which is the exact failure it exists to catch.
 *
 * The superellipse has an exact implicit form, so the side is not a
 * judgement call: |z/w|^(2/n) + |dy/h|^(2/n) is 1 on the curve, below 1
 * inside, above 1 outside.
 */
function isInside(s: Station, y: number, z: number): boolean {
  const n = 2 / s.squareness;
  const a = Math.pow(Math.abs(z / s.w), 2 / n);
  const b = Math.pow(Math.abs((y - s.y) / s.h), 2 / n);
  return a + b < 1;
}

/**
 * Shortest distance from a point to a station's cross-section curve.
 * Sampled densely — the curve has no closed-form distance.
 */
function distanceToSurface(s: Station, y: number, z: number): number {
  const n = 2 / s.squareness;
  let best = Infinity;
  const SAMPLES = 4000;
  for (let i = 0; i < SAMPLES; i++) {
    const t = (i / SAMPLES) * Math.PI * 2;
    const c = Math.cos(t);
    const si = Math.sin(t);
    const sz = s.w * Math.sign(c) * Math.pow(Math.abs(c), n);
    const sy = s.y + s.h * Math.sign(si) * Math.pow(Math.abs(si), n);
    best = Math.min(best, Math.hypot(y - sy, z - sz));
  }
  return best;
}

// ── surfaceHalfWidth must be the exact inverse of the section curve ──────
// If this is wrong everything mounted on the body is wrong, so it is
// checked against the forward parameterisation rather than trusted.
for (const [name, spec] of Object.entries(CAR_SPECS)) {
  for (const s of [...spec.body, ...spec.cabin]) {
    const n = 2 / s.squareness;
    for (let i = 1; i < 40; i++) {
      const t = (i / 40) * Math.PI * 0.5; // first quadrant covers it by symmetry
      const c = Math.cos(t);
      const si = Math.sin(t);
      const z = s.w * Math.pow(c, n);
      const y = s.y + s.h * Math.pow(si, n);
      const got = surfaceHalfWidth(s, y);
      if (Math.abs(got - z) > 1e-6) {
        fail(
          `${name}: surfaceHalfWidth is not the inverse at y=${y.toFixed(4)} ` +
            `-> got ${got.toFixed(6)}, curve is at ${z.toFixed(6)}`,
        );
      }
      checks++;
    }
  }
}

// Above and below the section there is no surface.
assert.equal(surfaceHalfWidth({ x: 0, y: 1, h: 0.4, w: 1, squareness: 4 }, 99), 0);
assert.equal(surfaceHalfWidth({ x: 0, y: 1, h: 0.4, w: 1, squareness: 4 }, -99), 0);

// ── Every mounted part must clear the skin, on every harness ─────────────
type Mount = { label: string; stations: Station[]; heightOf: (s: Station) => number; radius: number; gap: number };

for (const [name, spec] of Object.entries(CAR_SPECS)) {
  const mounts: Mount[] = [
    {
      label: "neon-shoulder",
      stations: spec.body,
      heightOf: (s) => runHeight(s, MOUNT.shoulderFrac),
      radius: MOUNT.stripRadius,
      gap: MOUNT.stripGap,
    },
    {
      label: "neon-sill",
      stations: spec.body,
      heightOf: (s) => runHeight(s, MOUNT.sillFrac),
      radius: MOUNT.stripRadius,
      gap: MOUNT.stripGap,
    },
  ];

  if (spec.features.rails) {
    mounts.push({
      label: "rails",
      stations: spec.cabin.filter((s) => s.h > 0.1),
      heightOf: (s) => s.y + s.h * MOUNT.railHeightFrac,
      radius: MOUNT.railThickness / 2,
      gap: MOUNT.gap,
    });
  }
  if (spec.features.skirts) {
    mounts.push({
      label: "skirts",
      stations: spec.body.filter((s) => Math.abs(s.x) < 1.7),
      heightOf: (s) => s.y + s.h * MOUNT.skirtHeightFrac,
      radius: MOUNT.skirtThickness / 2,
      gap: MOUNT.gap,
    });
  }

  for (const m of mounts) {
    assert.ok(m.stations.length > 1, `${name}/${m.label}: needs 2+ stations to sweep`);
    for (const s of m.stations) {
      for (const side of [-1, 1]) {
        const [, py, pz] = flankPoint(s, m.heightOf(s), side, m.radius + m.gap);
        // SIGNED, and measured at the part's inner face rather than its
        // centreline. Negative means the tube's near side is in the paint.
        const signed = isInside(s, py, pz) ? -distanceToSurface(s, py, pz) : distanceToSurface(s, py, pz);
        const clearance = signed - m.radius;
        if (clearance <= 0) {
          fail(
            `${name}/${m.label} at x=${s.x}: part is ${(-clearance * 100).toFixed(2)}cm ` +
              `INSIDE the bodywork — this z-fights and strobes per frame`,
          );
        }
        checks++;
      }
    }
  }
}

// ── nearestStation ──────────────────────────────────────────────────────
{
  const b = CAR_SPECS.bravo.body;
  assert.equal(nearestStation(b, -99).x, Math.min(...b.map((s) => s.x)));
  assert.equal(nearestStation(b, 99).x, Math.max(...b.map((s) => s.x)));
  checks += 2;
}

// ── Guard the guard ─────────────────────────────────────────────────────
// A part placed the OLD way — against the bounding half-width — must be
// caught. Without this the suite could pass while asserting nothing.
{
  const s = CAR_SPECS.bravo.body[3];
  const y = runHeight(s, MOUNT.shoulderFrac);
  const z = s.w * 0.97; // how the strips used to be placed
  assert.ok(
    isInside(s, y, z),
    "regression check is inert: the old bounding-box placement no longer " +
      "registers as inside the body, so this suite would not have caught it",
  );
  // And the inverse-offset failure, which an unsigned check missed: a part
  // pushed INWARD is deep inside the body yet a plain distance reads it as
  // comfortably clear.
  const [, iy, iz] = flankPoint(s, y, 1, -0.05);
  assert.ok(
    isInside(s, iy, iz),
    "an inverted mount offset is not detected as buried — the clearance " +
      "assertion above is measuring proximity, not side",
  );
  checks += 2;
}

console.log(`car-geometry: ok (${checks} assertions)`);
