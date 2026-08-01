/**
 * Procedural supercar geometry.
 *
 * WHY PROCEDURAL. A real car needs a GLTF, and a GLTF needs an artist, a
 * licence, and a megabyte of download. Hand-authoring one is not on the
 * table either. What IS on the table is lofting a body from cross-sections
 * — the way a car is actually surfaced — which gives real curvature
 * (tapered nose, wide rear haunches, low cabin) from about forty numbers
 * per body and no assets at all.
 *
 * Each body is a list of STATIONS along the length of the car. A station
 * is one cross-section: where it sits, how tall it is, how wide it is, and
 * how square its corners are. The loft builder walks consecutive stations
 * and stitches them into a closed surface.
 *
 * Superellipse corners are what stop this reading as a tube: `squareness`
 * near 2 gives a circular section, near 6 gives an almost rectangular one.
 * Sills and rockers want square, the roof wants round, and the transition
 * between them is most of what makes a shape look automotive.
 */

export type Station = {
  /** Position along the car. Negative is the rear, positive the nose. */
  x: number;
  /** Height of the section's centre above the ground plane. */
  y: number;
  /** Half-height. */
  h: number;
  /** Half-width. */
  w: number;
  /** Superellipse exponent: 2 = ellipse, 6 = nearly rectangular. */
  squareness: number;
};

export type CarSpec = {
  body: Station[];
  /** Greenhouse — a second, smaller loft sitting on the body. */
  cabin: Station[];
  /** Wheel centres along x; the pair is mirrored across z. */
  axles: { x: number; radius: number; width: number }[];
  /** Where the engine sits, for the camera to dive at. */
  engineBay: [number, number, number];
  /**
   * Bodywork that is NOT shared. Selecting a body has to change more than
   * the silhouette or it reads as one car being stretched: each of these
   * adds or removes real parts.
   */
  features: {
    /** Rear wing on struts. The coupe's signature. */
    wing?: boolean;
    /** Roof rails. Says "carries things" at a glance. */
    rails?: boolean;
    /** Side skirts along the sill. Reads as heavy and planted. */
    skirts?: boolean;
    /** Exposed roll structure, for the not-yet-built slot. */
    exposedFrame?: boolean;
    /** Active aero: a two-element rear spoiler that stands off the deck. */
    activeAero?: boolean;
    /** Widebody: flared arches and a wider track. Performance package. */
    wideBody?: boolean;
    /** Brightwork trim along the shoulder. Grand-tourer signature. */
    gtTrim?: boolean;
  };
  /**
   * Wheel treatment. Spoke count and rim depth differ per body so the cars
   * are told apart at the corners as well as at the roofline.
   */
  wheel: { spokes: number; rimDepth: number; tint: number };
  /**
   * Brightwork colour for this body's trim parts. Bravo and Maven read as
   * cool machined aluminium; Atlas is warm titanium/gold, which is the one
   * thing that separates a luxury GT from a sports car at a glance.
   */
  accent: number;
};

/**
 * Arch clearance around a wheel.
 *
 * Tyres used to be planted at `maxHalfWidth - width*0.35`, i.e. their outer
 * face sat PROUD of the widest panel on the car — and since the body is far
 * narrower at wheel-centre height than at its widest point, the tyre cut
 * straight through the flank. A car with no arch over its wheels reads as a
 * bar of soap with tyres glued to it.
 */
export const ARCH = {
  /** Radial gap between tyre and fender lip. */
  gap: 0.05,
  /** Thickness of the fender lip itself. */
  lip: 0.05,
  /**
   * How far the widebody package pushes the track out per side.
   *
   * Small on purpose. The flare lives in the bodywork (see MAVEN's haunch
   * stations); this is only the extra track that makes the wheels fill
   * those arches. Pushing the wheels out without widening the body is what
   * detaches them from it.
   */
  wideTrack: 0.04,
} as const;

