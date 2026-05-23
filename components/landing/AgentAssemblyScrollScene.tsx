"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BrainCircuit,
  ChevronDown,
  Cpu,
  Database,
  Eye,
  Network,
  Orbit,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";

const PERSONAS = ["BRAVO", "ATLAS", "MAVEN", "AURA", "HERMES"];

const PHASES = [
  {
    start: 0,
    marker: "01",
    title: "Reasoning core",
    text: "Multi-provider brain locks in — the primary reasoning core, the Codex dual-AI executor, the state pulse that keeps the empire substrate alive, and the persona ring (Bravo, Atlas, Maven, Aura, Hermes) on the same router.",
    path: "lib/providers.ts · lib/agent-personas.ts · state/empire_state.db · codex-companion.mjs",
  },
  {
    start: 0.17,
    marker: "02",
    title: "Browser optics",
    text: "Sees the public web through a real logged-in Chrome — Cloudflare, DataDome, fingerprint-proof via the CloakBrowser stealth tier with C++ source-level patches.",
    path: "scripts/browser/browser_harness_doctor.py · cloak_browser_tool.py",
  },
  {
    start: 0.31,
    marker: "03",
    title: "Memory spine",
    text: "Hybrid lexical + semantic recall across 219 memory, skills, and brain files. FTS5 + LanceDB merged via reciprocal rank fusion. 148 skills surface as a queryable capability constellation above the spine.",
    path: "scripts/core/memory_retriever.py · state/memory_index.{db,lance} · brain/CAPABILITY_GRAPH.json",
  },
  {
    start: 0.45,
    marker: "04",
    title: "Tool limbs",
    text: "21 local tools through the bridge — read/write, bash, Stripe, Supabase, Vercel, n8n, Firecrawl. Cloud-safe tools when the bridge is offline. 115 Python CLI scripts under scripts/.",
    path: "bravo_cli/bridge_tools.py · scripts/*",
  },
  {
    start: 0.59,
    marker: "05",
    title: "Guard shell",
    text: "Three guards wrap the body: secrets never leave the box, destructive ops blocked at the shell, sacred state stays append-only. PreToolUse hooks fire before every command.",
    path: "scripts/state/{secret,exec,state}_guard.py",
  },
  {
    start: 0.73,
    marker: "06",
    title: "Output halo",
    text: "Cross-agent nervous system live — Telegram, email, SMS, dashboard feed all wired through the agent_events bus and the event-router daemon. The bridge spine connects to the operator's machine on port 9100.",
    path: "agent_events · scripts/core/event_router.py · telegram_agent.js · bravo_cli/bridge_chat_server.py",
  },
];

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

function ease(value: number) {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
}

