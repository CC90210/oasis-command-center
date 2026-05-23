"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

const PHASES = [
  {
    id: 1,
    slug: "initial-seed",
    title: "Initial seed",
    subtitle: "Holographic silhouette warming up. Reasoning core and state pulse synchronizing.",
    progressLabel: "9%",
    image: "/images/agent-assembly/phase-01-initial-seed.png",
    subsystem: "lib/providers.ts · state/empire_state.db",
  },
  {
    id: 2,
    slug: "neural-backbone",
    title: "Neural backbone",
    subtitle: "Memory spine forming vertically through the torso and neck. Hybrid recall stabilizing.",
    progressLabel: "22%",
    image: "/images/agent-assembly/phase-02-neural-backbone.png",
    subsystem: "scripts/core/memory_retriever.py · state/memory_index.{db,lance}",
  },
  {
    id: 3,
    slug: "optic-calibration",
    title: "Optic calibration",
    subtitle: "Browser optics docking. Vision-feed stability climbing toward signal lock.",
    progressLabel: "35%",
    image: "/images/agent-assembly/phase-03-optic-calibration.png",
    subsystem: "scripts/browser/browser_harness_doctor.py · cloak_browser_tool.py",
  },
  {
    id: 4,
    slug: "tool-limb-docking",
    title: "Tool limb docking",
    subtitle: "Actuators online. Hand modules calibrating against grip, range, and micro-motor control.",
    progressLabel: "52%",
    image: "/images/agent-assembly/phase-04-tool-limb-docking.png",
    subsystem: "bravo_cli/bridge_tools.py · scripts/*",
  },
  {
    id: 5,
    slug: "guard-shield",
    title: "Guard shield",
    subtitle: "Policy alignment confirmed. Safe-execution protocols locked. Structural stability optimal.",
    progressLabel: "68%",
    image: "/images/agent-assembly/phase-05-guard-shield.png",
    subsystem: "scripts/state/{secret,exec,state}_guard.py",
  },
  {
    id: 6,
    slug: "output-halo",
    title: "Output halo",
    subtitle: "Response synthesis online. Routing decision channels primed. Delivery protocols live.",
    progressLabel: "81%",
    image: "/images/agent-assembly/phase-06-output-halo.png",
    subsystem: "agent_events bus · scripts/core/event_router.py · telegram_agent.js",
  },
  {
    id: 7,
    slug: "security-mesh",
    title: "Security mesh",
    subtitle: "Zero-trust architecture engaged. All channels authenticated. Containment protocols armed.",
    progressLabel: "92%",
    image: "/images/agent-assembly/phase-07-security-mesh.png",
    subsystem: "scripts/state/secret_guard.py · scripts/audit_mcp_secrets.py",
  },
  {
    id: 8,
    slug: "bravo-online",
    title: "Bravo online",
    subtitle: "Executive agent fully assembled. All systems locked. Capability complete. Mission ready.",
    progressLabel: "100%",
    image: "/images/agent-assembly/phase-08-bravo-online.png",
    subsystem: "Bravo v1.0.0 · OASIS AI Command Centre",
  },
] as const;

const SYSTEMS = [
  "Reasoning Core",
  "State Pulse",
  "Memory Spine",
  "Browser Optics",
  "Tool Limbs",
  "Guard Shield",
  "Output Halo",
  "Security Layer",
  "Bravo Assembly",
] as const;

type Status = "active" | "complete" | "pending" | "online";

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function ease(value: number) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function imageOpacity(i: number, progress: number): number {
  const center = (i + 0.5) / PHASES.length;
  if (i === 0 && progress < center) return 1;
  if (i === PHASES.length - 1 && progress > center) return 1;
  const dist = Math.abs(progress - center);
  return Math.max(0, 1 - dist * 16);
}

function imageScale(i: number, progress: number): number {
  const center = (i + 0.5) / PHASES.length;
  const dist = Math.abs(progress - center);
  const active = Math.max(0, 1 - dist * 8);
  return 1 + active * 0.018;
}

function statusFor(systemIdx: number, phaseIdx: number): Status {
  if (phaseIdx >= PHASES.length - 1) return "online";
  if (phaseIdx === 0) {
    return systemIdx <= 1 ? "active" : "pending";
  }
  if (systemIdx <= phaseIdx) return "complete";
  if (systemIdx === phaseIdx + 1) return "active";
  return "pending";
}

function statusLabel(status: Status): string {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "complete":
      return "LOCKED";
    case "online":
      return "ONLINE";
    default:
      return "PENDING";
  }
}

function statusColor(status: Status): string {
  switch (status) {
    case "active":
      return "text-emerald-200";
    case "complete":
      return "text-white/65";
    case "online":
      return "text-amber-200";
    default:
      return "text-white/30";
  }
}

