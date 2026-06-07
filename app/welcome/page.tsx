import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Bot, Download, LogIn } from "lucide-react";
import { OasisLogo } from "@/components/brand/OasisLogo";
import { HeroBackdrop } from "@/components/landing/HeroBackdrop";
import { AuthRedirectGuard } from "@/components/AuthRedirectGuard";
import { getSessionUser } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * /welcome — V7 landing page.
 *
 * Single-viewport composition: animated cosmic backdrop + centered
 * headline + 3 entry-choice cards in a row. No scroll mechanic, no
 * WebGL — just a beautiful atmosphere with a clean call-to-action.
 *
 * Replaces the V1-V6 scroll-assembly experiments that kept failing to
 * land visually.
 */

export default async function WelcomePage() {
  const user = await getSessionUser().catch(() => null);
  if (user) redirect("/");

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#02050a] text-fg">
      {/* SSR-vs-cookie race guard — bounces a signed-in user into the
          app even if the just-set auth cookie missed the SSR pass.
          (CC reported 2026-05-24.) */}
      <AuthRedirectGuard to="/" />

      {/* Animated atmosphere — fixed under the entire viewport */}
      <HeroBackdrop />

      {/* Header */}
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

      {/* Centered hero — flex-col vertically centred between header and viewport bottom */}
      <section className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center px-5 pb-16 pt-6 sm:px-8 sm:pt-12">
        <div className="mb-5 inline-flex items-center gap-2 border-l border-emerald-300/[0.45] bg-emerald-300/[0.08] px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-100/[0.85] backdrop-blur-md">
          Pick your entry path
        </div>

        <h1 className="text-center text-[clamp(2.4rem,7vw,5.5rem)] font-black leading-[0.94] tracking-tight text-white">
          Build the agent
          <br />
          <span className="bg-gradient-to-br from-emerald-200 via-emerald-300 to-teal-300 bg-clip-text text-transparent">
            before you enter.
          </span>
        </h1>

        <p className="mt-6 max-w-2xl text-center text-base leading-7 text-white/[0.68] sm:text-lg sm:leading-8">
          OASIS assembles reasoning, memory, vision, tools, guardrails, and
          security into a working operator. Pick how you want to begin.
        </p>

        {/* 3 entry choices — single row on desktop, stacked on mobile */}
        <div className="mt-10 grid w-full max-w-5xl gap-4 sm:mt-12 lg:grid-cols-3">
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
      </section>
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
      className={`group flex min-h-[16rem] flex-col justify-between rounded-xl border p-5 backdrop-blur-sm transition-all sm:min-h-[18rem] ${
        primary
          ? "border-emerald-200/[0.35] bg-emerald-300/[0.06] shadow-[0_0_42px_-18px_rgba(52,211,153,0.85)] hover:border-emerald-200/[0.6] hover:bg-emerald-300/[0.1]"
          : "border-white/10 bg-white/[0.045] hover:border-white/[0.22] hover:bg-white/[0.075]"
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
        <h3 className="text-lg font-black tracking-tight text-white sm:text-xl">{label}</h3>
        <p className="mt-3 text-sm leading-6 text-white/[0.58]">{summary}</p>
      </div>
      <div className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-emerald-100">
        {action}
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
      </div>
    </Link>
  );
}
