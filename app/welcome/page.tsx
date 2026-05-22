import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  Download,
  LogIn,
  ScrollText,
} from "lucide-react";
import { OasisLogo } from "@/components/brand/OasisLogo";
import { getSessionUser } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const BUILD_STEPS = [
  {
    label: "Profile",
    text: "Your business, voice, goals, and operating context become the agent's starting memory.",
  },
  {
    label: "Tools",
    text: "The Command Centre connects chat, records, automations, browser work, and your local desktop bridge.",
  },
  {
    label: "Agents",
    text: "Pick the operator you want first, then add the rest of the crew as your company grows.",
  },
];

export default async function WelcomePage() {
  const user = await getSessionUser().catch(() => null);
  if (user) redirect("/");

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#03070a] text-fg">
      <div aria-hidden className="absolute inset-0 welcome-depth" />
      <div aria-hidden className="absolute inset-0 welcome-grid" />

      <header className="relative z-20 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 sm:px-8">
        <Link href="/welcome" className="flex items-center gap-3">
          <OasisLogo size={34} priority />
          <span className="leading-none">
            <span className="block text-[11px] font-black uppercase tracking-[0.2em] text-white">
              OASIS AI
            </span>
            <span className="block text-[9px] uppercase tracking-[0.26em] text-white/[0.45]">
              Command Centre
            </span>
          </span>
        </Link>

        <nav className="flex items-center gap-3 text-xs">
          <Link
            href="/command-centre-explained"
            className="hidden rounded-full border border-white/[0.12] bg-white/[0.05] px-3 py-2 font-mono uppercase tracking-[0.14em] text-white/[0.62] transition-colors hover:border-emerald-300/[0.35] hover:text-emerald-100 sm:inline-flex"
          >
            Full explanation
          </Link>
          <Link
            href="/login?next=/agents"
            className="rounded-full border border-white/[0.12] bg-white/[0.07] px-3 py-2 font-semibold text-white/[0.76] transition-colors hover:border-white/[0.25] hover:text-white"
          >
            Sign in
          </Link>
        </nav>
      </header>

      <section className="relative z-10 mx-auto grid min-h-[calc(100vh-84px)] max-w-7xl items-center gap-10 px-5 pb-12 pt-8 sm:px-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="max-w-2xl">
          <div className="mb-6 inline-flex items-center gap-2 border-l border-emerald-300/[0.45] bg-emerald-300/[0.08] px-3 py-2 text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-100/[0.80]">
            <BrainCircuit className="h-3.5 w-3.5" />
            Build the agent first
          </div>

          <h1 className="max-w-3xl text-[clamp(3.2rem,8.4vw,7.9rem)] font-black leading-[0.9] tracking-tight text-white">
            Command Centre for agents that actually work.
          </h1>

          <p className="mt-7 max-w-xl text-lg leading-8 text-white/[0.68] sm:text-xl">
            This is not a generic chatbot login. Before you enter, you build the
            agent around your business: what it should know, what it should run,
            which tools it can touch, and how it should help you make money.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="#choose-agent"
              className="group inline-flex h-12 items-center gap-2 rounded-md border border-emerald-200/[0.35] bg-emerald-200 px-5 text-sm font-black text-[#03110d] shadow-[0_0_36px_-10px_rgba(52,211,153,0.95)] transition-transform hover:-translate-y-0.5"
            >
              Enter the Command Centre
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Link>
            <Link
              href="/command-centre-explained"
              className="inline-flex h-12 items-center gap-2 rounded-md border border-white/[0.12] bg-white/[0.06] px-5 text-sm font-semibold text-white/[0.78] backdrop-blur-xl transition-colors hover:border-white/[0.25] hover:text-white"
            >
              <ScrollText className="h-4 w-4" />
              See how it works
            </Link>
          </div>

          <div className="mt-8 grid max-w-xl gap-2 sm:grid-cols-3">
            {BUILD_STEPS.map((step, i) => (
              <div
                key={step.label}
                className="border border-white/10 bg-white/[0.045] p-3 backdrop-blur"
              >
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-200/[0.70]">
                  0{i + 1} {step.label}
                </div>
                <p className="mt-2 text-xs leading-5 text-white/[0.54]">{step.text}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="relative min-h-[520px] lg:min-h-[690px]">
          <AgentAssemblyVisual />
        </div>
      </section>

      <section
        id="choose-agent"
        className="relative z-10 mx-auto max-w-7xl px-5 pb-24 pt-8 sm:px-8"
      >
        <div className="border-t border-white/10 pt-12">
          <div className="max-w-2xl">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-200/[0.70]">
              Entry path
            </div>
            <h2 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-5xl">
              Which agent do you want to select?
            </h2>
            <p className="mt-4 text-base leading-7 text-white/[0.60]">
              Start with a custom build, jump back into an existing workspace,
              or install the desktop app so the agent can run on your machine.
            </p>
          </div>

          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            <EntryChoice
              href="/configure"
              icon={<Bot className="h-5 w-5" />}
              label="Build your own agent"
              summary="Answer the personalization questions first. The configurator produces the install path and carries you into account creation after the agent blueprint is ready."
              action="Start build"
              primary
            />
            <EntryChoice
              href="/login?next=/agents"
              icon={<LogIn className="h-5 w-5" />}
              label="Sign in automatically"
              summary="Already have a workspace? Sign in and land directly on the Agents surface instead of seeing the generic dashboard first."
              action="Sign in"
            />
            <EntryChoice
              href="/download"
              icon={<Download className="h-5 w-5" />}
              label="Download the desktop app"
              summary="Install the local bridge so the Command Centre can use your machine, your files, your automations, and your model subscriptions."
              action="Download"
            />
          </div>
        </div>
      </section>

      <style>{`
        html {
          scroll-behavior: smooth;
        }

        .welcome-depth {
          background:
            radial-gradient(circle at 70% 38%, rgba(52, 211, 153, 0.18), transparent 32%),
            radial-gradient(circle at 82% 76%, rgba(245, 158, 11, 0.1), transparent 24%),
            radial-gradient(circle at 16% 72%, rgba(59, 130, 246, 0.12), transparent 34%),
            linear-gradient(180deg, #05080d 0%, #020405 100%);
        }

        .welcome-grid {
          opacity: 0.55;
          background-image:
            linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
          background-size: 64px 64px;
          mask-image: radial-gradient(ellipse 82% 70% at 62% 44%, black 16%, transparent 82%);
          -webkit-mask-image: radial-gradient(ellipse 82% 70% at 62% 44%, black 16%, transparent 82%);
          animation: grid-breathe 8s ease-in-out infinite;
        }

        .assembly-stage {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          filter: drop-shadow(0 0 58px rgba(52,211,153,0.18));
        }

        .assembly-ring,
        .assembly-core,
        .assembly-part,
        .assembly-scan,
        .assembly-line,
        .assembly-pulse {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
        }

        .assembly-ring {
          border-radius: 9999px;
          border: 1px solid rgba(255,255,255,0.12);
          box-shadow: inset 0 0 44px rgba(52,211,153,0.06);
        }

        .assembly-ring.outer {
          width: min(82vw, 660px);
          height: min(82vw, 660px);
          animation: ring-tilt 10s ease-in-out infinite;
        }

        .assembly-ring.middle {
          width: min(58vw, 470px);
          height: min(58vw, 470px);
          border-color: rgba(52,211,153,0.24);
          animation: ring-tilt 12s ease-in-out infinite reverse;
        }

        .assembly-ring.inner {
          width: min(34vw, 270px);
          height: min(34vw, 270px);
          border-color: rgba(245,158,11,0.24);
          animation: ring-pulse 4.5s ease-in-out infinite;
        }

        .assembly-core {
          width: 168px;
          height: 212px;
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 46px 46px 58px 58px;
          background:
            radial-gradient(circle at 50% 22%, rgba(52,211,153,0.28), transparent 38%),
            linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02));
          box-shadow:
            0 0 0 1px rgba(52,211,153,0.14),
            0 0 70px rgba(52,211,153,0.22),
            inset 0 0 54px rgba(255,255,255,0.05);
          backdrop-filter: blur(16px);
        }

        .assembly-core:before {
          content: "";
          position: absolute;
          left: 50%;
          top: 28px;
          width: 68px;
          height: 68px;
          border-radius: 9999px;
          transform: translateX(-50%);
          border: 1px solid rgba(52,211,153,0.34);
          background:
            radial-gradient(circle, rgba(236,253,245,0.9) 0 10%, rgba(52,211,153,0.28) 11% 38%, transparent 39%),
            conic-gradient(from 0deg, rgba(52,211,153,0.9), transparent, rgba(245,158,11,0.65), transparent, rgba(52,211,153,0.9));
          animation: brain-spin 8s linear infinite;
        }

        .assembly-core:after {
          content: "AGENT CORE";
          position: absolute;
          left: 50%;
          bottom: 34px;
          transform: translateX(-50%);
          width: max-content;
          font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.18em;
          color: rgba(255,255,255,0.72);
        }

        .assembly-pulse {
          width: 230px;
          height: 230px;
          border-radius: 9999px;
          border: 1px solid rgba(52,211,153,0.22);
          animation: core-pulse 2.8s ease-out infinite;
        }

        .assembly-part {
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          box-shadow: 0 0 28px rgba(52,211,153,0.14), inset 0 0 22px rgba(255,255,255,0.05);
          backdrop-filter: blur(12px);
        }

        .assembly-part.left {
          width: 120px;
          height: 38px;
          border-radius: 9999px;
          animation: assemble-left 4.8s ease-in-out infinite;
        }

        .assembly-part.right {
          width: 132px;
          height: 38px;
          border-radius: 9999px;
          animation: assemble-right 4.8s ease-in-out infinite;
          animation-delay: -0.7s;
        }

        .assembly-part.top {
          width: 92px;
          height: 52px;
          border-radius: 22px;
          border-color: rgba(245,158,11,0.28);
          animation: assemble-top 4.8s ease-in-out infinite;
          animation-delay: -1.4s;
        }

        .assembly-part.bottom {
          width: 112px;
          height: 46px;
          border-radius: 18px 18px 32px 32px;
          animation: assemble-bottom 4.8s ease-in-out infinite;
          animation-delay: -2.1s;
        }

        .assembly-scan {
          width: min(72vw, 600px);
          height: min(72vw, 600px);
          border-radius: 9999px;
          background: conic-gradient(from 0deg, transparent 0deg, transparent 290deg, rgba(52,211,153,0.55) 330deg, transparent 360deg);
          mask-image: radial-gradient(circle, transparent 0 48%, black 49% 51%, transparent 52%);
          -webkit-mask-image: radial-gradient(circle, transparent 0 48%, black 49% 51%, transparent 52%);
          animation: scan-spin 5.2s linear infinite;
        }

        .assembly-line {
          height: 1px;
          width: 42%;
          transform-origin: left center;
          background: linear-gradient(90deg, transparent, rgba(52,211,153,0.7), transparent);
          opacity: 0;
          animation: line-flash 3.8s ease-in-out infinite;
        }

        .assembly-line.one {
          left: 25%;
          top: 36%;
          transform: rotate(22deg);
        }

        .assembly-line.two {
          left: 56%;
          top: 67%;
          transform: rotate(-28deg);
          animation-delay: -1.6s;
        }

        .assembly-line.three {
          left: 31%;
          top: 71%;
          transform: rotate(-10deg);
          animation-delay: -2.6s;
        }

        @keyframes assemble-left {
          0%, 100% { transform: translate(-50%, -50%) translate(-255px, -40px); opacity: 0.38; }
          44%, 64% { transform: translate(-50%, -50%) translate(-102px, -22px); opacity: 1; }
        }

        @keyframes assemble-right {
          0%, 100% { transform: translate(-50%, -50%) translate(270px, 54px); opacity: 0.36; }
          44%, 64% { transform: translate(-50%, -50%) translate(112px, 32px); opacity: 1; }
        }

        @keyframes assemble-top {
          0%, 100% { transform: translate(-50%, -50%) translate(32px, -250px); opacity: 0.34; }
          44%, 64% { transform: translate(-50%, -50%) translate(0, -122px); opacity: 1; }
        }

        @keyframes assemble-bottom {
          0%, 100% { transform: translate(-50%, -50%) translate(-38px, 260px); opacity: 0.34; }
          44%, 64% { transform: translate(-50%, -50%) translate(0, 134px); opacity: 1; }
        }

        @keyframes ring-tilt {
          0%, 100% { transform: translate(-50%, -50%) rotateX(58deg) rotateZ(0deg); }
          50% { transform: translate(-50%, -50%) rotateX(64deg) rotateZ(8deg); }
        }

        @keyframes ring-pulse {
          0%, 100% { opacity: 0.55; transform: translate(-50%, -50%) scale(1); }
          50% { opacity: 1; transform: translate(-50%, -50%) scale(1.045); }
        }

        @keyframes brain-spin {
          from { transform: translateX(-50%) rotate(0deg); }
          to { transform: translateX(-50%) rotate(360deg); }
        }

        @keyframes core-pulse {
          0% { opacity: 0.65; transform: translate(-50%, -50%) scale(0.78); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(1.35); }
        }

        @keyframes scan-spin {
          from { transform: translate(-50%, -50%) rotate(0deg); }
          to { transform: translate(-50%, -50%) rotate(360deg); }
        }

        @keyframes line-flash {
          0%, 48%, 100% { opacity: 0; transform: scaleX(0.35); }
          54% { opacity: 0.8; transform: scaleX(1); }
          66% { opacity: 0; transform: scaleX(1.15); }
        }

        @keyframes grid-breathe {
          0%, 100% { opacity: 0.44; }
          50% { opacity: 0.76; }
        }

        @media (max-width: 1023px) {
          .assembly-stage {
            opacity: 0.72;
          }
        }

        @media (max-width: 640px) {
          .assembly-ring.outer {
            width: 360px;
            height: 360px;
          }

          .assembly-ring.middle {
            width: 260px;
            height: 260px;
          }

          .assembly-ring.inner {
            width: 160px;
            height: 160px;
          }

          .assembly-core {
            width: 132px;
            height: 172px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .welcome-grid,
          .assembly-ring,
          .assembly-core:before,
          .assembly-pulse,
          .assembly-part,
          .assembly-scan,
          .assembly-line {
            animation: none !important;
          }
        }
      `}</style>
    </main>
  );
}

function AgentAssemblyVisual() {
  return (
    <div className="assembly-stage" aria-hidden>
      <div className="assembly-ring outer" />
      <div className="assembly-ring middle" />
      <div className="assembly-ring inner" />
      <div className="assembly-scan" />
      <div className="assembly-pulse" />
      <div className="assembly-core" />
      <div className="assembly-part left" />
      <div className="assembly-part right" />
      <div className="assembly-part top" />
      <div className="assembly-part bottom" />
      <div className="assembly-line one" />
      <div className="assembly-line two" />
      <div className="assembly-line three" />
    </div>
  );
}

function EntryChoice({
  href,
  icon,
  label,
  summary,
  action,
  primary = false,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  summary: string;
  action: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group flex min-h-64 flex-col justify-between border p-5 transition-all ${
        primary
          ? "border-emerald-200/[0.35] bg-emerald-200/[0.08] shadow-[0_0_42px_-20px_rgba(52,211,153,0.8)] hover:border-emerald-200/[0.60]"
          : "border-white/10 bg-white/[0.045] hover:border-white/[0.22] hover:bg-white/[0.07]"
      }`}
    >
      <div>
        <div
          className={`mb-5 flex h-11 w-11 items-center justify-center rounded-md border ${
            primary
              ? "border-emerald-200/[0.35] bg-emerald-200/[0.14] text-emerald-100"
              : "border-white/[0.12] bg-white/[0.06] text-white/[0.72]"
          }`}
        >
          {icon}
        </div>
        <h3 className="text-xl font-black tracking-tight text-white">{label}</h3>
        <p className="mt-3 text-sm leading-6 text-white/[0.58]">{summary}</p>
      </div>
      <div className="mt-8 inline-flex items-center gap-2 text-sm font-bold text-emerald-100">
        {action}
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
      </div>
    </Link>
  );
}