function statusDot(status: Status): string {
  switch (status) {
    case "active":
      return "bg-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.85)] animate-pulse";
    case "complete":
      return "bg-emerald-300/45";
    case "online":
      return "bg-amber-300 shadow-[0_0_12px_rgba(245,158,11,0.85)]";
    default:
      return "bg-white/15";
  }
}

export function AgentAssemblyScrollScene() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame = 0;

    const update = () => {
      if (!sectionRef.current) return;
      const rect = sectionRef.current.getBoundingClientRect();
      const travel = Math.max(1, rect.height - window.innerHeight);
      setProgress(clamp(-rect.top / travel));
    };

    const requestUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", requestUpdate, { passive: true });
    window.addEventListener("resize", requestUpdate);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
    };
  }, []);

  const phaseIdx = useMemo(() => {
    const raw = Math.floor(progress * PHASES.length);
    return Math.min(PHASES.length - 1, Math.max(0, raw));
  }, [progress]);

  const phase = PHASES[phaseIdx];

  return (
    <section
      ref={sectionRef}
      id="agent-build"
      className="agent-assembly relative z-10"
      style={{ minHeight: "800vh" } as CSSProperties}
    >
      <div className="sticky top-0 h-screen w-full overflow-hidden bg-[#03070a]">
        {/* Image stack — all 8 phases absolutely positioned, opacity-controlled by scroll */}
        <div className="absolute inset-0">
          {PHASES.map((p, i) => {
            const opacity = imageOpacity(i, progress);
            if (opacity <= 0.001) {
              return (
                <div
                  key={p.id}
                  aria-hidden
                  className="absolute inset-0"
                  style={{ opacity: 0, pointerEvents: "none" }}
                />
              );
            }
            return (
              <div
                key={p.id}
                className="absolute inset-0"
                style={{
                  opacity,
                  transform: `scale(${imageScale(i, progress)})`,
                  transformOrigin: "center center",
                  transition: "opacity 80ms linear",
                  willChange: "opacity, transform",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.image}
                  alt={p.title}
                  loading={i <= 1 ? "eager" : "lazy"}
                  decoding="async"
                  className="h-full w-full object-cover object-center"
                  style={{ filter: "saturate(1.05) contrast(1.05)" }}
                />
              </div>
            );
          })}
        </div>

        {/* Cinematic gradient overlays — readability for left text column + bottom CTA */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#03070a]/95 via-[#03070a]/40 to-[#03070a]/30" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#03070a]/60 via-transparent to-[#03070a]/80" />

        {/* SVG overlay layer — orbit rings, particles, subtle motion */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 1920 1080"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <radialGradient id="pulse-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(52,211,153,0.18)" />
              <stop offset="100%" stopColor="rgba(52,211,153,0)" />
            </radialGradient>
          </defs>

          {/* Faint pulse halo from chest area */}
          <circle cx="1080" cy="540" r="200" fill="url(#pulse-glow)" className="pulse-halo" />

          {/* Orbit rings */}
          <circle cx="1080" cy="540" r="260" stroke="rgba(52,211,153,0.10)" strokeWidth="1" fill="none" className="orbit-ring orbit-slow" />
          <circle
            cx="1080"
            cy="540"
            r="360"
            stroke="rgba(52,211,153,0.06)"
            strokeWidth="1"
            fill="none"
            strokeDasharray="3 8"
            className="orbit-ring orbit-reverse"
          />

          {/* Drifting particle dots */}
          {Array.from({ length: 16 }, (_, i) => i).map((i) => (
            <circle key={i} className={`particle particle-${i}`} r="1.6" fill="rgba(167,243,208,0.78)" />
          ))}

          {/* Robotic arm hint glints — left and right edges */}
          <path
            d="M 0 540 L 120 540 L 80 520 Z"
            fill="rgba(52,211,153,0.20)"
            className="arm-hint arm-left"
          />
          <path
            d="M 1920 540 L 1800 540 L 1840 560 Z"
            fill="rgba(52,211,153,0.20)"
            className="arm-hint arm-right"
          />
        </svg>

        {/* Left text panel — minimal, sits over the gradient */}
        <div className="relative z-20 mx-auto flex h-full max-w-7xl items-center px-5 sm:px-8">
          <div className="max-w-md">
            <div className="mb-5 inline-flex items-center gap-2 border-l border-emerald-300/[0.45] bg-emerald-300/[0.08] px-3 py-2 text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-100/[0.85]">
              Build the agent first
            </div>

            <h1 className="text-[clamp(2.35rem,4.2vw,4.4rem)] font-black leading-[0.94] tracking-tight text-white">
              Build the agent
              <br />
              before you enter.
            </h1>

            <p className="mt-6 max-w-md text-base leading-7 text-white/[0.66]">
              Before signup, the system assembles a working operator around your
              business. Scroll to watch reasoning, memory, vision, tools,
              guardrails, and security lock into the body.
            </p>

            {/* Phase status card */}
            <div className="mt-8 border border-white/[0.10] bg-black/45 p-4 backdrop-blur-md">
              <div className="flex items-center justify-between gap-4">
                <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-emerald-200/[0.78]">
                  Phase {String(phase.id).padStart(2, "0")} · {phase.title}
                </div>
                <div className="font-mono text-[10px] tracking-[0.12em] text-emerald-200/[0.92]">
                  {phase.progressLabel}
                </div>
              </div>
              <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full bg-emerald-300/[0.88]"
                  style={{
                    width: `${ease(progress) * 100}%`,
                    transition: "width 80ms linear",
                  }}
                />
              </div>
              <p className="mt-4 text-sm leading-6 text-white/[0.76]">
                {phase.subtitle}
              </p>
              <p className="mt-3 font-mono text-[10px] leading-5 tracking-[0.12em] text-emerald-200/[0.62]">
                {phase.subsystem}
              </p>
            </div>

            {/* Live system roster */}
            <ul className="mt-6 space-y-1.5 text-[11px] font-mono uppercase tracking-[0.16em]">
              {SYSTEMS.map((name, idx) => {
                const status = statusFor(idx, phaseIdx);
                return (
                  <li
                    key={name}
                    className={`flex items-center gap-3 ${statusColor(status)}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${statusDot(status)}`} />
                    <span className="flex-1">
                      {String(idx + 1).padStart(2, "0")} · {name}
                    </span>
                    <span className="text-[9px] opacity-70">{statusLabel(status)}</span>
                  </li>
                );
              })}
            </ul>

            {progress > 0.92 && (
              <a
                href="#choose-agent"
                className="mt-8 inline-flex items-center gap-2 border border-amber-200/[0.55] bg-amber-200/[0.10] px-4 py-3 text-sm font-bold text-amber-100 transition-all hover:border-amber-200/[0.85] hover:bg-amber-200/[0.18]"
              >
                Bravo online — choose entry
                <ChevronDown className="h-4 w-4 animate-bounce" />
              </a>
            )}
          </div>
        </div>

        {/* Scroll hint — only on first viewport */}
        {progress < 0.04 && (
          <div className="pointer-events-none absolute bottom-8 left-1/2 z-20 -translate-x-1/2 transform">
            <div className="flex flex-col items-center gap-2 text-[10px] font-mono uppercase tracking-[0.32em] text-emerald-200/[0.62]">
              <span>Scroll to assemble</span>
              <ChevronDown className="h-4 w-4 animate-bounce" />
            </div>
          </div>
        )}

        <style>{`
          .pulse-halo {
            opacity: 0.6;
            animation: pulse-breathe 6s ease-in-out infinite;
            transform-origin: 1080px 540px;
          }

          @keyframes pulse-breathe {
            0%, 100% { opacity: 0.32; transform: scale(0.94); }
            50%      { opacity: 0.72; transform: scale(1.08); }
          }

          .orbit-ring {
            transform-origin: 1080px 540px;
          }

          .orbit-slow {
            animation: orbit-rotate 34s linear infinite;
          }

          .orbit-reverse {
            animation: orbit-rotate 46s linear infinite reverse;
          }

          @keyframes orbit-rotate {
            from { transform: rotate(0deg); }
            to   { transform: rotate(360deg); }
          }

          .arm-hint {
            opacity: 0.28;
            animation: arm-flicker 4.6s ease-in-out infinite;
          }

          .arm-left  { transform-origin: 0 540px; }
          .arm-right { transform-origin: 1920px 540px; }

          @keyframes arm-flicker {
            0%, 100% { opacity: 0.22; }
            50%      { opacity: 0.62; }
          }

          .particle {
            opacity: 0.45;
            animation: particle-pulse 9s ease-in-out infinite;
          }

          ${Array.from({ length: 16 }, (_, i) => {
            const x = 80 + ((i * 217) % 1760);
            const y = 60 + ((i * 137) % 960);
            const delay = (i * 0.7) % 6;
            return `
              .particle-${i} {
                cx: ${x};
                cy: ${y};
                animation-delay: ${delay}s;
              }
            `;
          }).join("")}

          @keyframes particle-pulse {
            0%, 100% { opacity: 0.20; transform: translateY(0); }
            50%      { opacity: 0.78; transform: translateY(-8px); }
          }

          @media (max-width: 1023px) {
            .agent-assembly {
              min-height: 700vh;
            }
          }

          @media (max-width: 640px) {
            .agent-assembly {
              min-height: 600vh;
            }
          }

          @media (prefers-reduced-motion: reduce) {
            .pulse-halo,
            .orbit-slow,
            .orbit-reverse,
            .arm-hint,
            .particle {
              animation: none !important;
            }
          }
        `}</style>
      </div>
    </section>
  );
}
