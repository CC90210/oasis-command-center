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
  BODY_SHOTS,
  CAMERA_FOV,
  CAR_SPECS,
  DIVE_OFFSET,
  LEGACY_DIVE_OFFSET,
  LEGACY_FOV,
  LOFT_RINGS,
  MOUNT,
  flankPoint,
  framedHeight,
  nearestStation,
  resampleStations,
  runHeight,
  surfaceHalfWidth,
  wheelTrack,
  type Station,
} from "../lib/marketing/car-geometry";

let checks = 0;
let worstClearance = { cm: Infinity, where: "" };
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
type Mount = {
  label: string;
  stations: Station[];
  heightOf: (s: Station) => number;
  radius: number;
  gap: number;
  /** Rails mount on the greenhouse loft, everything else on the body. */
  onCabin?: boolean;
};

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
      onCabin: true,
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

  // The rendered surface is the RESAMPLED loft, not the authored stations.
  // Catmull-Rom passes through its control points but bulges between them,
  // so a part can clear every authored station and still be swallowed by
  // the surface in between. Checking only the authored stations would
  // verify a shape that never reaches the screen.
  const bodyRings = resampleStations(spec.body);
  const cabinRings = resampleStations(spec.cabin);
  assert.equal(bodyRings.length, LOFT_RINGS);

  for (const m of mounts) {
    assert.ok(m.stations.length > 1, `${name}/${m.label}: needs 2+ stations to sweep`);

    // Which resampled rings this run actually spans.
    const minX = Math.min(...m.stations.map((s) => s.x));
    const maxX = Math.max(...m.stations.map((s) => s.x));
    const rings = (m.onCabin ? cabinRings : bodyRings).filter(
      (r) => r.x >= minX && r.x <= maxX,
    );
    assert.ok(rings.length > 2, `${name}/${m.label}: resampled span is too short to test`);

    for (const s of rings) {
      for (const side of [-1, 1]) {
        const [, py, pz] = flankPoint(s, m.heightOf(s), side, m.radius + m.gap);
        // SIGNED, and measured at the part's inner face rather than its
        // centreline. Negative means the tube's near side is in the paint.
        const signed = isInside(s, py, pz) ? -distanceToSurface(s, py, pz) : distanceToSurface(s, py, pz);
        const clearance = signed - m.radius;
        if (clearance < worstClearance.cm) {
          worstClearance = { cm: clearance, where: `${name}/${m.label}` };
        }
        if (clearance <= 0) {
          fail(
            `${name}/${m.label} at x=${s.x.toFixed(3)}: part is ${(-clearance * 100).toFixed(2)}cm ` +
              `INSIDE the rendered bodywork — this z-fights and strobes per frame`,
          );
        }
        checks++;
      }
    }
  }
}