/** BRAVO — long-roof shooting brake. Carries load, hence the volume. */
const BRAVO: CarSpec = {
  body: [
    { x: -2.30, y: 0.62, h: 0.30, w: 0.72, squareness: 4.4 },
    { x: -1.95, y: 0.60, h: 0.42, w: 0.94, squareness: 4.0 },
    { x: -1.30, y: 0.58, h: 0.46, w: 1.02, squareness: 3.6 },
    { x: -0.45, y: 0.56, h: 0.46, w: 1.03, squareness: 3.4 },
    { x: 0.45, y: 0.55, h: 0.45, w: 1.02, squareness: 3.4 },
    { x: 1.25, y: 0.54, h: 0.42, w: 0.98, squareness: 3.6 },
    { x: 1.90, y: 0.52, h: 0.34, w: 0.86, squareness: 4.0 },
    { x: 2.28, y: 0.50, h: 0.24, w: 0.66, squareness: 4.6 },
  ],
  cabin: [
    { x: -1.55, y: 1.06, h: 0.16, w: 0.80, squareness: 3.0 },
    { x: -0.85, y: 1.16, h: 0.26, w: 0.86, squareness: 2.8 },
    { x: 0.10, y: 1.18, h: 0.28, w: 0.86, squareness: 2.8 },
    { x: 0.85, y: 1.10, h: 0.22, w: 0.80, squareness: 3.0 },
    { x: 1.30, y: 0.94, h: 0.08, w: 0.70, squareness: 3.4 },
  ],
  axles: [
    { x: -1.42, radius: 0.46, width: 0.30 },
    { x: 1.42, radius: 0.46, width: 0.28 },
  ],
  engineBay: [1.62, 0.72, 0],
  // Precision-engineering coupe: roof rails for the long-roof utility, plus
  // a two-element active-aero spoiler. Machined-aluminium brightwork.
  features: { rails: true, activeAero: true },
  wheel: { spokes: 6, rimDepth: 0.9, tint: 0x00d4ff },
  accent: 0xc8d2dc,
};

/** ATLAS — long, low, heavy. A vault on wheels. */
const ATLAS: CarSpec = {
  body: [
    { x: -2.40, y: 0.56, h: 0.26, w: 0.74, squareness: 5.0 },
    { x: -2.00, y: 0.54, h: 0.38, w: 0.98, squareness: 4.6 },
    { x: -1.25, y: 0.52, h: 0.40, w: 1.06, squareness: 4.2 },
    { x: -0.35, y: 0.50, h: 0.40, w: 1.07, squareness: 4.0 },
    { x: 0.55, y: 0.49, h: 0.39, w: 1.05, squareness: 4.0 },
    { x: 1.35, y: 0.48, h: 0.36, w: 1.00, squareness: 4.2 },
    { x: 2.05, y: 0.46, h: 0.28, w: 0.88, squareness: 4.6 },
    { x: 2.42, y: 0.44, h: 0.20, w: 0.68, squareness: 5.0 },
  ],
  cabin: [
    { x: -1.30, y: 0.94, h: 0.14, w: 0.82, squareness: 3.4 },
    { x: -0.70, y: 1.02, h: 0.22, w: 0.88, squareness: 3.2 },
    { x: 0.15, y: 1.03, h: 0.23, w: 0.88, squareness: 3.2 },
    { x: 0.90, y: 0.96, h: 0.17, w: 0.82, squareness: 3.4 },
    { x: 1.40, y: 0.84, h: 0.06, w: 0.72, squareness: 3.8 },
  ],
  axles: [
    { x: -1.50, radius: 0.44, width: 0.30 },
    { x: 1.50, radius: 0.44, width: 0.30 },
  ],
  engineBay: [1.70, 0.66, 0],
  // Luxury grand tourer: skirts plus warm titanium/gold brightwork along
  // the shoulder. The accent colour is what separates a GT from a sports
  // car before you read a single label.
  features: { skirts: true, gtTrim: true },
  wheel: { spokes: 10, rimDepth: 0.62, tint: 0xd8c088 },
  accent: 0xd4b169,
};

