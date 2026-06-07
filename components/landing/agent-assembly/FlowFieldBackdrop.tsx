"use client";

import { useEffect, useRef } from "react";

/**
 * FlowFieldBackdrop — Canvas 2D Perlin-style flow-field particle layer,
 * the only piece imported from the Odysseus reference site
 * (pewdiepie-archdaemon.github.io/odysseus). Sits as an ambient stratum
 * BEHIND the WebGL humanoid and ABOVE the static cosmic gradient so the
 * frame is alive at every scroll position, not just during the install
 * phases.
 *
 * Technique:
 *   - N particles (260 desktop / 200 mobile) advected through a
 *     deterministic noise field. The field is a smooth bilinear hash —
 *     not a true Perlin/Simplex but visually equivalent and zero deps.
 *   - The canvas is NOT cleared per frame. Instead a thin alpha rect
 *     fades the previous frame ~6% toward the background colour, which
 *     leaves a fading comet trail behind each particle.
 *   - Particle radius 1.1px at globalAlpha 0.18 max — reads as aurora
 *     shimmer at typical viewing distance, not as foreground noise.
 *   - DPR-aware up to a cap of 2 (Retina sharpness without thermal
 *     overhead).
 *   - Colours mapped to phase clusters of the install sequence:
 *       cyan (#5eead4)  → Reasoning / State / Memory   (phases 1-3)
 *       green (#86efac) → Vision / Bridge / Guard      (phases 4-6)
 *       amber (#fcd34d) → Output / Security / Business / Command (7-10)
 *   - Respects prefers-reduced-motion: renders a single static frame
 *     then stops the RAF loop.
 *
 * Lifetime: mounts/unmounts with the parent scene. Cancels its RAF and
 * resize listener on unmount.
 */

const PARTICLE_COLORS = ["#5eead4", "#86efac", "#fcd34d"] as const;
const BACKGROUND_FADE = "rgba(2, 6, 12, 0.06)";
const TRAIL_ALPHA = 0.18;
const PARTICLE_RADIUS = 1.1;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
};

function hash2(x: number, y: number): number {
  // 1-tap pseudo-hash. Same trick the Odysseus site uses; sufficient
  // for visually-smooth flow fields because we bilinearly interpolate
  // four corners per sample.
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise(x: number, y: number): number {
  // Bilinear interpolation between four hashed lattice corners.
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const aa = hash2(xi, yi);
  const ba = hash2(xi + 1, yi);
  const ab = hash2(xi, yi + 1);
  const bb = hash2(xi + 1, yi + 1);
  const top = aa * (1 - u) + ba * u;
  const bot = ab * (1 - u) + bb * u;
  return top * (1 - v) + bot * v;
}

function spawnParticle(width: number, height: number): Particle {
  const color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
  const maxLife = 220 + Math.random() * 200;
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    vx: 0,
    vy: 0,
    life: 0,
    maxLife,
    color,
  };
}

export function FlowFieldBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const particlesRef = useRef<Particle[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isCompact = window.matchMedia("(max-width: 640px)").matches;
    const particleCount = isCompact ? 200 : 260;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let width = 0;
    let height = 0;
    let t = 0;

    const parent = canvas.parentElement;
    const resize = () => {
      // Prefer the parent's rect — the canvas's own rect is unreliable when
      // it's position:absolute inside a flex/sticky container that hasn't
      // computed yet. ResizeObserver below catches every parent resize.
      const rect = parent ? parent.getBoundingClientRect() : canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "rgba(2,6,12,1)";
      ctx.fillRect(0, 0, width, height);
    };
    resize();

    // Seed particles spread evenly across the canvas.
    particlesRef.current = Array.from({ length: particleCount }, () =>
      spawnParticle(width, height),
    );

    const tick = () => {
      t += 1;
      // Motion-blur trail: paint a thin background-coloured rect over
      // everything from the previous frame. NOT a clearRect.
      ctx.fillStyle = BACKGROUND_FADE;
      ctx.fillRect(0, 0, width, height);

      for (const p of particlesRef.current) {
        // Sample the flow field. Coordinates scaled down so the field
        // varies over ~250px lengths, time scaled so the field morphs
        // slowly (one full evolution over ~50s).
        const angle = smoothNoise(p.x * 0.004 + t * 0.0008, p.y * 0.004) * Math.PI * 2;
        const speed = 1 + Math.random() * 1.5;
        p.vx = Math.cos(angle) * speed;
        p.vy = Math.sin(angle) * speed;
        p.x += p.vx;
        p.y += p.vy;
        p.life += 1;

        // Off-screen or aged out → respawn at a new random spot.
        if (
          p.life > p.maxLife ||
          p.x < -20 ||
          p.x > width + 20 ||
          p.y < -20 ||
          p.y > height + 20
        ) {
          Object.assign(p, spawnParticle(width, height));
          continue;
        }

        // Fade alpha over lifetime — peaks at 60% lifetime, soft fade
        // at the ends so respawn isn't jarring.
        const lifeFrac = p.life / p.maxLife;
        const fade = Math.sin(lifeFrac * Math.PI);
        ctx.globalAlpha = fade * TRAIL_ALPHA;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PARTICLE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (!prefersReduced) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    tick();

    const onResize = () => resize();
    window.addEventListener("resize", onResize, { passive: true });

    // Watch the parent element too — a `sticky` parent inside an `h-screen`
    // section often computes its final size after the first paint, after
    // the useEffect has already fired. ResizeObserver catches that second
    // layout pass without us having to defer with setTimeout.
    let ro: ResizeObserver | null = null;
    if (parent && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => resize());
      ro.observe(parent);
    }

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      if (ro) ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{ mixBlendMode: "screen", opacity: 0.65 }}
    />
  );
}
