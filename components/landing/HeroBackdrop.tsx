"use client";

import { useEffect, useRef } from "react";

/**
 * HeroBackdrop — single-component animated atmosphere for the /welcome
 * landing page. Replaces the V1-V6 WebGL scroll-assembly machinery with
 * a pure CSS + Canvas 2D background that's beautiful, lightweight, and
 * needs no scroll mechanic.
 *
 * Layers (back to front):
 *   1. Deep cosmic gradient (radial nebula tints over near-black base)
 *   2. Slowly drifting nebula clouds (3 soft-blurred radial shapes)
 *   3. Rotating spiral galaxy (SVG, very low opacity)
 *   4. Distant star field (48 hand-placed twinkling stars)
 *   5. Perlin-style flow field on Canvas 2D (260 particles, aurora streams)
 *   6. Faint holographic grid overlay (radial-mask)
 *   7. Corner vignette
 *
 * Everything is pointer-events: none + aria-hidden + position: fixed,
 * so the hero content above floats freely. Respects
 * prefers-reduced-motion (skips the flow field RAF + freezes nebula
 * drift to a single frame).
 */

const COSMIC_STARS = [
  { left: 3, top: 6, size: 1.1, twinkle: 4.2 },
  { left: 11, top: 17, size: 1.4, twinkle: 5.8 },
  { left: 14, top: 88, size: 0.9, twinkle: 4.7 },
  { left: 19, top: 46, size: 0.8, twinkle: 5.3 },
  { left: 21, top: 11, size: 1.2, twinkle: 6.6 },
  { left: 27, top: 27, size: 1.6, twinkle: 4.4 },
  { left: 29, top: 81, size: 0.7, twinkle: 6.9 },
  { left: 31, top: 4, size: 1.0, twinkle: 5.5 },
  { left: 36, top: 38, size: 1.1, twinkle: 6.3 },
  { left: 41, top: 23, size: 1.3, twinkle: 4.6 },
  { left: 44, top: 71, size: 0.7, twinkle: 6.5 },
  { left: 46, top: 9, size: 0.9, twinkle: 5.2 },
  { left: 51, top: 84, size: 1.0, twinkle: 4.8 },
  { left: 53, top: 30, size: 1.5, twinkle: 6.2 },
  { left: 57, top: 14, size: 0.9, twinkle: 4.3 },
  { left: 59, top: 49, size: 1.2, twinkle: 6.0 },
  { left: 65, top: 35, size: 0.8, twinkle: 4.5 },
  { left: 67, top: 73, size: 1.4, twinkle: 6.8 },
  { left: 71, top: 20, size: 0.7, twinkle: 5.0 },
  { left: 76, top: 41, size: 0.6, twinkle: 4.1 },
  { left: 78, top: 86, size: 1.1, twinkle: 5.5 },
  { left: 81, top: 12, size: 0.8, twinkle: 6.7 },
  { left: 86, top: 33, size: 0.7, twinkle: 5.8 },
  { left: 89, top: 92, size: 0.9, twinkle: 5.1 },
  { left: 92, top: 22, size: 1.0, twinkle: 6.5 },
  { left: 96, top: 78, size: 1.5, twinkle: 5.9 },
  { left: 2, top: 51, size: 0.8, twinkle: 6.1 },
  { left: 5, top: 75, size: 1.0, twinkle: 4.9 },
  { left: 16, top: 60, size: 0.7, twinkle: 5.6 },
  { left: 39, top: 5, size: 1.2, twinkle: 4.2 },
  { left: 42, top: 95, size: 0.6, twinkle: 6.3 },
  { left: 64, top: 8, size: 0.9, twinkle: 5.4 },
  { left: 87, top: 7, size: 0.7, twinkle: 4.8 },
  { left: 24, top: 96, size: 0.8, twinkle: 5.2 },
  { left: 70, top: 96, size: 1.1, twinkle: 6.6 },
  { left: 56, top: 96, size: 0.6, twinkle: 4.5 },
  { left: 9, top: 96, size: 0.9, twinkle: 5.7 },
  { left: 32, top: 70, size: 0.8, twinkle: 4.6 },
];

const PARTICLE_COLORS = ["#5eead4", "#86efac", "#fcd34d"] as const;

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function smoothNoise(x: number, y: number): number {
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

type Particle = {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  color: string;
};

function spawnParticle(width: number, height: number): Particle {
  const color = PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)];
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    life: 0,
    maxLife: 220 + Math.random() * 200,
    color,
  };
}