/** MAVEN — mid-engine coupe. Low nose, big hips, cab-forward. */
const MAVEN: CarSpec = {
  body: [
    // WIDEBODY. The haunches over both axles are in the station data
    // rather than applied at render time, so every consumer — the loft,
    // the neon runs, the skirts, and the wheel track — sees the same
    // shape. Flaring only the wheels (pushing the track out and leaving
    // the bodywork alone) is what made this read as an open-wheel racer
    // with the tyres floating off a narrow tub.
    { x: -2.20, y: 0.50, h: 0.24, w: 0.78, squareness: 4.6 },
    { x: -1.80, y: 0.48, h: 0.34, w: 1.10, squareness: 4.0 },
    { x: -1.30, y: 0.47, h: 0.37, w: 1.22, squareness: 3.7 }, // rear haunch
    { x: -0.75, y: 0.46, h: 0.38, w: 1.14, squareness: 3.5 },
    { x: -0.20, y: 0.44, h: 0.38, w: 1.10, squareness: 3.4 },
    { x: 0.60, y: 0.42, h: 0.34, w: 1.08, squareness: 3.4 },
    { x: 1.40, y: 0.39, h: 0.30, w: 1.14, squareness: 3.6 }, // front haunch
    { x: 1.95, y: 0.34, h: 0.20, w: 0.80, squareness: 4.2 },
    { x: 2.25, y: 0.32, h: 0.13, w: 0.58, squareness: 4.8 },
  ],
  cabin: [
    { x: -1.15, y: 0.84, h: 0.10, w: 0.80, squareness: 3.0 },
    { x: -0.60, y: 0.94, h: 0.20, w: 0.84, squareness: 2.8 },
    { x: 0.05, y: 0.92, h: 0.20, w: 0.82, squareness: 2.8 },
    { x: 0.70, y: 0.78, h: 0.10, w: 0.74, squareness: 3.2 },
    { x: 1.05, y: 0.66, h: 0.03, w: 0.62, squareness: 3.6 },
  ],
  axles: [
    { x: -1.38, radius: 0.44, width: 0.34 },
    { x: 1.40, radius: 0.42, width: 0.28 },
  ],
  /** Mid-engine: the bay sits behind the cabin, not under a front hood. */
  engineBay: [-1.05, 0.62, 0],
  // Widebody performance package: flared arches, wider track, big wing.
  features: { wing: true, wideBody: true },
  wheel: { spokes: 5, rimDepth: 1.15, tint: 0x00d4ff },
  accent: 0xb9c4cf,
};

/** CUSTOM — the shape that doesn't exist yet. Deliberately generic. */
const CUSTOM: CarSpec = {
  body: [
    { x: -2.30, y: 0.56, h: 0.28, w: 0.74, squareness: 4.6 },
    { x: -1.90, y: 0.55, h: 0.38, w: 0.98, squareness: 4.2 },
    { x: -1.20, y: 0.54, h: 0.42, w: 1.05, squareness: 3.8 },
    { x: -0.30, y: 0.52, h: 0.42, w: 1.06, squareness: 3.6 },
    { x: 0.55, y: 0.51, h: 0.40, w: 1.03, squareness: 3.6 },
    { x: 1.30, y: 0.50, h: 0.36, w: 0.97, squareness: 3.8 },
    { x: 1.95, y: 0.48, h: 0.28, w: 0.84, squareness: 4.2 },
    { x: 2.30, y: 0.46, h: 0.20, w: 0.64, squareness: 4.8 },
  ],
  cabin: [
    { x: -1.35, y: 0.98, h: 0.14, w: 0.80, squareness: 3.2 },
    { x: -0.75, y: 1.06, h: 0.22, w: 0.86, squareness: 3.0 },
    { x: 0.10, y: 1.06, h: 0.23, w: 0.86, squareness: 3.0 },
    { x: 0.85, y: 0.98, h: 0.16, w: 0.79, squareness: 3.2 },
    { x: 1.30, y: 0.86, h: 0.05, w: 0.70, squareness: 3.6 },
  ],
  axles: [
    { x: -1.45, radius: 0.45, width: 0.30 },
    { x: 1.45, radius: 0.45, width: 0.30 },
  ],
  engineBay: [1.65, 0.70, 0],
  // Modular skeleton: the shape that doesn't exist yet, so it shows its
  // structure rather than its bodywork.
  features: { exposedFrame: true },
  wheel: { spokes: 8, rimDepth: 0.8, tint: 0x9ca0a8 },
  accent: 0x9ca0a8,
};

/**
 * Where the exposed engine hardware actually sits.
 *
 * `engineBay` stores the height an engine would occupy INSIDE the body.
 * The hardware is mounted proud of the deck instead, so it can be seen —
 * and three separate things need to agree on where that is: the core
 * geometry, the coloured fill light, and the camera's dive target. When
 * only the geometry knew, the light pooled inside the bodywork under the
 * core and the camera flew to a point below the parts it was meant to be
 * showing you. One function, three callers.
 */
/** How many rings the body is lofted from after resampling. */
export const LOFT_RINGS = 44;

/** Catmull-Rom through a scalar series, clamped at both ends. */
function crSpline(v: number[], u: number): number {
  const n = v.length - 1;
  const f = Math.min(Math.max(u, 0), 1) * n;
  const i = Math.min(Math.floor(f), n - 1);
  const t = f - i;
  const p0 = v[Math.max(i - 1, 0)];
  const p1 = v[i];
  const p2 = v[i + 1];
  const p3 = v[Math.min(i + 2, n)];
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  );
}

