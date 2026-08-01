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
  };
  /**
   * Wheel treatment. Spoke count and rim depth differ per body so the cars
   * are told apart at the corners as well as at the roofline.
   */
  wheel: { spokes: number; rimDepth: number; tint: number };
};

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
  features: { rails: true },
  wheel: { spokes: 6, rimDepth: 0.9, tint: 0x00d4ff },
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
  features: { skirts: true },
  wheel: { spokes: 10, rimDepth: 0.62, tint: 0x7fd8ff },
};

/** MAVEN — mid-engine coupe. Low nose, big hips, cab-forward. */
const MAVEN: CarSpec = {
  body: [
    { x: -2.20, y: 0.50, h: 0.24, w: 0.78, squareness: 4.6 },
    { x: -1.80, y: 0.48, h: 0.34, w: 1.02, squareness: 4.0 },
    { x: -1.05, y: 0.46, h: 0.38, w: 1.12, squareness: 3.6 },
    { x: -0.20, y: 0.44, h: 0.38, w: 1.10, squareness: 3.4 },
    { x: 0.60, y: 0.42, h: 0.34, w: 1.02, squareness: 3.4 },
    { x: 1.35, y: 0.38, h: 0.28, w: 0.92, squareness: 3.8 },
    { x: 1.95, y: 0.34, h: 0.20, w: 0.78, squareness: 4.2 },
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
  features: { wing: true },
  wheel: { spokes: 5, rimDepth: 1.15, tint: 0x00d4ff },
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
  features: { exposedFrame: true },
  wheel: { spokes: 8, rimDepth: 0.8, tint: 0x9ca0a8 },
};

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
export const BODY_SHOTS: Record<string, { pos: [number, number, number]; at: [number, number, number] }> = {
  bravo: { pos: [4.1, 2.1, 4.4], at: [0, 0.72, 0] },
  atlas: { pos: [5.3, 0.78, 2.6], at: [0, 0.58, 0] },
  maven: { pos: [-3.8, 1.3, 4.6], at: [-0.2, 0.58, 0] },
  custom: { pos: [0.3, 4.3, 5.0], at: [0, 0.5, 0] },
};