export function HeroBackdrop() {
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
    const particleCount = isCompact ? 180 : 260;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let width = 0;
    let height = 0;
    let t = 0;

    const resize = () => {
      const parent = canvas.parentElement;
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

    particlesRef.current = Array.from({ length: particleCount }, () =>
      spawnParticle(width, height),
    );

    const tick = () => {
      t += 1;
      // Trail accumulation — fade previous frame by 6% toward background
      ctx.fillStyle = "rgba(2,6,12,0.06)";
      ctx.fillRect(0, 0, width, height);

      for (const p of particlesRef.current) {
        const angle = smoothNoise(p.x * 0.004 + t * 0.0008, p.y * 0.004) * Math.PI * 2;
        const speed = 1 + Math.random() * 1.5;
        p.x += Math.cos(angle) * speed;
        p.y += Math.sin(angle) * speed;
        p.life += 1;

        if (
          p.life > p.maxLife ||
          p.x < -20 || p.x > width + 20 ||
          p.y < -20 || p.y > height + 20
        ) {
          Object.assign(p, spawnParticle(width, height));
          continue;
        }

        const lifeFrac = p.life / p.maxLife;
        const fade = Math.sin(lifeFrac * Math.PI);
        ctx.globalAlpha = fade * 0.18;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2);
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

    let ro: ResizeObserver | null = null;
    if (canvas.parentElement && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => resize());
      ro.observe(canvas.parentElement);
    }

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      if (ro) ro.disconnect();
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      {/* Layer 1 — deep cosmic gradient */}
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_25%,rgba(76,29,149,0.32),transparent_38%),radial-gradient(ellipse_at_72%_75%,rgba(15,118,110,0.28),transparent_40%),radial-gradient(ellipse_at_50%_55%,rgba(52,211,153,0.13),transparent_55%),linear-gradient(180deg,#02060c_0%,#03070a_55%,#02050a_100%)]"
      />

      {/* Layer 2 — nebula clouds (CSS animation, GPU-accelerated) */}
      <div className="absolute -left-[10%] top-[12%] h-[55vh] w-[55vw] rounded-full opacity-[0.42] blur-[80px] bg-[radial-gradient(circle,rgba(124,58,237,0.55),transparent_70%)] motion-safe:animate-[hb-drift-a_32s_ease-in-out_infinite]" />
      <div className="absolute -right-[12%] top-[55%] h-[50vh] w-[50vw] rounded-full opacity-[0.38] blur-[90px] bg-[radial-gradient(circle,rgba(20,184,166,0.5),transparent_70%)] motion-safe:animate-[hb-drift-b_38s_ease-in-out_infinite]" />
      <div className="absolute right-[18%] top-[6%] h-[28vh] w-[28vw] rounded-full opacity-[0.28] blur-[60px] bg-[radial-gradient(circle,rgba(252,211,77,0.42),transparent_70%)] motion-safe:animate-[hb-drift-c_26s_ease-in-out_infinite]" />

      {/* Layer 3 — slowly rotating spiral galaxy */}
      <svg
        viewBox="0 0 600 600"
        className="absolute left-[58%] top-[20%] h-[90vh] w-[90vh] -translate-x-1/2 opacity-[0.18] motion-safe:animate-[hb-spin_120s_linear_infinite]"
      >
        <defs>
          <radialGradient id="hb-galaxy-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(252,211,77,0.85)" />
            <stop offset="22%" stopColor="rgba(134,239,172,0.55)" />
            <stop offset="58%" stopColor="rgba(76,29,149,0.32)" />
            <stop offset="100%" stopColor="rgba(2,6,12,0)" />
          </radialGradient>
          <radialGradient id="hb-galaxy-arm" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(167,243,208,0.42)" />
            <stop offset="100%" stopColor="rgba(167,243,208,0)" />
          </radialGradient>
        </defs>
        <circle cx="300" cy="300" r="240" fill="url(#hb-galaxy-core)" />
        {[0, 72, 144, 216, 288].map((deg) => (
          <g key={deg} transform={`rotate(${deg} 300 300)`}>
            <path
              d="M300 300 C 360 285, 420 270, 470 240 C 510 215, 540 180, 555 140"
              stroke="url(#hb-galaxy-arm)"
              strokeWidth="42"
              fill="none"
              strokeLinecap="round"
              opacity="0.55"
            />
          </g>
        ))}
      </svg>

      {/* Layer 4 — distant star field with CSS twinkle */}
      <div className="absolute inset-0">
        {COSMIC_STARS.map((star) => (
          <span
            key={`star-${star.left}-${star.top}`}
            className="absolute rounded-full bg-white shadow-[0_0_6px_rgba(167,243,208,0.6)] motion-safe:animate-[hb-twinkle_var(--d)_ease-in-out_infinite]"
            style={{
              left: `${star.left}%`,
              top: `${star.top}%`,
              height: star.size,
              width: star.size,
              ["--d" as string]: `${star.twinkle}s`,
            }}
          />
        ))}
      </div>

      {/* Layer 5 — Perlin flow-field particle canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ mixBlendMode: "screen", opacity: 0.6 }}
      />

      {/* Layer 6 — holographic grid */}
      <div
        className="absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(167,243,208,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(167,243,208,0.035)_1px,transparent_1px)] [background-size:96px_96px] [mask-image:radial-gradient(ellipse_72%_64%_at_50%_50%,black_20%,transparent_84%)]"
      />

      {/* Layer 7 — corner vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_42%,rgba(2,5,10,0.82)_100%)]" />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-200/35 to-transparent" />

      <style>{`
        @keyframes hb-drift-a { 0%,100% { transform: translate(0,0); } 50% { transform: translate(24px, 18px); } }
        @keyframes hb-drift-b { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-22px, -14px); } }
        @keyframes hb-drift-c { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-12px, 10px); } }
        @keyframes hb-spin    { from { transform: translateX(-50%) rotate(0deg); } to { transform: translateX(-50%) rotate(360deg); } }
        @keyframes hb-twinkle { 0%,100% { opacity: 0.18; } 50% { opacity: 0.86; } }
      `}</style>
    </div>
  );
}