// ── Camera framing survived the lens change ─────────────────────────────
// Going from a 38-degree lens to a 14-degree one only preserves the shot if
// every camera distance is scaled by tan(38/2)/tan(14/2). That factor is
// invisible in the numbers themselves — the positions just look like
// arbitrary coordinates — so nothing stops a future edit changing the FOV
// and silently reframing every shot on the page. This is also the one part
// of the stage that cannot be verified by screenshot: the engine dive lasts
// 1.6s, which is shorter than a single browser-automation round trip.
{
  // Compare against the PINNED original offset. An earlier version of this
  // derived the expected distance from CAMERA_FOV, which made the whole
  // assertion reduce to `2·d·tan(fov/2) === 2·d·tan(fov/2)` — true at every
  // FOV, catching nothing. Both sides must come from independent values or
  // the check is decorative.
  const now = framedHeight(Math.hypot(...DIVE_OFFSET), CAMERA_FOV);
  const before = framedHeight(Math.hypot(...LEGACY_DIVE_OFFSET), LEGACY_FOV);
  assert.ok(
    Math.abs(now - before) < 0.01,
    `engine dive reframed: at ${CAMERA_FOV}deg it shows ${now.toFixed(3)} units ` +
      `of frame height, but was tuned to show ${before.toFixed(3)}. ` +
      `Change CAMERA_FOV and DIVE_OFFSET must be rescaled by ` +
      `tan(${LEGACY_FOV}/2)/tan(${CAMERA_FOV}/2).`,
  );

  // Hero shots must frame the actual car: tall enough to hold it with
  // headroom, not so far out that it is lost in the frame. Checked against
  // the car's real measured height rather than against the FOV, so this
  // cannot collapse into an identity the way the dive check did.
  for (const [body, shot] of Object.entries(BODY_SHOTS)) {
    const spec = CAR_SPECS[body];
    const carTop = Math.max(...[...spec.body, ...spec.cabin].map((s) => s.y + s.h));
    const d = Math.hypot(
      shot.pos[0] - shot.at[0],
      shot.pos[1] - shot.at[1],
      shot.pos[2] - shot.at[2],
    );
    const frame = framedHeight(d, CAMERA_FOV);
    assert.ok(
      frame > carTop * 1.6,
      `${body}: frame height ${frame.toFixed(2)} is too tight for a car ` +
        `${carTop.toFixed(2)} tall — the roof would be cropped`,
    );
    assert.ok(
      frame < carTop * 6,
      `${body}: frame height ${frame.toFixed(2)} leaves a ${carTop.toFixed(2)}-tall ` +
        `car as a speck in the middle of the canvas`,
    );
    assert.ok(
      frame > now * 2,
      `${body}: hero shot is not meaningfully wider than the engine dive — ` +
        `the dive would read as a jump cut, not a push in`,
    );
    // And every hero shot must sit near the beltline, not above the roof.
    // Shooting down at a car flattens it into a floorplan.
    assert.ok(
      shot.pos[1] < 1.6,
      `${body}: camera is at y=${shot.pos[1]}, above the car's shoulder`,
    );
    checks += 4;
  }
  checks++;
}

// ── Wheels must clear the bodywork, and the fender must cover them ──────
// Tyres were previously planted against the car's widest point anywhere
// along its length, so on every harness the outer face sat proud of the
// widest panel while the flank at wheel height was much narrower — the
// tyre passed straight through the bodywork. There is no such thing as a
// subtle version of that defect, but it is invisible from most angles.
for (const [name, spec] of Object.entries(CAR_SPECS)) {
  for (const axle of spec.axles) {
    const { flankAtHub, hubZ, outer, archRadius } = wheelTrack(spec, axle);

    // The wheel must not be swallowed by the body.
    assert.ok(
      outer >= flankAtHub,
      `${name} axle x=${axle.x}: tyre outer face at ${outer.toFixed(3)} is ` +
        `inboard of the flank at ${flankAtHub.toFixed(3)} — wheel is inside the car`,
    );

    // The fender must be larger than the tyre or it cuts through the tread.
    assert.ok(
      archRadius > axle.radius,
      `${name} axle x=${axle.x}: fender radius ${archRadius.toFixed(3)} does not ` +
        `clear tyre radius ${axle.radius.toFixed(3)}`,
    );

    // The fender rides in the tyre's own plane, so it must actually span it.
    assert.ok(
      Math.abs(hubZ - (outer - axle.width / 2)) < 1e-9,
      `${name} axle x=${axle.x}: hub is not centred under its own fender`,
    );

    // And the track must stay plausible — a wheel a metre off the flank
    // technically "clears" but is not a car.
    assert.ok(
      outer - flankAtHub < 0.45,
      `${name} axle x=${axle.x}: track stands ${((outer - flankAtHub) * 100).toFixed(1)}cm ` +
        `off the flank — the wheel is detached from the body`,
    );
    checks += 4;
  }
}

// The widebody package must actually widen the track, or it is a label.
{
  const wide = Object.values(CAR_SPECS).filter((s) => s.features.wideBody);
  assert.ok(wide.length > 0, "no body carries the widebody package");
  for (const spec of wide) {
    const got = wheelTrack(spec, spec.axles[0]);
    const narrowed = wheelTrack(
      { ...spec, features: { ...spec.features, wideBody: false } },
      spec.axles[0],
    );
    assert.ok(
      got.outer > narrowed.outer,
      "widebody package does not widen the track",
    );
    checks++;
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

console.log(
  `car-geometry: ok (${checks} assertions, ` +
    `tightest mount ${(worstClearance.cm * 100).toFixed(2)}cm proud ` +
    `at ${worstClearance.where})`,
);
