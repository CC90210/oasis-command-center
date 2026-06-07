/**
 * GLSL shaders for the holographic particle avatar.
 *
 * Vertex shader:
 *   - Receives `aScatter` (Vector3) + `aPhaseSeed` (Vector3: phase, seed1, seed2)
 *     as per-vertex attributes alongside the standard `position` (the rest pose).
 *   - Reads `uPhaseProgress` (vec4[3] packing 10 install scalars + 1 compaction +
 *     padding), `uTime` (seconds), `uCompaction` (0-1), `uOverallProgress` (0-1).
 *   - Lerps the world position between scatter and rest based on the particle's
 *     own phase progress, with a soft sin-wave drift while scattered and a
 *     micro-orbit "breathing" once installed.
 *   - Sets gl_PointSize based on distance to camera (perspective) + a brightness
 *     factor that boosts size during the compaction pulse.
 *   - Forwards a per-particle colour to the fragment shader, picked from a
 *     palette indexed by phase (cool blue → cyan → green → amber across phases
 *     1→10, so the figure has a warm vertical gradient).
 *
 * Fragment shader:
 *   - Renders each point as a soft radial gradient (bright centre, falloff to
 *     transparent at the point edge).
 *   - Multiplies the radial alpha by the install opacity so particles fade in
 *     cleanly rather than popping.
 *   - Outputs sRGB-corrected emissive colour so the postprocessing Bloom pass
 *     picks them up.
 */

export const PARTICLE_VERTEX = /* glsl */ `
  attribute vec3 aScatter;
  attribute vec3 aPhaseSeed;     // x = phase index (0-9), y/z = random seeds

  // 10 install progress scalars packed into 3 vec4s + 2 trailing slots wasted.
  // GLSL doesn't allow easy uniform arrays of length 10, so we pack.
  uniform vec4 uInstall0;        // phases 0,1,2,3
  uniform vec4 uInstall1;        // phases 4,5,6,7
  uniform vec4 uInstall2;        // phases 8,9, unused, unused
  uniform float uCompaction;
  uniform float uTime;
  uniform float uPixelScale;     // scales gl_PointSize for DPR + canvas size

  varying vec3  vColor;
  varying float vAlpha;
  varying float vEmissive;

  vec3 phaseColor(int phase) {
    // Vertical-gradient palette: head=warm-white, descending into cyan-green
    // for body, amber for feet/podium. Tuned so the figure reads as energy.
    if (phase == 0) return vec3(0.85, 1.00, 0.92);  // head warm-white
    if (phase == 1) return vec3(0.55, 1.00, 0.72);  // chest core — OASIS green
    if (phase == 2) return vec3(0.40, 0.95, 0.80);  // spine — teal
    if (phase == 3) return vec3(1.00, 0.90, 0.55);  // visor — warm amber
    if (phase == 4) return vec3(0.55, 0.95, 0.85);  // forearms — cool green
    if (phase == 5) return vec3(0.55, 1.00, 0.72);  // pauldrons — OASIS green
    if (phase == 6) return vec3(0.55, 0.95, 0.85);  // neck/clavicle — cool green
    if (phase == 7) return vec3(0.45, 0.85, 0.80);  // pelvis — deeper teal
    if (phase == 8) return vec3(0.55, 1.00, 0.72);  // upper arms — OASIS green
    return vec3(0.95, 0.78, 0.50);                  // legs/podium — amber
  }

  float installFor(int phase) {
    if (phase == 0) return uInstall0.x;
    if (phase == 1) return uInstall0.y;
    if (phase == 2) return uInstall0.z;
    if (phase == 3) return uInstall0.w;
    if (phase == 4) return uInstall1.x;
    if (phase == 5) return uInstall1.y;
    if (phase == 6) return uInstall1.z;
    if (phase == 7) return uInstall1.w;
    if (phase == 8) return uInstall2.x;
    return uInstall2.y;
  }

  // Smooth Hermite step — like GLSL smoothstep but explicit so we can tune.
  float smoothRamp(float t) {
    return t * t * (3.0 - 2.0 * t);
  }

  void main() {
    int phase = int(aPhaseSeed.x + 0.5);
    float installP = installFor(phase);
    float ramped = smoothRamp(clamp(installP, 0.0, 1.0));

    // Pre-install float drift — small sine bob on a unique seed.
    float seed1 = aPhaseSeed.y;
    float seed2 = aPhaseSeed.z;
    vec3 drift;
    drift.x = sin(uTime * 0.55 + seed1 * 17.0) * 0.18;
    drift.y = cos(uTime * 0.42 + seed2 * 23.0) * 0.22;
    drift.z = sin(uTime * 0.34 + (seed1 + seed2) * 11.0) * 0.16;
    drift *= (1.0 - ramped);  // dampens to 0 as part installs

    // Post-install breathing — micro-orbit once home (subtle 0.005u amplitude).
    vec3 breath;
    breath.x = sin(uTime * 1.6 + seed1 * 5.0) * 0.006;
    breath.y = cos(uTime * 1.4 + seed2 * 7.0) * 0.006;
    breath.z = sin(uTime * 1.2 + (seed1 + seed2) * 3.0) * 0.006;
    breath *= ramped;

    // Compaction beat — adds a slight inward pull + brightness pulse.
    float compPulse = sin(uCompaction * 3.14159) * 0.04;
    vec3 inwardPull = -position * compPulse * smoothRamp(uCompaction);

    vec3 worldPos = mix(aScatter, position, ramped) + drift + breath + inwardPull;

    vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // Point size: base size + boost during compaction + perspective fall-off
    float baseSize = 3.0 + ramped * 1.5 + uCompaction * 1.8;
    gl_PointSize = baseSize * uPixelScale * (12.0 / -mvPosition.z);

    // Per-particle output
    vColor = phaseColor(phase);
    vAlpha = mix(0.18, 0.85, ramped) + uCompaction * 0.2;
    vEmissive = 1.4 + uCompaction * 0.8 + ramped * 0.4;
  }
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
  precision highp float;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vEmissive;

  void main() {
    // Distance from particle centre (gl_PointCoord is in 0..1 across the point)
    vec2 c = gl_PointCoord - 0.5;
    float dist = length(c) * 2.0;
    if (dist > 1.0) discard;

    // Radial alpha: bright dot in the centre fading to 0 at the edge.
    // Squared falloff reads as a soft glow instead of a hard disc.
    float radial = 1.0 - dist;
    radial = radial * radial;

    // Inner core extra bright (centre 30%)
    float core = smoothstep(0.35, 0.0, dist);

    vec3 colour = vColor * vEmissive + vec3(core * 0.6);
    float alpha = radial * vAlpha;

    gl_FragColor = vec4(colour, alpha);
  }
`;
