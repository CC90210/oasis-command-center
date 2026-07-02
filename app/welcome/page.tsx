import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Bot, Download, LogIn } from "lucide-react";
import { OasisLogo } from "@/components/brand/OasisLogo";
import { HeroBackdrop } from "@/components/landing/HeroBackdrop";
import { AuthRedirectGuard } from "@/components/AuthRedirectGuard";
import { getSessionUser } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * /welcome — V7.1 single-viewport landing page.
 *
 * STRICT no-scroll requirement (per CC, 2026-06-08): the page is locked
 * to `h-screen overflow-hidden` and all content sized to fit any
 * viewport from a 360px phone up. There is no scrollbar, no `min-h-`
 * fallback that lets content push the page taller, and no anchor
 * navigation. If you add content here later, shrink something else.
 *
 * Replaces the V1-V6 scroll-assembly experiments + the V7 page that
 * still allowed native scroll on tall content. Also removes the link
 * to `/command-centre-explained` (route deleted 2026-06-08).
 */

export default async function WelcomePage() {
  const user = await getSessionUser().catch(() => null);
  if (user) redirect("/");

  return (
    <main className="relative min-h-screen w-full overflow-x-hidden bg-[#02050a] text-fg md:h-screen md:overflow-hidden">
      {/* SSR-vs-cookie race guard — bounces a signed-in user into the
          app even if the just-set auth cookie missed the SSR pass.
          (CC reported 2026-05-24.) */}
      <AuthRedirectGuard to="/" />

      {/* Fixed animated atmosphere — sits under everything */}
      <HeroBackdrop />

      {/* Flex column — natural scroll on mobile, locked single-viewport on md+ */}
      <div className="relative z-10 flex min-h-screen w-full flex-col md:h-full md:min-h-0">
        {/* Header */}
        <header className="mx-auto flex w-full max-w-7xl shrink-0 items-center justify-between px-5 py-4 sm:px-8 sm:py-5">
          <Link href="/welcome" className="flex items-center gap-3">
            <OasisLogo size={32} priority />
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
              href="/login"
              className="rounded-full border border-white/[0.12] bg-white/[0.07] px-3 py-2 font-semibold text-white/[0.76] transition-colors hover:border-white/[0.25] hover:text-white"
            >
              Sign in
            </Link>
          </nav>
        </header>

        {/* Centred hero — flex-1 so it fills remaining vertical space on md+,
            content can grow naturally on mobile (where main allows scroll). */}
        <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-5 pb-8 pt-6 sm:px-8 sm:pb-10 md:overflow-hidden md:pt-0">
          <div className="welcome-fade mb-3 inline-flex shrink-0 items-center gap-2 border-l border-emerald-300/[0.45] bg-emerald-300/[0.08] px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.22em] text-emerald-100/[0.85] backdrop-blur-md sm:mb-4">
            Pick your entry path
          </div>

          <h1 className="welcome-fade welcome-fade-d1 shrink-0 text-center text-[clamp(2rem,5.5vw,4.4rem)] font-black leading-[0.98] tracking-tight text-white">
            Build the agent
            <br />
            <span className="welcome-shimmer bg-clip-text text-transparent drop-shadow-[0_0_28px_rgba(134,239,172,0.22)]">
              before you enter.
            </span>
          </h1>

          <p className="welcome-fade welcome-fade-d2 mt-4 max-w-xl shrink-0 text-center text-[14px] leading-6 text-white/[0.66] sm:mt-5 sm:text-base sm:leading-7">
            OASIS assembles reasoning, memory, vision, tools, guardrails, and
            security into a working operator. Pick how you want to begin.
          </p>

          {/* 3 entry choices — 3-col from tablet up, stacked on phone */}
          <div className="mt-6 grid w-full max-w-5xl shrink-0 gap-3 sm:mt-8 sm:gap-4 md:grid-cols-3">
            <EntryChoice
              href="/configure"
              icon={<Bot className="h-5 w-5" />}
              label="Build your own agent"
              summary="Answer the personalization questions. The configurator produces the install path and carries you into account creation."
              action="Start build"
              primary
              delayClass="welcome-fade-d3"
            />
            <EntryChoice
              href="/login"
              icon={<LogIn className="h-5 w-5" />}
              label="Sign in automatically"
              summary="Already have a workspace? Sign in and land on your Command Centre."
              action="Sign in"
              delayClass="welcome-fade-d4"
            />
            <EntryChoice
              href="/download"
              icon={<Download className="h-5 w-5" />}
              label="Download the desktop app"
              summary="Install the local bridge so the Command Centre can use your machine, files, and automations."
              action="Download"
              delayClass="welcome-fade-d5"
            />
          </div>
        </section>
      </div>

      {/* Local styles — entrance fade stagger + gradient shimmer + card
          hover lift. All respect prefers-reduced-motion. */}
      <style>{`
        .welcome-fade {
          opacity: 0;
          transform: translateY(12px);
          animation: welcome-fade-in 0.7s cubic-bezier(.2,.7,.2,1) forwards;
        }
        .welcome-fade-d1 { animation-delay: 0.08s; }
        .welcome-fade-d2 { animation-delay: 0.18s; }
        .welcome-fade-d3 { animation-delay: 0.32s; }
        .welcome-fade-d4 { animation-delay: 0.42s; }
        .welcome-fade-d5 { animation-delay: 0.52s; }
        @keyframes welcome-fade-in {
          to { opacity: 1; transform: translateY(0); }
        }

        /* Shimmer on the gradient headline. Background is 3x text width so
           the gradient stripe slowly slides across without ever blanking. */
        .welcome-shimmer {
          background-image: linear-gradient(
            110deg,
            #a7f3d0 0%,
            #86efac 22%,
            #5eead4 44%,
            #67e8f9 56%,
            #86efac 78%,
            #a7f3d0 100%
          );
          background-size: 280% 100%;
          background-position: 0% 50%;
          animation: welcome-shimmer 9s ease-in-out infinite;
        }
        @keyframes welcome-shimmer {
          0%, 100% { background-position: 0% 50%; }
          50%      { background-position: 100% 50%; }
        }

        /* Card hover: subtle lift + amplified glow on the primary card. */
        .welcome-card {
          transition: transform 0.35s cubic-bezier(.2,.7,.2,1),
                      box-shadow 0.35s cubic-bezier(.2,.7,.2,1),
                      border-color 0.25s ease,
                      background-color 0.25s ease;
        }
        .welcome-card:hover {
          transform: translateY(-3px);
        }
        .welcome-card-primary:hover {
          box-shadow: 0 0 56px -14px rgba(52, 211, 153, 0.95);
        }

        @media (prefers-reduced-motion: reduce) {
          .welcome-fade {
            opacity: 1;
            transform: none;
            animation: none;
          }
          .welcome-shimmer {
            animation: none;
            background-position: 25% 50%;
          }
          .welcome-card { transition: none; }
          .welcome-card:hover { transform: none; }
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
  delayClass = "",
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  summary: string;
  action: string;
  primary?: boolean;
  delayClass?: string;
}) {
  return (
    <Link
      href={href}
      className={`welcome-fade welcome-card ${delayClass} ${
        primary ? "welcome-card-primary" : ""
      } group flex min-h-[10.5rem] flex-col justify-between rounded-xl border p-4 backdrop-blur-sm sm:min-h-[12rem] sm:p-5 ${
        primary
          ? "border-emerald-200/[0.35] bg-emerald-300/[0.06] shadow-[0_0_42px_-18px_rgba(52,211,153,0.85)] hover:border-emerald-200/[0.6] hover:bg-emerald-300/[0.1]"
          : "border-white/10 bg-white/[0.045] hover:border-white/[0.22] hover:bg-white/[0.075]"
      }`}
    >
      <div>
        <div
          className={`mb-3 flex h-9 w-9 items-center justify-center rounded-md border ${
            primary
              ? "border-emerald-200/[0.35] bg-emerald-200/[0.14] text-emerald-100"
              : "border-white/[0.12] bg-white/[0.06] text-white/[0.72]"
          }`}
        >
          {icon}
        </div>
        <h3 className="text-[15px] font-black tracking-tight text-white sm:text-base">{label}</h3>
        <p className="mt-2 text-[12.5px] leading-[1.5] text-white/[0.6]">{summary}</p>
      </div>
      <div className="mt-3 inline-flex items-center gap-2 text-[13px] font-bold text-emerald-100 sm:text-sm">
        {action}
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
      </div>
    </Link>
  );
}