function span(progress: number, start: number, end: number) {
  return ease((progress - start) / (end - start));
}

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function partStyle(
  progress: number,
  start: number,
  end: number,
  from: { x: number; y: number; rotate?: number; scale?: number },
): CSSProperties {
  const t = span(progress, start, end);
  const rotate = lerp(from.rotate ?? 0, 0, t);
  const scale = lerp(from.scale ?? 0.86, 1, t);

  return {
    opacity: lerp(0.16, 1, t),
    transform: `translate3d(${lerp(from.x, 0, t)}px, ${lerp(
      from.y,
      0,
      t,
    )}px, 0) rotate(${rotate}deg) scale(${scale})`,
  };
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

  const phase = useMemo(() => {
    return PHASES.reduce((active, item) =>
      progress >= item.start ? item : active,
    );
  }, [progress]);

  const glow = span(progress, 0.82, 1);

  return (
    <section
      ref={sectionRef}
      id="agent-build"
      className="agent-scroll relative z-10 min-h-[360vh] px-5 sm:px-8"
      style={{ "--agent-progress": progress } as CSSProperties}
    >
      <div className="sticky top-0 mx-auto grid min-h-screen max-w-7xl items-center gap-8 py-8 lg:grid-cols-[0.78fr_1.22fr]">
        <div className="max-w-xl pt-12 lg:pt-0">
          <div className="mb-5 inline-flex items-center gap-2 border-l border-emerald-300/[0.45] bg-emerald-300/[0.08] px-3 py-2 text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-100/[0.80]">
            <BrainCircuit className="h-3.5 w-3.5" />
            Build the agent first
          </div>

          <h1 className="max-w-2xl text-[clamp(2.35rem,4.4vw,4.8rem)] font-black leading-[0.94] tracking-tight text-white">
            Build the agent before you enter.
          </h1>

          <p className="mt-6 max-w-lg text-base leading-7 text-white/[0.66] sm:text-lg">
            Before signup, the system assembles a working operator around your
            business. Scroll to watch cognition, browser vision, memory, tools,
            automation, and guardrails lock into the body.
          </p>

          <div className="mt-8 border border-white/10 bg-white/[0.045] p-4 backdrop-blur-xl">
            <div className="flex items-center justify-between gap-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-emerald-200/[0.70]">
                Assembly {phase.marker}
              </div>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-emerald-200"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            </div>
            <h2 className="mt-3 text-xl font-black tracking-tight text-white">
              {phase.title}
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/[0.58]">
              {phase.text}
            </p>
            <p className="mt-3 font-mono text-[10px] leading-5 tracking-[0.14em] text-emerald-200/[0.62]">
              {phase.path}
            </p>
          </div>

          <div className="mt-6 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em] text-white/[0.42]">
            <span>Scroll to assemble</span>
            <span className="h-px w-16 bg-emerald-200/[0.35]" />
          </div>

          {progress > 0.88 && (
            <a
              href="#choose-agent"
              className="mt-8 inline-flex items-center gap-2 border border-emerald-200/[0.45] bg-emerald-200/[0.08] px-4 py-3 text-sm font-bold text-emerald-100 transition-all hover:border-emerald-200/[0.75] hover:bg-emerald-200/[0.14]"
            >
              Agent online — choose entry
              <ChevronDown className="h-4 w-4 animate-bounce" />
            </a>
          )}
        </div>

        <div className="relative min-h-[580px] lg:min-h-[760px]">
          <div className="android-stage" aria-hidden>
            <div className="android-ambient" />
            <div
              className="android-online"
              style={{ opacity: lerp(0, 1, glow) }}
            />
            <div className="android-blueprint" />

            <div
              className="android-part torso-shell"
              style={{ opacity: 0.55 }}
              aria-hidden
            >
              <div className="torso-ribs" />
            </div>

            <div
              className="android-part persona-ring"
              style={partStyle(progress, 0.10, 0.24, {
                x: 0,
                y: 0,
                rotate: -90,
                scale: 0.5,
              })}
              aria-hidden
            >
              {PERSONAS.map((name, index) => (
                <span
                  key={name}
                  className="persona-name"
                  style={{
                    transform: `rotate(${(index * 360) / PERSONAS.length}deg) translateY(-220px)`,
                  }}
                >
                  {name}
                </span>
              ))}
            </div>

            <div
              className="android-part cognition-core"
              style={partStyle(progress, 0.04, 0.18, {
                x: -260,
                y: 90,
                rotate: -18,
                scale: 0.78,
              })}
            >
              <Cpu className="h-5 w-5" />
              <span>Reasoning Core</span>
            </div>

            <div
              className="android-part state-pulse"
              style={partStyle(progress, 0.06, 0.20, {
                x: 0,
                y: -240,
                rotate: 0,
                scale: 0.5,
              })}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>State Pulse</span>
            </div>

            <div
              className="android-part codex-companion"
              style={partStyle(progress, 0.08, 0.22, {
                x: 240,
                y: 60,
                rotate: 22,
                scale: 0.6,
              })}
            >
              <Network className="h-3.5 w-3.5" />
              <span>Codex</span>
            </div>

            <div
              className="android-part head-shell"
              style={partStyle(progress, 0.18, 0.32, {
                x: 230,
                y: -210,
                rotate: 16,
                scale: 0.82,
              })}
            >
              <div className="visor">
                <Eye className="h-5 w-5" />
                <span>Browser Optics</span>
              </div>
            </div>

            <div
              className="android-part memory-spine"
              style={partStyle(progress, 0.32, 0.46, {
                x: -260,
                y: -10,
                rotate: -10,
                scale: 0.84,
              })}
            >
              <Database className="h-4 w-4" />
              <span>Memory Spine</span>
            </div>

            <div
              className="android-part capability-constellation"
              style={partStyle(progress, 0.34, 0.48, {
                x: 0,
                y: 240,
                rotate: 0,
                scale: 0.4,
              })}
              aria-hidden
            >
              <span className="constellation-dot c1" />
              <span className="constellation-dot c2" />
              <span className="constellation-dot c3" />
              <span className="constellation-dot c4" />
              <span className="constellation-dot c5" />
              <span className="constellation-dot c6" />
              <span className="constellation-dot c7" />
              <Sparkles className="constellation-icon h-3 w-3" />
            </div>

            <div
              className="android-part tool-arm left"
              style={partStyle(progress, 0.46, 0.60, {
                x: -320,
                y: 20,
                rotate: -24,
                scale: 0.82,
              })}
            >
              <Wrench className="h-4 w-4" />
              <span>Tool Limbs</span>
            </div>

            <div
              className="android-part guard-shell"
              style={partStyle(progress, 0.60, 0.74, {
                x: 260,
                y: 80,
                rotate: 12,
                scale: 0.9,
              })}
            >
              <ShieldCheck className="h-5 w-5" />
              <span>Guard Shell</span>
            </div>

            <div
              className="android-part reasoning-halo"
              style={partStyle(progress, 0.74, 0.92, {
                x: 0,
                y: -180,
                rotate: 0,
                scale: 0.48,
              })}
            >
              <Orbit className="h-4 w-4" />
              <span>Output Halo</span>
            </div>

            <div
              className="android-part bridge-spine"
              style={partStyle(progress, 0.80, 0.94, {
                x: 0,
                y: 80,
                rotate: 0,
                scale: 0.4,
              })}
              aria-hidden
            >
              <span className="bridge-line" />
              <span className="bridge-node" />
              <span className="bridge-label">localhost:9100</span>
            </div>

            {progress > 0.90 && (
              <div
                className="spec-overlay"
                aria-hidden
                style={{ opacity: span(progress, 0.90, 0.98) }}
              >
                <div className="spec-label spec-tl">
                  <span className="spec-tag">01 · State Pulse</span>
                  <span className="spec-path">empire_state.db</span>
                </div>
                <div className="spec-label spec-tr">
                  <span className="spec-tag">06 · Output Halo</span>
                  <span className="spec-path">agent_events bus</span>
                </div>
                <div className="spec-label spec-ml">
                  <span className="spec-tag">03 · Memory Spine</span>
                  <span className="spec-path">memory_retriever.py</span>
                </div>
                <div className="spec-label spec-mr">
                  <span className="spec-tag">02 · Browser Optics</span>
                  <span className="spec-path">browser_harness</span>
                </div>
                <div className="spec-label spec-bl">
                  <span className="spec-tag">04 · Tool Limbs</span>
                  <span className="spec-path">bridge_tools.py</span>
                </div>
                <div className="spec-label spec-br">
                  <span className="spec-tag">05 · Guard Shell</span>
                  <span className="spec-path">secret_guard.py</span>
                </div>
              </div>
            )}

            <div className="android-light one" />
            <div className="android-light two" />
            <div className="android-light three" />
            <div className="android-circuit a" />
            <div className="android-circuit b" />
            <div className="android-circuit c" />
          </div>
        </div>
      </div>

      <style>{`
        .android-stage {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          perspective: 1100px;
          filter: drop-shadow(0 0 54px rgba(52,211,153,0.18));
        }

        .android-ambient,
        .android-online,
        .android-blueprint,
        .android-part,
        .android-light,
        .android-circuit {
          position: absolute;
          left: 50%;
          top: 50%;
        }

        .android-ambient {
          width: min(74vw, 720px);
          height: min(74vw, 720px);
          border-radius: 9999px;
          transform: translate(-50%, -50%) rotateX(63deg);
          border: 1px solid rgba(52,211,153,0.2);
          background:
            radial-gradient(circle at 50% 50%, rgba(52,211,153,0.2), transparent 34%),
            radial-gradient(circle at 50% 50%, transparent 0 46%, rgba(52,211,153,0.18) 47% 47.5%, transparent 48%);
          animation: android-orbit 12s ease-in-out infinite;
        }

        .android-online {
          width: 280px;
          height: 380px;
          transform: translate(-50%, -50%);
          border-radius: 40%;
          background: radial-gradient(circle at 50% 38%, rgba(134,239,172,0.16), transparent 40%);
          filter: blur(26px);
          opacity: 0.7;
        }

        .android-blueprint {
          width: 260px;
          height: 560px;
          transform: translate(-50%, -48%);
          border: 1px dashed rgba(236,253,245,0.18);
          border-radius: 130px 130px 82px 82px;
          opacity: 0.5;
        }

        .android-part {
          color: rgba(236,253,245,0.92);
          border: 1px solid rgba(255,255,255,0.28);
          background:
            linear-gradient(135deg, rgba(255,255,255,0.14), rgba(255,255,255,0.04)),
            radial-gradient(circle at 50% 12%, rgba(52,211,153,0.18), transparent 46%);
          box-shadow:
            0 0 0 1px rgba(52,211,153,0.10),
            inset 0 0 24px rgba(255,255,255,0.06),
            0 28px 70px rgba(0,0,0,0.32);
          backdrop-filter: blur(14px);
          transition: opacity 120ms linear;
          will-change: transform, opacity;
        }

        .android-part span {
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: rgba(236,253,245,0.62);
        }

        .cognition-core {
          width: 92px;
          height: 92px;
          margin-left: -46px;
          margin-top: -46px;
          display: grid;
          place-items: center;
          border-radius: 9999px;
          background:
            radial-gradient(circle, rgba(236,253,245,0.96) 0 7%, rgba(52,211,153,0.42) 8% 35%, rgba(245,158,11,0.24) 36% 58%, transparent 59%),
            conic-gradient(from 90deg, rgba(52,211,153,0.9), rgba(245,158,11,0.62), rgba(52,211,153,0.9));
          box-shadow: 0 0 74px rgba(52,211,153,0.42);
        }

        .cognition-core span {
          position: absolute;
          bottom: -28px;
          width: max-content;
        }

        .head-shell {
          width: 178px;
          height: 128px;
          margin-left: -89px;
          margin-top: -232px;
          border-radius: 54px 54px 38px 38px;
          display: grid;
          place-items: center;
        }

        .head-shell:before,
        .head-shell:after {
          content: "";
          position: absolute;
          top: 46px;
          width: 8px;
          height: 40px;
          border-radius: 9999px;
          background: rgba(52,211,153,0.34);
          box-shadow: 0 0 18px rgba(52,211,153,0.38);
        }

        .head-shell:before {
          left: -13px;
        }

        .head-shell:after {
          right: -13px;
        }

        .visor {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 122px;
          height: 42px;
          justify-content: center;
          border-radius: 9999px;
          border: 1px solid rgba(52,211,153,0.32);
          background: rgba(52,211,153,0.12);
          box-shadow: inset 0 0 28px rgba(52,211,153,0.16);
        }

        .memory-spine {
          width: 56px;
          height: 284px;
          margin-left: -28px;
          margin-top: -122px;
          border-radius: 9999px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
        }

        .memory-spine:before {
          content: "";
          position: absolute;
          inset: 18px 23px;
          border-radius: 9999px;
          background: repeating-linear-gradient(
            to bottom,
            rgba(52,211,153,0.78) 0 8px,
            transparent 8px 20px
          );
        }

        .memory-spine span {
          position: absolute;
          left: -48px;
          top: 50%;
          transform: rotate(-90deg) translateX(50%);
          transform-origin: center;
          width: max-content;
        }

        .torso-shell {
          width: 212px;
          height: 286px;
          margin-left: -106px;
          margin-top: -88px;
          border-radius: 58px 58px 76px 76px;
        }

        .torso-ribs {
          position: absolute;
          inset: 24px;
          border-radius: 42px 42px 62px 62px;
          border: 1px solid rgba(52,211,153,0.18);
          background:
            linear-gradient(90deg, transparent 0 47%, rgba(52,211,153,0.18) 48% 52%, transparent 53%),
            repeating-linear-gradient(to bottom, transparent 0 34px, rgba(255,255,255,0.06) 35px 36px);
        }

        .tool-arm {
          width: 186px;
          height: 74px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 9px;
          border-radius: 9999px;
        }

        .tool-arm.left {
          margin-left: -93px;
          margin-top: 130px;
        }

        .tool-arm:after {
          content: "";
          position: absolute;
          width: 42px;
          height: 42px;
          border-radius: 9999px;
          border: 1px solid rgba(52,211,153,0.18);
          background: rgba(52,211,153,0.08);
          left: 50%;
          transform: translateX(-50%);
          bottom: -52px;
          opacity: 0.6;
        }

        .guard-shell {
          width: 282px;
          height: 360px;
          margin-left: -141px;
          margin-top: -118px;
          display: flex;
          align-items: flex-end;
          justify-content: center;
          gap: 9px;
          padding-bottom: 22px;
          border-radius: 92px;
          border-color: rgba(134,239,172,0.24);
          background:
            linear-gradient(135deg, rgba(134,239,172,0.08), rgba(255,255,255,0.02)),
            radial-gradient(circle at 50% 32%, rgba(52,211,153,0.16), transparent 50%);
          pointer-events: none;
        }

        .reasoning-halo {
          width: 470px;
          height: 470px;
          margin-left: -235px;
          margin-top: -250px;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          gap: 8px;
          padding-top: 28px;
          border-radius: 9999px;
          background:
            radial-gradient(circle, transparent 0 58%, rgba(52,211,153,0.09) 59% 60%, transparent 61%),
            conic-gradient(from 0deg, transparent, rgba(52,211,153,0.18), transparent, rgba(245,158,11,0.12), transparent);
          animation: reasoning-spin 18s linear infinite;
        }

        .state-pulse {
          width: 92px;
          height: 30px;
          margin-left: -46px;
          margin-top: -88px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          border-radius: 9999px;
          background:
            linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.05)),
            radial-gradient(circle at 50% 50%, rgba(245,158,11,0.16), transparent 60%);
          border-color: rgba(245,158,11,0.32);
          box-shadow:
            0 0 0 1px rgba(245,158,11,0.18),
            0 0 32px rgba(245,158,11,0.22);
        }

        .state-pulse:before {
          content: "";
          position: absolute;
          left: 8px;
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background: rgba(245,158,11,0.92);
          box-shadow: 0 0 12px rgba(245,158,11,0.78);
          animation: state-blink 1.4s ease-in-out infinite;
        }

        .state-pulse span {
          color: rgba(245,158,11,0.88);
        }

        .codex-companion {
          width: 58px;
          height: 58px;
          margin-left: 80px;
          margin-top: -29px;
          display: grid;
          place-items: center;
          gap: 4px;
          border-radius: 9999px;
          background:
            radial-gradient(circle, rgba(236,253,245,0.84) 0 8%, rgba(124,140,247,0.42) 9% 36%, rgba(124,140,247,0.18) 37% 60%, transparent 61%),
            conic-gradient(from 90deg, rgba(124,140,247,0.78), rgba(180,200,255,0.42), rgba(124,140,247,0.78));
          border-color: rgba(124,140,247,0.42);
          box-shadow:
            0 0 0 1px rgba(124,140,247,0.22),
            0 0 38px rgba(124,140,247,0.34);
        }

        .codex-companion span {
          position: absolute;
          bottom: -22px;
          width: max-content;
          color: rgba(180,200,255,0.78);
        }

        .persona-ring {
          width: 540px;
          height: 540px;
          margin-left: -270px;
          margin-top: -270px;
          border-radius: 9999px;
          border: 1px dashed rgba(52,211,153,0.32);
          background: transparent;
          box-shadow: none;
          backdrop-filter: none;
          animation: persona-spin 38s linear infinite;
        }

        .persona-ring .persona-name {
          position: absolute;
          left: 50%;
          top: 50%;
          margin-left: -28px;
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.32em;
          color: rgba(236,253,245,0.62);
          text-transform: uppercase;
          transform-origin: center;
        }

        .capability-constellation {
          width: 200px;
          height: 64px;
          margin-left: -100px;
          margin-top: 216px;
          border-radius: 18px;
          background: transparent;
          border-color: rgba(52,211,153,0.18);
          box-shadow: none;
          backdrop-filter: none;
        }

        .capability-constellation .constellation-icon {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          color: rgba(236,253,245,0.78);
        }

        .constellation-dot {
          position: absolute;
          width: 4px;
          height: 4px;
          border-radius: 9999px;
          background: rgba(134,239,172,0.92);
          box-shadow: 0 0 8px rgba(52,211,153,0.78);
          animation: constellation-flicker 3.2s ease-in-out infinite;
        }

        .constellation-dot.c1 { left: 18%; top: 22%; animation-delay: 0s; }
        .constellation-dot.c2 { left: 36%; top: 70%; animation-delay: 0.4s; }
        .constellation-dot.c3 { left: 54%; top: 14%; animation-delay: 0.8s; }
        .constellation-dot.c4 { left: 70%; top: 64%; animation-delay: 1.2s; }
        .constellation-dot.c5 { left: 86%; top: 32%; animation-delay: 1.6s; }
        .constellation-dot.c6 { left: 24%; top: 88%; animation-delay: 2s; }
        .constellation-dot.c7 { left: 62%; top: 88%; animation-delay: 2.4s; }

        .bridge-spine {
          width: 12px;
          height: 86px;
          margin-left: -6px;
          margin-top: 296px;
          border-radius: 0;
          border: none;
          background: transparent;
          box-shadow: none;
          backdrop-filter: none;
        }

        .bridge-line {
          position: absolute;
          left: 50%;
          top: 0;
          width: 1px;
          height: 100%;
          background: linear-gradient(to bottom, rgba(52,211,153,0.72), transparent);
          transform: translateX(-50%);
        }

        .bridge-node {
          position: absolute;
          left: 50%;
          bottom: 8px;
          width: 12px;
          height: 12px;
          border-radius: 9999px;
          background: rgba(52,211,153,0.42);
          border: 1px solid rgba(52,211,153,0.62);
          box-shadow: 0 0 18px rgba(52,211,153,0.62);
          transform: translateX(-50%);
        }

        .bridge-label {
          position: absolute;
          left: 50%;
          bottom: -22px;
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.18em;
          color: rgba(52,211,153,0.78);
          text-transform: uppercase;
          transform: translateX(-50%);
          white-space: nowrap;
        }

        @keyframes state-blink {
          0%, 100% { opacity: 0.45; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1.15); }
        }

        @keyframes persona-spin {
          from { rotate: 0deg; }
          to { rotate: 360deg; }
        }

        @keyframes constellation-flicker {
          0%, 100% { opacity: 0.32; transform: scale(0.7); }
          50% { opacity: 1; transform: scale(1.2); }
        }

        .android-light {
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          background: rgba(236,253,245,0.92);
          box-shadow: 0 0 20px rgba(52,211,153,0.88);
          opacity: calc(0.18 + (var(--agent-progress) * 0.78));
        }

        .android-light.one {
          transform: translate(-50%, -50%) translate(-112px, -206px);
        }

        .android-light.two {
          transform: translate(-50%, -50%) translate(112px, -206px);
        }

        .android-light.three {
          transform: translate(-50%, -50%) translate(0, -46px);
        }

        .android-circuit {
          height: 1px;
          width: 260px;
          transform-origin: left center;
          background: linear-gradient(90deg, transparent, rgba(52,211,153,0.62), transparent);
          opacity: calc(0.08 + (var(--agent-progress) * 0.42));
        }

        .android-circuit.a {
          transform: translate(-50%, -50%) translate(-242px, -126px) rotate(24deg);
        }

        .android-circuit.b {
          transform: translate(-50%, -50%) translate(72px, -18px) rotate(-18deg);
        }

        .android-circuit.c {
          transform: translate(-50%, -50%) translate(-168px, 162px) rotate(-12deg);
        }

        @keyframes android-orbit {
          0%, 100% {
            transform: translate(-50%, -50%) rotateX(63deg) rotateZ(0deg);
          }
          50% {
            transform: translate(-50%, -50%) rotateX(68deg) rotateZ(7deg);
          }
        }

        @keyframes reasoning-spin {
          from {
            rotate: 0deg;
          }
          to {
            rotate: 360deg;
          }
        }

        .spec-overlay {
          position: absolute;
          inset: 0;
          pointer-events: none;
          transition: opacity 240ms ease-out;
        }

        .spec-label {
          position: absolute;
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 6px 10px;
          background: rgba(3, 7, 10, 0.62);
          border: 1px solid rgba(52,211,153,0.32);
          backdrop-filter: blur(6px);
        }

        .spec-label:before {
          content: "";
          position: absolute;
          height: 1px;
          background: linear-gradient(to right, rgba(52,211,153,0.62), rgba(52,211,153,0.08));
          width: 60px;
        }

        .spec-tag {
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: rgba(236,253,245,0.92);
        }

        .spec-path {
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 8px;
          letter-spacing: 0.06em;
          color: rgba(52,211,153,0.76);
        }

        .spec-tl { top: 6%; left: 4%; }
        .spec-tl:before { right: -60px; top: 50%; }

        .spec-tr { top: 6%; right: 4%; }
        .spec-tr:before { left: -60px; top: 50%; background: linear-gradient(to left, rgba(52,211,153,0.62), rgba(52,211,153,0.08)); }

        .spec-ml { top: 42%; left: 0%; }
        .spec-ml:before { right: -60px; top: 50%; }

        .spec-mr { top: 42%; right: 0%; }
        .spec-mr:before { left: -60px; top: 50%; background: linear-gradient(to left, rgba(52,211,153,0.62), rgba(52,211,153,0.08)); }

        .spec-bl { bottom: 6%; left: 4%; }
        .spec-bl:before { right: -60px; top: 50%; }

        .spec-br { bottom: 6%; right: 4%; }
        .spec-br:before { left: -60px; top: 50%; background: linear-gradient(to left, rgba(52,211,153,0.62), rgba(52,211,153,0.08)); }

        @media (max-width: 1023px) {
          .agent-scroll {
            min-height: 430vh;
          }

          .android-stage {
            transform: translateY(-70px) scale(0.76);
          }

          .spec-overlay {
            display: none;
          }
        }

        @media (max-width: 640px) {
          .agent-scroll {
            min-height: 470vh;
          }

          .android-stage {
            transform: translateY(-150px) scale(0.58);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .android-ambient,
          .reasoning-halo {
            animation: none !important;
          }
        }
      `}</style>
    </section>
  );
}
