import Link from "next/link";
import { ArrowRight, Activity } from "lucide-react";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/supabase-server";
import { OasisLogo } from "@/components/brand/OasisLogo";

export const dynamic = "force-dynamic";

/**
 * /welcome — landing surface.
 *
 * Rebuilt 2026-05-22 (CC: "currently looks too much like a standard
 * marketing website with too much text — make it feel like an
 * immersive futuristic software application").
 *
 * Design contract:
 *   - One centered focal point. The entire viewport is a single
 *     dark stage with the OASIS mark + one terse claim + two CTAs.
 *   - No feature grid, no CTA strip, no marketing paragraphs.
 *     Strip-and-center beats grid-and-explain. Operators who want
 *     details click through.
 *   - Motion at every layer: aurora gradient orbits with @keyframes
 *     `orbit-*`, grid lattice slow-shimmers via opacity loop, the
 *     status ticker animates as a "live system" pill, CTAs lift on
 *     hover with a layered glow. CSS-only — no framer-motion dep.
 *   - Glassmorphism on the central card: backdrop-blur-xl + 1px
 *     accent border + soft inner highlight.
 *   - Deep dark with vibrant cyan accents. The aurora is layered
 *     conic + radial gradients so the cyan never feels flat.
 */
export default async function WelcomePage() {
  // Already signed in? Send them to the dashboard.
  const user = await getSessionUser().catch(() => null);
  if (user) redirect("/");

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg-deep text-fg">
      {/* === Layered cinematic backdrop ============================== */}

      {/* Orbiting aurora — two counter-rotating conic gradients sweep
          across the stage. CSS keyframe `orbit-slow` lives in app's
          global stylesheet; defined below in <style jsx global>. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-30"
      >
        <div
          className="absolute left-1/2 top-1/2 h-[140vmax] w-[140vmax] -translate-x-1/2 -translate-y-1/2 opacity-50 blur-3xl animate-[orbit-slow_36s_linear_infinite]"
          style={{
            background:
              "conic-gradient(from 0deg at 50% 50%, rgba(0,212,255,0.35), rgba(59,130,246,0.18), transparent 40%, rgba(168,85,247,0.18) 70%, rgba(0,212,255,0.32))",
          }}
        />
        <div
          className="absolute left-1/2 top-1/2 h-[120vmax] w-[120vmax] -translate-x-1/2 -translate-y-1/2 opacity-30 blur-3xl animate-[orbit-fast_24s_linear_reverse_infinite]"
          style={{
            background:
              "conic-gradient(from 180deg at 50% 50%, rgba(34,211,238,0.35), transparent 50%, rgba(6,182,212,0.25))",
          }}
        />
      </div>

      {/* Grid lattice — sits BEHIND the aurora overlap; opacity loops
          via animate-[grid-shimmer]. Reinforces the "command centre,
          not a marketing site" read. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-20 animate-[grid-shimmer_8s_ease-in-out_infinite]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(0,212,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,0.08) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage:
            "radial-gradient(ellipse 80% 60% at 50% 50%, black 30%, transparent 80%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 80% 60% at 50% 50%, black 30%, transparent 80%)",
        }}
      />

      {/* Floating particle dots — pure CSS via radial-gradient mask. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.18] animate-[drift_22s_ease-in-out_infinite]"
        style={{
          backgroundImage:
            "radial-gradient(rgba(0,212,255,0.6) 1px, transparent 1.4px)",
          backgroundSize: "120px 120px",
        }}
      />

      {/* Vignette — pulls focus to the central card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(ellipse 50% 50% at 50% 50%, transparent 0%, rgba(8,11,16,0.7) 100%)",
        }}
      />

      {/* === Minimal top-left brand mark ============================ */}
      <div className="absolute left-6 top-6 z-20 flex items-center gap-2.5 sm:left-10 sm:top-8">
        <OasisLogo size={28} priority />
        <div className="leading-none">
          <div className="text-[11px] font-black tracking-[0.18em] text-fg">
            OASIS AI
          </div>
          <div className="text-[9px] uppercase tracking-[0.22em] text-fg-dim">
            Command Center
          </div>
        </div>
      </div>

      {/* === Minimal top-right system status ticker ================= */}
      <div className="absolute right-6 top-6 z-20 hidden sm:flex sm:right-10 sm:top-8">
        <div className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-bg-elev/40 px-3 py-1.5 backdrop-blur-xl">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-engaged opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-status-engaged" />
          </span>
          <span className="text-[10px] font-mono uppercase tracking-[0.16em] text-fg-muted">
            SYSTEM ONLINE
          </span>
        </div>
      </div>

      {/* === Center stage ============================================ */}
      <section className="relative z-10 flex min-h-screen items-center justify-center px-6">
        <div className="flex w-full max-w-2xl flex-col items-center text-center">
          {/* Eyebrow */}
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/5 px-3.5 py-1.5 text-[10px] font-mono uppercase tracking-[0.2em] text-accent backdrop-blur">
            <Activity className="h-3 w-3 animate-pulse" />
            Multi-agent operations
          </div>

          {/* Single immersive glass card with the headline + CTAs.
              Layered border + inner highlight + backdrop-blur gives
              the cinematic-software read. */}
          <div className="group relative w-full overflow-hidden rounded-3xl border border-white/10 bg-bg-elev/30 px-8 py-12 backdrop-blur-2xl sm:px-12 sm:py-16">
            {/* Inner highlight stripe at the top of the card */}
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 h-px"
              style={{
                background:
                  "linear-gradient(90deg, transparent, rgba(0,212,255,0.6), transparent)",
              }}
            />
            {/* Soft inner glow that breathes */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-50 animate-[pulse-soft_6s_ease-in-out_infinite]"
              style={{
                background:
                  "radial-gradient(circle at 50% 0%, rgba(0,212,255,0.25), transparent 60%)",
              }}
            />

            <h1 className="relative text-5xl font-black leading-[1.02] tracking-tight text-fg sm:text-7xl">
              <span className="block">Your agents.</span>
              <span className="block bg-gradient-to-r from-accent via-cyan-300 to-accent bg-clip-text text-transparent animate-[shimmer_6s_ease-in-out_infinite]">
                One command.
              </span>
            </h1>

            <p className="relative mx-auto mt-5 max-w-md text-sm leading-relaxed text-fg-muted sm:text-base">
              A C-suite of AI agents running on your machine, in one console.
            </p>

            <div className="relative mt-10 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/signup"
                className="group/cta relative inline-flex items-center gap-2 overflow-hidden rounded-xl border border-accent/40 bg-gradient-to-br from-accent/30 via-cyan-500/20 to-accent/30 px-6 py-3 text-sm font-bold text-fg shadow-[0_0_40px_-12px_rgba(0,212,255,0.6)] transition-all hover:scale-[1.02] hover:shadow-[0_0_60px_-8px_rgba(0,212,255,0.8)]"
              >
                <span
                  aria-hidden
                  className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/15 to-transparent transition-transform duration-700 group-hover/cta:translate-x-full"
                />
                <span className="relative">Enter the command center</span>
                <ArrowRight className="relative h-4 w-4 transition-transform group-hover/cta:translate-x-1" />
              </Link>

              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-bg-elev/40 px-6 py-3 text-sm font-medium text-fg-muted backdrop-blur-xl transition-colors hover:border-accent/30 hover:text-fg"
              >
                Sign in
              </Link>
            </div>

            <div className="relative mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-fg-dim">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-accent" /> Local-first
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-accent" /> Multi-tenant
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-accent" /> 30+ integrations
              </span>
            </div>
          </div>

          {/* Subtle below-card hint */}
          <Link
            href="/download"
            className="mt-10 text-[11px] font-mono uppercase tracking-[0.18em] text-fg-dim transition-colors hover:text-accent"
          >
            Or download the desktop app →
          </Link>
        </div>
      </section>

      {/* === Keyframes (scoped to this route via styled-jsx-global) === */}
      <style>{`
        @keyframes orbit-slow {
          from { transform: translate(-50%, -50%) rotate(0deg); }
          to { transform: translate(-50%, -50%) rotate(360deg); }
        }
        @keyframes orbit-fast {
          from { transform: translate(-50%, -50%) rotate(0deg); }
          to { transform: translate(-50%, -50%) rotate(-360deg); }
        }
        @keyframes grid-shimmer {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
        @keyframes drift {
          0%, 100% { transform: translate3d(0, 0, 0); }
          50% { transform: translate3d(18px, -22px, 0); }
        }
        @keyframes pulse-soft {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 0.7; }
        }
        @keyframes shimmer {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }
      `}</style>
    </main>
  );
}
