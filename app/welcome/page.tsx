import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Bot, Download, LogIn } from "lucide-react";
import { OasisLogo } from "@/components/brand/OasisLogo";
import { AgentAssemblyScrollScene } from "@/components/landing/AgentAssemblyScrollScene";
import { getSessionUser } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const user = await getSessionUser().catch(() => null);
  if (user) redirect("/");

  return (
    <main className="relative min-h-screen bg-[#03070a] text-fg">
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 welcome-depth" />
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 welcome-grid" />

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

      <AgentAssemblyScrollScene />

      <section
        id="choose-agent"
        className="relative z-10 mx-auto max-w-7xl px-5 pb-24 pt-16 sm:px-8"
      >
        <div className="border-t border-white/10 pt-12">
          <div className="max-w-2xl">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-200/[0.70]">
              Agent online
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

        @keyframes grid-breathe {
          0%, 100% { opacity: 0.44; }
          50% { opacity: 0.76; }
        }
      `}</style>
    </main>
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