/**
 * The sections the body is ACTUALLY lofted from.
 *
 * Eight hand-authored stations across a 4.7-unit car is a section every
 * 65cm, and no shading model makes 65cm flats look like a curved panel, so
 * the loft resamples them up before building geometry.
 *
 * This lives here rather than inside the renderer because the rendered
 * surface is what mounted parts have to clear, and a clearance measured
 * against the eight authored stations is not the same claim: Catmull-Rom
 * interpolates between control points and can bulge outward past them, so
 * a strip that clears every authored station can still be swallowed by the
 * surface in between. The geometry test checks against these rings.
 */
export function resampleStations(
  stations: Station[],
  count = LOFT_RINGS,
): Station[] {
  const xs = stations.map((s) => s.x);
  const ys = stations.map((s) => s.y);
  const hs = stations.map((s) => s.h);
  const ws = stations.map((s) => s.w);
  const qs = stations.map((s) => s.squareness);

  const out: Station[] = [];
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    out.push({
      x: crSpline(xs, u),
      y: crSpline(ys, u),
      h: crSpline(hs, u),
      w: crSpline(ws, u),
      squareness: crSpline(qs, u),
    });
  }
  return out;
}

/**
 * Where surface-mounted hardware sits.
 *
 * These live here, next to the surface maths, rather than in the renderer —
 * they ARE geometry, and keeping them here is what lets the geometry test
 * exercise the real placement rather than a copy of it. Every one of these
 * numbers was a magic literal buried in the renderer at some point, and
 * every one of them was wrong: the strips were placed against the bounding
 * half-width and ended up inside the bodywork, the rails were placed at a
 * fixed world height and ended up above the roof.
 *
 * `gap` is deliberately generous. The rendered surface is a spline
 * resample of these stations, so it passes through them but interpolates
 * between them — a hairline clearance measured AT a station is not a real
 * clearance at the part's true position.
 */
export const MOUNT = {
  stripRadius: 0.017,
  stripGap: 0.004,
  gap: 0.012,
  railThickness: 0.075,
  skirtThickness: 0.09,
  /** Height up the section, 0 = bottom, 1 = top. */
  shoulderFrac: 0.72,
  sillFrac: 0.12,
  /** Offsets from a section's centre, as a fraction of its half-height. */
  railHeightFrac: 0.8,
  skirtHeightFrac: -0.55,
} as const;

/** Absolute height of a contour run on a section, from a 0..1 fraction. */
export function runHeight(s: Station, frac: number): number {
  return s.y - s.h + s.h * 2 * frac;
}

/** The station closest to a given position along the car. */
export function nearestStation(stations: Station[], x: number): Station {
  return stations.reduce((best, st) =>
    Math.abs(st.x - x) < Math.abs(best.x - x) ? st : best,
  );
}

export function engineAnchor(spec: CarSpec): [number, number, number] {
  const [bx, , bz] = spec.engineBay;
  const nearest = nearestStation(spec.body, bx);
  return [bx, nearest.y + nearest.h - 0.04, bz];
}

/**
 * Half-width of the actual body SURFACE at a given height on a station.
 *
 * This is the inverse of the superellipse that `sectionPoints` sweeps, and
 * its absence was the single most expensive bug in the stage.
 *
 * Anything mounted on the flank — the neon runs, the sill strip, the roof
 * rails, the light bar — needs to know where the skin is at that height.
 * Without this they were placed against `station.w`, which is the section's
 * BOUNDING half-width: the widest the body ever gets, reached only at the
 * vertical centre of the section. Everywhere above or below that line the
 * real surface is narrower, and by a margin that varies with `squareness`.
 *
 * Measured consequence: the shoulder strip sat INSIDE the bodywork at all
 * 16 stations across all four harnesses (up to 2.1cm deep against a tube of
 * 1.7cm radius), so it z-fought along its entire length and strobed as the
 * car turned. The sill strip had the opposite error and floated up to
 * 13.9cm off the flank. The signature element of the whole design was
 * broken in both directions at once, for one missing function.
 *
 * @param y absolute world height, same space as `Station.y`
 * @returns half-width at that height, or 0 above/below the section
 */
export function surfaceHalfWidth(s: Station, y: number): number {
  const n = 2 / s.squareness;
  const dy = (y - s.y) / s.h;
  if (Math.abs(dy) >= 1) return 0;
  // y = s.y + h·sign(sin)|sin|^n  ->  |sin| = |dy|^(1/n)
  const sinT = Math.pow(Math.abs(dy), 1 / n);
  const cosT = Math.sqrt(Math.max(0, 1 - sinT * sinT));
  return s.w * Math.pow(cosT, n);
}

/**
 * A point sitting `offset` proud of the body surface, on one flank.
 *
 * Offsetting straight out in z is only right where the flank is vertical.
 * At the shoulder the surface has already begun to roll over, so a pure-z
 * offset re-buries the part on its upper side — which is exactly how the
 * shoulder strip ended up grazing even where the half-width was correct.
 * The normal is taken numerically from the superellipse, which is cheap
 * (three evaluations) and cannot drift out of sync with the curve itself
 * the way a hand-derived analytic normal would.
 *
 * @param side -1 or 1, which flank
 * @param offset distance proud of the skin; use tube radius + a hair
 */
export function flankPoint(
  s: Station,
  y: number,
  side: number,
  offset: number,
): [number, number, number] {
  const eps = 1e-3;
  const z0 = surfaceHalfWidth(s, y);
  const dzdy =
    (surfaceHalfWidth(s, y + eps) - surfaceHalfWidth(s, y - eps)) / (2 * eps);
  // Outward normal of the curve z(y), normalised.
  const len = Math.hypot(1, dzdy) || 1;
  const ny = -dzdy / len;
  const nz = 1 / len;
  return [s.x, y + ny * offset, side * (z0 + nz * offset)];
}

export const CAR_SPECS: Record<string, CarSpec> = {
  bravo: BRAVO,
  atlas: ATLAS,
  maven: MAVEN,
  custom: CUSTOM,
};

/**
 * Camera choreography.
 *
 * One framing per body, chosen to flatter that body's own proportions:
 * the shooting brake gets a high three-quarter that shows the roofline,
 * the low sedan gets a near-ground hero angle, the mid-engine coupe gets a
 * rear three-quarter over the hips. Selecting a body is therefore a camera
 * move as well as a shape change, which is the whole point — you are being
 * shown the car, not handed a spec sheet.
 *
 * [position, lookAt]
 */
/**
 * Camera field of view, in degrees.
 *
 * Was 38, which at the stage's ~6.5-unit subject distance is a 32mm lens
 * standing 6.5 metres from a car. Nobody photographs a car that way: wide
 * lenses stretch the near corner and shrink the far one, which is the
 * universal signature of a screenshot taken inside a 3D editor. Studio car
 * photography is a long lens from far back, which compresses the body and
 * keeps the wheels the same size at both ends.
 */
export const CAMERA_FOV = 14;

/** The FOV every camera position in this file was originally framed at. */
export const LEGACY_FOV = 38;

/**
 * Camera offset from the engine anchor during an engine-swap dive.
 *
 * Scaled from the original (0.95, 0.62, 1.35) by the same factor the body
 * shots were, so the bay fills the frame exactly as it did before the lens
 * changed. That factor is not arbitrary: framing is preserved when
 * distance scales by tan(LEGACY_FOV/2) / tan(CAMERA_FOV/2), and the
 * geometry test asserts the two still agree — change the FOV without
 * rescaling this and the dive either buries the camera inside the engine
 * or leaves it too far out to read.
 */
export const DIVE_OFFSET: [number, number, number] = [2.66, 1.74, 3.79];

/**
 * How much of the world a hotspot close-up should show, in world units of
 * frame height.
 *
 * Tuned as a framing, not as a distance: at a 14-degree lens a "reasonable
 * looking" offset vector puts the camera about 4.5 units out, which frames
 * 1.1 units — less than the height of the car, so the body overflows the
 * panel on every side and the callout reads as a crash zoom. 2.4 units
 * holds the subsystem plus enough of its surroundings to locate it.
 */
export const FOCUS_FRAME_HEIGHT = 3.2;

/** Direction the focus camera approaches a hotspot from (normalised). */
export const FOCUS_DIR: [number, number, number] = [0.571, 0.253, 0.769];

/**
 * Launch sequence stage boundaries, in FRAMES.
 *
 * Frames rather than milliseconds on purpose: a setTimeout keeps running
 * while the tab is backgrounded but the render loop does not, so a
 * time-driven sequence desynchronises from the picture and the car ends up
 * somewhere the camera is not pointing. Counting frames keeps the motion
 * and the camera on one clock by construction.
 *
 * At 60fps: ignition ~1.2s, tracking shot ~1.0s, drive-away ~1.3s.
 */
export const LAUNCH = { ignite: 72, track: 132, away: 246 } as const;

/**
 * What DIVE_OFFSET was before the lens change, when the stage ran at
 * LEGACY_FOV. Kept as a fixed historical value, not derived — it is the
 * anchor the framing assertion compares against. Deriving the expected
 * framing from CAMERA_FOV instead makes the check an algebraic identity
 * that passes at every FOV, which is exactly what the first version of
 * that test did.
 */
export const LEGACY_DIVE_OFFSET: [number, number, number] = [0.95, 0.62, 1.35];

/**
 * Where a wheel sits, and the fender that covers it.
 *
 * Derived from the body AT THE AXLE. The old code planted tyres against
 * `max(station.w)` — the widest point anywhere on the car — so the outer
 * face sat proud of the widest panel, and since the flank is far narrower
 * at wheel-centre height than at its widest, the tyre cut straight through
 * the bodywork. Exported so the geometry test can assert clearance against
 * the same numbers the renderer uses rather than a restatement of them.
 */
export function wheelTrack(
  spec: CarSpec,
  axle: { x: number; radius: number; width: number },
) {
  const station = nearestStation(spec.body, axle.x);
  /** Half-width of the real surface at the height of the wheel centre. */
  const flankAtHub = surfaceHalfWidth(station, axle.radius);
  const wide = spec.features.wideBody ? ARCH.wideTrack : 0;
  const outer = Math.max(flankAtHub, station.w * 0.86) + wide;
  return {
    station,
    flankAtHub,
    /** Outermost point of the tyre. */
    outer,
    /** Centreline of the tyre. */
    hubZ: outer - axle.width / 2,
    /** Radius of the fender lip's centreline. */
    archRadius: axle.radius + ARCH.gap,
  };
}

/**
 * Where each spatial callout attaches, in car space.
 *
 * Derived from the body rather than hardcoded, because the bodies differ:
 * the cockpit sits at a different height on a low GT than on a long-roof
 * brake, and Maven's engine bay is behind the cabin rather than over the
 * rear axle. A pin at a fixed coordinate would drift off the car.
 */
export function hotspotAnchor(
  spec: CarSpec,
  anchor: "cockpit" | "engine" | "chassis" | "tail",
): [number, number, number] {
  if (anchor === "engine") return engineAnchor(spec);
  if (anchor === "cockpit") {
    const c = spec.cabin[Math.floor(spec.cabin.length / 2)];
    return [c.x, c.y + c.h, 0];
  }
  if (anchor === "chassis") {
    // Mid-body at sill height, on the near flank: the structure, not the skin.
    const s = nearestStation(spec.body, 0);
    return [s.x, s.y - s.h * 0.5, surfaceHalfWidth(s, s.y - s.h * 0.5) * 0.98];
  }
  const t = spec.body[0];
  return [t.x - 0.05, t.y + t.h * 0.45, 0];
}

/** Framed height at a given distance for a vertical FOV, in world units. */
export function framedHeight(distance: number, fovDegrees: number): number {
  return 2 * distance * Math.tan((fovDegrees * Math.PI) / 360);
}

export const BODY_SHOTS: Record<string, { pos: [number, number, number]; at: [number, number, number] }> = {
  // Every shot looks at the SAME point: the car's own centre of mass at
  // [0, 0.62, 0]. Previously each body aimed somewhere slightly different
  // (0.72 / 0.58 / 0.58 with a -0.2 x-offset on Maven), so switching
  // harness nudged the car off-centre in the frame and the whole stage
  // read as slightly crooked. Distances vary; the target does not.
  // Distances are ~2.8x what they were, which is exactly the factor that
  // keeps framing identical when the lens goes from 38 degrees to 14. The
  // heights are NOT a rescale — they are a correction. Every shot used to
  // sit above the car's shoulder looking down at it, and `custom` was at
  // y=4.2 almost directly overhead, which flattens a car into a floorplan.
  // A car is photographed from near its own beltline; that is what makes
  // the roofline read against the background instead of against the floor.
  bravo: { pos: [13.25, 1.05, 13.25], at: [0, 0.62, 0] }, // front 3/4, long roof
  atlas: { pos: [15.18, 0.8, 9.56], at: [0, 0.62, 0] }, // low + frontal, planted
  maven: { pos: [-12.47, 0.88, 13.31], at: [0, 0.62, 0] }, // rear 3/4 over the hips
  custom: { pos: [6.21, 0.85, 17.07], at: [0, 0.62, 0] }, // near-profile, blueprint
};
